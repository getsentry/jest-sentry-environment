let sentryModule;

const SPAN_STATUS_OK = {code: 1, message: 'ok'};
const SPAN_STATUS_ERROR = {code: 2, message: 'internal_error'};
const ROOT_DESCRIBE_BLOCK = 'ROOT_DESCRIBE_BLOCK';
const DEFAULT_MIN_HOOK_DURATION_MS = 5;

const timestampInSeconds = () => (performance.timeOrigin + performance.now()) / 1_000;

function loadSentry() {
  sentryModule ??= require('@sentry/node');
  return sentryModule;
}

function isWatchMode() {
  return process.argv.includes('--watch') || process.argv.includes('--watchAll');
}

function getFullName(entry) {
  const names = [];
  for (
    let current = entry;
    current && current.name !== ROOT_DESCRIBE_BLOCK;
    current = current.parent
  ) {
    names.push(current.name);
  }
  return names.reverse().join(' > ');
}

function getTimeoutAttribute(timeout) {
  return timeout == null ? {} : {'test.timeout_ms': timeout};
}

function createEnvironment({baseEnvironment = require('jest-environment-jsdom')} = {}) {
  const {TestEnvironment: BaseEnvironment} = baseEnvironment;

  return class SentryEnvironment extends BaseEnvironment {
    constructor(...args) {
      super(...args);

      const [config, context] = args;

      const options = config.projectConfig.testEnvironmentOptions.sentryConfig;

      if (
        !options ||
        options.init?.dsn === false ||
        // Jest does not expose watch mode to test environments directly.
        isWatchMode()
      ) {
        return;
      }

      const {init = {}, minHookDurationMs = DEFAULT_MIN_HOOK_DURATION_MS, tags} = options;

      this.sentry = loadSentry();
      if (!this.sentry.isInitialized()) {
        this.sentry.init(init);
        if (tags) {
          this.sentry.setTags(tags);
        }
      }

      const {relative, sep} = require('node:path');
      this.testPath = relative(process.cwd(), context.testPath).replaceAll(sep, '/');
      this.minHookDurationSeconds = minHookDurationMs / 1_000;
      this.baseAttributes = {
        'test.file': this.testPath,
        'test.framework': 'jest',
        ...(process.env.JEST_WORKER_ID
          ? {'test.worker_id': process.env.JEST_WORKER_ID}
          : {}),
      };

      this.describeSpans = new Map();
      this.testSpans = new Map();
      this.testFunctionSpans = new Map();
      this.hookStarts = new Map();
      this.openSpans = new Set();
    }

    async setup() {
      const setupEnvironment = async () => {
        await super.setup();

        if (this.dom && !this.global.jsdom) {
          this.global.jsdom = this.dom;
        }
      };

      if (!this.sentry) {
        await setupEnvironment();
        return;
      }

      this.suiteSpan = this.sentry.startNewTrace(() =>
        this.sentry.startInactiveSpan({
          op: 'jest test suite',
          name: this.testPath,
          forceTransaction: true,
          attributes: this.baseAttributes,
        })
      );
      this.global.transaction = this.suiteSpan;
      this.global.Sentry = this.sentry;

      await this.runEnvironmentSpan('setup', setupEnvironment);
    }

    async teardown() {
      const teardownEnvironment = async () => {
        this.global.jsdom = undefined;
        this.global.Sentry = undefined;
        this.global.transaction = undefined;
        await super.teardown();
      };

      try {
        if (!this.sentry) {
          await teardownEnvironment();
          return;
        }

        this.endOpenSpans();
        await this.runEnvironmentSpan('teardown', teardownEnvironment);
      } finally {
        this.suiteSpan?.end();
        this.describeSpans = null;
        this.testSpans = null;
        this.testFunctionSpans = null;
        this.hookStarts = null;
        this.openSpans = null;
        this.baseAttributes = null;
        this.minHookDurationSeconds = null;
        this.testPath = null;
        this.suiteSpan = null;
        this.sentry = null;
      }
    }

    runEnvironmentSpan(op, callback) {
      return this.sentry.startSpan(
        {name: this.testPath, op, parentSpan: this.suiteSpan},
        callback
      );
    }

    startTrackedSpan(options, parentSpan) {
      const span = this.sentry.startInactiveSpan({
        ...options,
        parentSpan,
      });
      this.openSpans.add(span);
      return span;
    }

    endTrackedSpan(span, {attributes, endTime, error, isOkay} = {}) {
      if (!span || !this.openSpans.has(span)) {
        return;
      }

      try {
        if (attributes) {
          span.setAttributes(attributes);
        }
        if (error) {
          this.sentry.withActiveSpan(span, () => {
            this.sentry.captureException(error);
          });
        }
        if (typeof isOkay === 'boolean') {
          span.setStatus(isOkay ? SPAN_STATUS_OK : SPAN_STATUS_ERROR);
        }
      } finally {
        span.end(endTime);
        this.openSpans.delete(span);
      }
    }

    endOpenSpans() {
      for (const span of [...this.openSpans].reverse()) {
        this.endTrackedSpan(span);
      }
    }

    handleTestEvent(event, state) {
      if (!this.sentry) {
        return;
      }

      switch (event.name) {
        case 'run_describe_start': {
          const {describeBlock} = event;
          if (describeBlock.name === ROOT_DESCRIBE_BLOCK) {
            this.describeSpans.set(describeBlock, this.suiteSpan);
            return;
          }
          const parentSpan = this.describeSpans.get(describeBlock.parent);
          const span = this.startTrackedSpan(
            {name: getFullName(describeBlock), op: 'describe'},
            parentSpan
          );
          this.describeSpans.set(describeBlock, span);
          return;
        }

        case 'run_describe_finish': {
          const {describeBlock} = event;
          const span = this.describeSpans.get(describeBlock);
          this.describeSpans.delete(describeBlock);
          if (span !== this.suiteSpan) {
            this.endTrackedSpan(span);
          }
          return;
        }

        case 'test_started': {
          const {test} = event;
          const parentSpan = this.describeSpans.get(test.parent);
          const span = this.startTrackedSpan(
            {
              forceTransaction: true,
              name: getFullName(test),
              op: 'jest test',
              attributes: {
                ...this.baseAttributes,
                'test.concurrent': Boolean(test.concurrent),
                'test.expected_failure': Boolean(test.failing),
                'test.invocation': test.invocations ?? 1,
                ...(test.mode ? {'test.mode': test.mode} : {}),
                ...getTimeoutAttribute(test.timeout ?? state?.testTimeout),
              },
            },
            parentSpan
          );
          this.testSpans.set(test, span);
          return;
        }

        case 'test_fn_start': {
          const {test} = event;
          if (test.errors.length > 0) {
            return;
          }
          const span = this.startTrackedSpan(
            {name: getFullName(test), op: 'test-fn'},
            this.testSpans.get(test)
          );
          this.testFunctionSpans.set(test, span);
          return;
        }

        case 'test_fn_success':
        case 'test_fn_failure': {
          const {test} = event;
          const span = this.testFunctionSpans.get(test);
          this.testFunctionSpans.delete(test);
          this.endTrackedSpan(span, {
            error: event.name === 'test_fn_failure' ? event.error : undefined,
            isOkay: event.name === 'test_fn_success',
          });
          return;
        }

        case 'hook_start': {
          const {hook} = event;
          const hookStart = {
            startTime: timestampInSeconds(),
            timeout: hook.timeout ?? state?.testTimeout,
          };
          this.hookStarts.set(hook, hookStart);
          return;
        }

        case 'hook_success':
        case 'hook_failure': {
          const {hook} = event;
          const hookStart = this.hookStarts.get(hook);
          this.hookStarts.delete(hook);
          const endTime = timestampInSeconds();
          if (
            event.name === 'hook_success' &&
            hookStart &&
            endTime - hookStart.startTime < this.minHookDurationSeconds
          ) {
            return;
          }
          const parentSpan = event.test
            ? this.testSpans.get(event.test)
            : this.describeSpans.get(hook.parent);
          const parentName = getFullName(hook.parent);
          const span = this.startTrackedSpan(
            {
              name: parentName ? `${parentName} > ${hook.type}` : hook.type,
              op: hook.type,
              startTime: hookStart?.startTime,
              attributes: {
                'test.hook.type': hook.type,
                ...getTimeoutAttribute(hookStart?.timeout),
              },
            },
            parentSpan
          );
          this.endTrackedSpan(span, {
            endTime,
            error: event.name === 'hook_failure' ? event.error : undefined,
            isOkay: event.name === 'hook_success',
          });
          return;
        }

        case 'test_done': {
          const {test} = event;
          const functionSpan = this.testFunctionSpans.get(test);
          this.testFunctionSpans.delete(test);
          this.endTrackedSpan(functionSpan, {isOkay: false});

          const testSpan = this.testSpans.get(test);
          this.testSpans.delete(test);
          const isOkay = test.errors.length === 0;
          this.endTrackedSpan(testSpan, {
            attributes: {
              'test.assertion_count': test.numPassingAsserts ?? 0,
              'test.status': isOkay ? 'passed' : 'failed',
            },
            isOkay,
          });
          return;
        }

        default:
          return;
      }
    }
  };
}

module.exports = createEnvironment;
