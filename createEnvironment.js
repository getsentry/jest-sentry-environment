const Sentry = require('@sentry/node');
const {nodeProfilingIntegration} = require('@sentry/profiling-node');

let DID_INIT_SENTRY = false;

function createEnvironment({baseEnvironment} = {}) {
  const BaseEnvironment =
    baseEnvironment?.TestEnvironment || require('jest-environment-jsdom').TestEnvironment;

  return class SentryEnvironment extends BaseEnvironment {
    /**
     * @type {Sentry.Span[]}
     */
    getVmContextSpanStack = [];

    constructor(...args) {
      super(...args);

      const [config, context] = args;

      this.options = config.projectConfig.testEnvironmentOptions?.sentryConfig;

      if (
        !this.options ||
        // Do not include in watch mode... unfortunately, I don't think there's
        // a better watch to detect when jest is in watch mode
        process.argv.includes('--watch') ||
        process.argv.includes('--watchAll')
      ) {
        return;
      }

      const {init} = this.options;

      this.Sentry = Sentry;
      if (!DID_INIT_SENTRY) {
        // Ensure integration is an array as init is a user input
        if (!Array.isArray(init.integrations)) {
          init.integrations = [];
        }

        if (Sentry.autoDiscoverNodePerformanceMonitoringIntegrations) {
          integrations.push(
            ...Sentry.autoDiscoverNodePerformanceMonitoringIntegrations()
          );
        }

        // Add profiling integration
        init.integrations.push(nodeProfilingIntegration());

        this.Sentry.init(init);
        this.Sentry.setTags(this.options.tags || this.options.transactionOptions?.tags);
        DID_INIT_SENTRY = true;
      }

      this.testPath = context.testPath.replace(process.cwd(), '');

      this.runDescribe = new Map();
      this.testContainers = new Map();
      this.tests = new Map();
      this.hooks = new Map();
    }

    async setup() {
      if (!this.Sentry || !this.options) {
        await super.setup();
        return;
      }

      // Make jsdom available to the test environment
      if (!this.global.jsdom) {
        this.global.jsdom = this.dom;
      }

      this.transaction = this.Sentry.startInactiveSpan({
        op: 'jest test suite',
        name: this.testPath,
        forceTransaction: true,
      });
      this.global.transaction = this.transaction;
      this.global.Sentry = this.Sentry;

      this.Sentry.withActiveSpan(this.transaction, () => {
        this.Sentry.startSpan(
          {
            op: 'setup',
            name: this.testPath,
          },
          async () => {
            await super.setup();
          }
        );
      });
    }

    async teardown() {
      if (this.global.jsdom) {
        this.global.jsdom = undefined;
      }

      if (!this.Sentry || !this.transaction) {
        await super.teardown();
        return;
      }

      this.Sentry.withActiveSpan(this.transaction, () => {
        this.Sentry.startSpan(
          {
            op: 'teardown',
            name: this.testPath,
          },
          async () => {
            await super.teardown();
            if (this.transaction) {
              this.transaction.end();
            }
            this.runDescribe = null;
            this.testContainers = null;
            this.tests = null;
            this.hooks = null;
            this.hub = null;
            this.Sentry = null;
          }
        );
      });
    }

    getVmContext() {
      if (this.transaction) {
        this.Sentry.withActiveSpan(this.transaction, () => {
          const getVmContextSpan = this.Sentry.startInactiveSpan({
            op: 'getVmContext',
          });
          this.getVmContextSpanStack.push(getVmContextSpan);
        });
      }
      return super.getVmContext();
    }

    /**
     * @returns {string}
     */
    getName(parent) {
      if (!parent) {
        return '';
      }

      // Ignore these for now as it adds a level of nesting and I'm not quite sure where it's even coming from
      if (parent.name === 'ROOT_DESCRIBE_BLOCK') {
        return '';
      }

      const parentName = this.getName(parent.parent);
      return `${parentName ? `${parentName} >` : ''} ${parent.name}`.trim();
    }

    getData({name, ...event}) {
      switch (name) {
        case 'run_describe_start':
        case 'run_describe_finish':
          if (name === 'run_describe_finish') {
            const span = this.getVmContextSpanStack.pop();
            if (span) {
              span.end();
            }
          }

          return {
            op: 'describe',
            obj: event.describeBlock,
            parentObj: event.describeBlock.parent,
            dataStore: this.runDescribe,
            parentStore: this.runDescribe,
          };

        case 'test_started':
        case 'test_start':
        case 'test_done':
          return {
            op: 'test',
            obj: event.test,
            parentObj: event.test.parent,
            dataStore: this.testContainers,
            parentStore: this.runDescribe,
            /**
             * @param {Sentry.Span} span
             * @returns {Sentry.Span}
             */
            beforeFinish: span => {
              const isOkay = !event.test.errors.length;
              span.setStatus({code: isOkay ? 1 : 2, message: isOkay ? 'ok' : 'internal_error'});
              return span;
            },
          };

        case 'test_fn_start':
        case 'test_fn_success':
        case 'test_fn_failure':
          return {
            op: 'test-fn',
            obj: event.test,
            parentObj: event.test,
            dataStore: this.tests,
            parentStore: this.testContainers,
            /**
             * @param {Sentry.Span} span
             * @returns {Sentry.Span}
             */
            beforeFinish: span => {
              const isOkay = !event.test.errors.length;
              span.setStatus({code: isOkay ? 1 : 2, message: isOkay ? 'ok' : 'internal_error'});
              return span;
            },
          };

        case 'hook_start':
          return {
            obj: event.hook.parent,
            op: event.hook.type,
            dataStore: this.hooks,
          };

        case 'hook_success':
        case 'hook_failure':
          return {
            obj: event.hook.parent,
            parentObj: event.test?.parent,
            dataStore: this.hooks,
            parentStore: this.testContainers,
          };

        case 'start_describe_definition':
        case 'finish_describe_definition':
        case 'add_test':
        case 'add_hook':
        case 'run_start':
        case 'run_finish':
        case 'test_todo':
        case 'setup':
        case 'teardown':
          return null;

        default:
          return null;
      }
    }

    handleTestEvent(event) {
      if (!this.Sentry) {
        return;
      }

      const data = this.getData(event);
      const {name} = event;

      if (!data) {
        return;
      }

      const {obj, parentObj, dataStore, parentStore, op, description, beforeFinish} =
        data;

      const testName = this.getName(obj);

      if (name.includes('start')) {
        // Make this an option maybe
        if (!testName) {
          return;
        }

        /**
         * @type {Sentry.Span[]}
         */
        const spans = [];
        const parentName = parentObj && this.getName(parentObj);
        /**
         * @type {Parameters<Sentry.startSpan>[0]}
         */
        const spanProps = {op, name: description || testName};
        if (parentObj && parentStore.has(parentName)) {
          if (Array.isArray(parentStore.get(parentName))) {
            parentStore.get(parentName).forEach(s => {
              this.Sentry.withActiveSpan(s, () => {
                spans.push(this.Sentry.startInactiveSpan(spanProps));
              });
            });
          } else {
            const parentSpan = parentStore.get(parentName);
            this.Sentry.withActiveSpan(parentSpan, () => {
              spans.push(this.Sentry.startInactiveSpan(spanProps));
            });
          }
        } else {
          // By not doing starting a span here we're ignoring beforeEach afterEach spans
          // Not currently sure how to attach to them to their test spans
          // They end up dangling on the parent and making a mess
          // this.Sentry.withActiveSpan(this.transaction, () => {
          //   spans.push(this.Sentry.startInactiveSpan(spanProps));
          // });
        }

        // If we are starting a test, let's also make it a transaction so we can see our slowest tests
        if (spanProps.op === 'test') {
          this.Sentry.withActiveSpan(this.transaction, () => {
            const testTransaction = this.Sentry.startInactiveSpan({
              ...spanProps,
              op: 'jest test',
              forceTransaction: true,
            });
            spans.push(testTransaction);
          });
        }

        dataStore.set(testName, spans);

        return;
      }

      if (dataStore.has(testName)) {
        /**
         * @type {Sentry.Span[]}
         */
        const spans = dataStore.get(testName);

        if (name.includes('failure') && event.error) {
          this.Sentry.withActiveSpan(spans[0], () => {
            this.Sentry.captureException(event.error);
          });
        }

        spans.forEach(span => {
          if (beforeFinish) {
            span = beforeFinish(span);
            if (!span) {
              throw new Error('`beforeFinish()` needs to return a span');
            }
          }

          span.end();
        });
      }
    }
  };
}

module.exports = createEnvironment;
