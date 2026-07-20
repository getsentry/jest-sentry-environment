let DID_INIT_SENTRY = false;
let Sentry;

const timestampInSeconds = () => (performance.timeOrigin + performance.now()) / 1_000;

function loadSentry() {
  Sentry ??= require('@sentry/node');
  return Sentry;
}

function createEnvironment({baseEnvironment = require('jest-environment-jsdom')} = {}) {
  const {TestEnvironment: BaseEnvironment} = baseEnvironment;

  return class SentryEnvironment extends BaseEnvironment {
    constructor(...args) {
      super(...args);

      const [config, context] = args;

      this.options = config.projectConfig.testEnvironmentOptions.sentryConfig;

      if (
        !this.options ||
        this.options.init?.dsn === false ||
        // Do not include in watch mode... unfortunately, I don't think there's
        // a better watch to detect when jest is in watch mode
        process.argv.includes('--watch') ||
        process.argv.includes('--watchAll')
      ) {
        return;
      }

      const {init = {}} = this.options;

      this.Sentry = loadSentry();
      if (!DID_INIT_SENTRY) {
        this.Sentry.init(init);
        if (this.options.tags) {
          this.Sentry.setTags(this.options.tags);
        }
        DID_INIT_SENTRY = true;
      }

      this.testPath = context.testPath.replace(process.cwd(), '');

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

      if (!this.Sentry) {
        await setupEnvironment();
        return;
      }

      this.transaction = this.Sentry.startInactiveSpan({
        op: 'jest test suite',
        name: this.testPath,
        forceTransaction: true,
      });
      this.global.transaction = this.transaction;
      this.global.Sentry = this.Sentry;

      await this.Sentry.withActiveSpan(this.transaction, () =>
        this.Sentry.startSpan(
          {
            op: 'setup',
            name: this.testPath,
          },
          setupEnvironment
        )
      );
    }

    async teardown() {
      const teardownEnvironment = async () => {
        this.global.jsdom = undefined;
        await super.teardown();
      };

      try {
        if (!this.Sentry) {
          await teardownEnvironment();
          return;
        }

        this.endOpenSpans();
        await this.Sentry.withActiveSpan(this.transaction, () =>
          this.Sentry.startSpan(
            {
              op: 'teardown',
              name: this.testPath,
            },
            teardownEnvironment
          )
        );
      } finally {
        if (this.Sentry) {
          this.transaction.end();
        }
        this.describeSpans = null;
        this.testSpans = null;
        this.testFunctionSpans = null;
        this.hookStarts = null;
        this.openSpans = null;
        this.hub = null;
        this.Sentry = null;
      }
    }

    /**
     * @returns {string}
     */
    getName(parent) {
      // Ignore these for now as it adds a level of nesting and I'm not quite sure where it's even coming from
      if (parent.name === 'ROOT_DESCRIBE_BLOCK') {
        return '';
      }

      const parentName = this.getName(parent.parent);
      return `${parentName ? `${parentName} >` : ''} ${parent.name}`.trim();
    }

    startTrackedSpan(options, parentSpan) {
      let span;
      this.Sentry.withActiveSpan(parentSpan, () => {
        span = this.Sentry.startInactiveSpan(options);
      });
      this.openSpans.add(span);
      return span;
    }

    endTrackedSpan(span, {endTime, error, isOkay} = {}) {
      if (!span || !this.openSpans.has(span)) {
        return;
      }

      try {
        if (error) {
          this.Sentry.withActiveSpan(span, () => {
            this.Sentry.captureException(error);
          });
        }
        if (typeof isOkay === 'boolean') {
          span.setStatus({
            code: isOkay ? 1 : 2,
            message: isOkay ? 'ok' : 'internal_error',
          });
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

    handleTestEvent(event) {
      if (!this.Sentry) {
        return;
      }

      switch (event.name) {
        case 'run_describe_start': {
          const {describeBlock} = event;
          if (describeBlock.name === 'ROOT_DESCRIBE_BLOCK') {
            this.describeSpans.set(describeBlock, this.transaction);
            return;
          }
          const parentSpan = this.describeSpans.get(describeBlock.parent);
          const span = this.startTrackedSpan(
            {name: this.getName(describeBlock), op: 'describe'},
            parentSpan
          );
          this.describeSpans.set(describeBlock, span);
          return;
        }

        case 'run_describe_finish': {
          const {describeBlock} = event;
          const span = this.describeSpans.get(describeBlock);
          this.describeSpans.delete(describeBlock);
          if (span !== this.transaction) {
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
              name: this.getName(test),
              op: 'jest test',
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
            {name: this.getName(test), op: 'test-fn'},
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
          const startTime = timestampInSeconds();
          const starts = this.hookStarts.get(hook);
          if (starts === undefined) {
            this.hookStarts.set(hook, startTime);
          } else if (Array.isArray(starts)) {
            starts.push(startTime);
          } else {
            this.hookStarts.set(hook, [starts, startTime]);
          }
          return;
        }

        case 'hook_success':
        case 'hook_failure': {
          const {hook} = event;
          const starts = this.hookStarts.get(hook);
          const startTime = Array.isArray(starts) ? starts.shift() : starts;
          if (!Array.isArray(starts) || starts.length === 0) {
            this.hookStarts.delete(hook);
          }
          const parentSpan = event.test
            ? this.testSpans.get(event.test)
            : this.describeSpans.get(hook.parent);
          const parentName = this.getName(hook.parent);
          const span = this.startTrackedSpan(
            {
              name: parentName ? `${parentName} > ${hook.type}` : hook.type,
              op: hook.type,
              startTime,
            },
            parentSpan
          );
          this.endTrackedSpan(span, {
            endTime: timestampInSeconds(),
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
          this.endTrackedSpan(testSpan, {isOkay: test.errors.length === 0});
          return;
        }

        default:
          return;
      }
    }
  };
}

module.exports = createEnvironment;
