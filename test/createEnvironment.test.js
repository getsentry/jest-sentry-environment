const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

class FakeEnvironment {
  constructor() {
    this.dom = {name: 'jsdom'};
    this.global = {};
  }

  async setup() {
    this.didSetup = true;
  }

  async teardown() {
    this.didTeardown = true;
  }
}

function makeConfig(sentryConfig) {
  return {
    projectConfig: {
      testEnvironmentOptions: sentryConfig ? {sentryConfig} : {},
    },
  };
}

function makeTest(name, parent, overrides = {}) {
  return {
    concurrent: false,
    errors: [],
    failing: false,
    invocations: 1,
    name,
    numPassingAsserts: 0,
    parent,
    ...overrides,
  };
}

function makeSentry() {
  const calls = {captured: [], init: [], newTraces: 0, spans: [], tags: []};
  let activeSpan;
  let initialized = false;
  const Sentry = {
    init(options) {
      initialized = true;
      calls.init.push(options);
    },
    isInitialized() {
      return initialized;
    },
    setTags(tags) {
      calls.tags.push(tags);
    },
    startInactiveSpan(options) {
      const span = {
        attributes: {...options.attributes},
        endCalls: 0,
        options,
        parent: options.parentSpan ?? activeSpan,
        statuses: [],
        end() {
          this.endCalls += 1;
        },
        setStatus(status) {
          this.statuses.push(status);
        },
        setAttributes(attributes) {
          Object.assign(this.attributes, attributes);
        },
      };
      calls.spans.push(span);
      return span;
    },
    startSpan(_options, callback) {
      return callback();
    },
    startNewTrace(callback) {
      calls.newTraces += 1;
      return callback();
    },
    withActiveSpan(span, callback) {
      const previousSpan = activeSpan;
      activeSpan = span;
      try {
        return callback();
      } finally {
        activeSpan = previousSpan;
      }
    },
    captureException(error) {
      calls.captured.push({error, span: activeSpan});
    },
  };
  return {calls, Sentry};
}

async function withMockedSentry(Sentry, callback) {
  const originalLoad = Module._load;
  const modulePath = require.resolve('../createEnvironment');
  let loadCount = 0;

  Module._load = function (request, parent, isMain) {
    if (request === '@sentry/node') {
      loadCount += 1;
      return Sentry;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[modulePath];
  try {
    await callback(require(modulePath), () => loadCount);
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
}

function makeEnvironment(
  createEnvironment,
  sentryConfig,
  BaseEnvironment = FakeEnvironment
) {
  const Environment = createEnvironment({
    baseEnvironment: {TestEnvironment: BaseEnvironment},
  });
  return new Environment(makeConfig(sentryConfig), {
    testPath: `${process.cwd()}/example.test.js`,
  });
}

test('does not load Sentry when instrumentation is disabled', async () => {
  await withMockedSentry({}, async (createEnvironment, getLoadCount) => {
    const environment = makeEnvironment(createEnvironment, {init: {dsn: false}});
    await environment.setup();
    await environment.teardown();

    assert.equal(getLoadCount(), 0);
    assert.equal(environment.didSetup, true);
    assert.equal(environment.didTeardown, true);
    assert.equal(environment.global.jsdom, undefined);
  });
});

test('initializes Sentry without mutating its options', async () => {
  const {calls, Sentry} = makeSentry();
  await withMockedSentry(Sentry, async (createEnvironment, getLoadCount) => {
    const init = {
      dsn: 'https://public@example.com/1',
      integrations: ['custom-integration'],
      tracesSampleRate: 1,
    };
    const environment = makeEnvironment(createEnvironment, {
      init,
      tags: {branch: 'example'},
    });
    await environment.setup();
    assert.deepEqual(calls.spans[0].attributes, {
      'test.file': 'example.test.js',
      'test.framework': 'jest',
    });

    assert.equal(getLoadCount(), 1);
    assert.deepEqual(calls.init, [init]);
    assert.deepEqual(calls.tags, [{branch: 'example'}]);
    assert.equal(calls.newTraces, 1);
    assert.equal(environment.global.jsdom, environment.dom);

    await environment.teardown();
    assert.equal(calls.spans[0].endCalls, 1);
    assert.equal(environment.global.Sentry, undefined);
    assert.equal(environment.global.transaction, undefined);
  });
});

test('exports the default Jest environments', () => {
  assert.equal(require('..').createEnvironment, require('../createEnvironment'));
  assert.equal(typeof require('../jsdom'), 'function');
  assert.equal(typeof require('../node'), 'function');
});

test('records the Jest lifecycle without duplicate or leaked spans', async () => {
  const {calls, Sentry} = makeSentry();
  await withMockedSentry(Sentry, async createEnvironment => {
    const environment = makeEnvironment(createEnvironment, {
      init: {dsn: 'https://public@example.com/1'},
    });
    await environment.setup();

    const root = {name: 'ROOT_DESCRIBE_BLOCK'};
    const describeBlock = {name: 'suite', parent: root};
    const testEntry = makeTest('works', describeBlock);
    const send = (event, state) => environment.handleTestEvent(event, state);

    send({describeBlock: root, name: 'run_describe_start'});
    send({describeBlock, name: 'run_describe_start'});
    const describeSpan = calls.spans.at(-1);
    assert.equal(describeSpan.parent, calls.spans[0]);

    send({name: 'test_start', test: testEntry});
    assert.equal(calls.spans.length, 2);
    send({name: 'test_started', test: testEntry}, {testTimeout: 5000});
    const testSpan = calls.spans.at(-1);
    assert.equal(testSpan.options.op, 'jest test');
    assert.equal(testSpan.parent, describeSpan);
    assert.deepEqual(testSpan.attributes, {
      'test.concurrent': false,
      'test.expected_failure': false,
      'test.file': 'example.test.js',
      'test.framework': 'jest',
      'test.invocation': 1,
      'test.timeout_ms': 5000,
    });

    const hook = {parent: describeBlock, type: 'beforeEach'};
    send({hook, name: 'hook_start'}, {testTimeout: 5000});
    assert.equal(calls.spans.at(-1), testSpan);
    environment.hookStarts.get(hook).startTime -= 0.01;
    send({hook, name: 'hook_success', test: testEntry});
    const hookSpan = calls.spans.at(-1);
    assert.equal(hookSpan.parent, testSpan);
    assert.equal(hookSpan.endCalls, 1);
    assert.deepEqual(hookSpan.attributes, {
      'test.hook.type': 'beforeEach',
      'test.timeout_ms': 5000,
    });

    const spanCountBeforeFastHook = calls.spans.length;
    send({hook, name: 'hook_start'});
    send({hook, name: 'hook_success', test: testEntry});
    assert.equal(calls.spans.length, spanCountBeforeFastHook);

    send({name: 'test_fn_start', test: testEntry});
    const functionSpan = calls.spans.at(-1);
    const error = new Error('failed');
    testEntry.errors.push(error);
    send({error, name: 'test_fn_failure', test: testEntry});
    send({name: 'test_done', test: testEntry});
    assert.equal(functionSpan.parent, testSpan);
    assert.deepEqual(calls.captured, [{error, span: functionSpan}]);
    assert.equal(testSpan.endCalls, 1);
    assert.equal(testSpan.attributes['test.assertion_count'], 0);
    assert.equal(testSpan.attributes['test.status'], 'failed');

    const skipped = makeTest('skipped', describeBlock);
    const spanCount = calls.spans.length;
    send({name: 'test_start', test: skipped});
    send({name: 'test_skip', test: skipped});
    assert.equal(calls.spans.length, spanCount);

    const hookError = new Error('beforeEach failed');
    const failed = makeTest('hook failure', describeBlock, {errors: [hookError]});
    send({name: 'test_started', test: failed});
    const failedTestSpan = calls.spans.at(-1);
    send({hook, name: 'hook_start'});
    send({error: hookError, hook, name: 'hook_failure', test: failed});
    const failedHookSpan = calls.spans.at(-1);
    const failedSpanCount = calls.spans.length;
    send({name: 'test_fn_start', test: failed});
    send({name: 'test_done', test: failed});
    assert.equal(calls.spans.length, failedSpanCount);
    assert.deepEqual(calls.captured.at(-1), {error: hookError, span: failedHookSpan});
    assert.equal(failedTestSpan.endCalls, 1);

    const duplicateA = makeTest('duplicate', describeBlock);
    const duplicateB = makeTest('duplicate', describeBlock);
    send({name: 'test_started', test: duplicateA});
    send({name: 'test_started', test: duplicateB});
    const [spanA, spanB] = calls.spans.slice(-2);
    send({name: 'test_done', test: duplicateA});
    assert.equal(spanA.endCalls, 1);
    assert.equal(spanB.endCalls, 0);
    send({name: 'test_done', test: duplicateB});

    send({describeBlock, name: 'run_describe_finish'});
    send({describeBlock: root, name: 'run_describe_finish'});
    assert.equal(environment.openSpans.size, 0);
    assert.equal(environment.testSpans.size, 0);
    assert.equal(environment.hookStarts.size, 0);
    await environment.teardown();
  });
});

test('cleans up unfinished spans when teardown fails', async () => {
  const {calls, Sentry} = makeSentry();
  class ThrowingEnvironment extends FakeEnvironment {
    async teardown() {
      throw new Error('teardown failed');
    }
  }

  await withMockedSentry(Sentry, async createEnvironment => {
    const environment = makeEnvironment(
      createEnvironment,
      {init: {dsn: 'https://public@example.com/1'}},
      ThrowingEnvironment
    );
    await environment.setup();

    const root = {name: 'ROOT_DESCRIBE_BLOCK'};
    const describeBlock = {name: 'suite', parent: root};
    const testEntry = makeTest('unfinished', describeBlock);
    environment.handleTestEvent({describeBlock: root, name: 'run_describe_start'});
    environment.handleTestEvent({describeBlock, name: 'run_describe_start'});
    environment.handleTestEvent({name: 'test_started', test: testEntry});
    environment.handleTestEvent({name: 'test_fn_start', test: testEntry});

    await assert.rejects(environment.teardown(), /teardown failed/);
    assert.deepEqual(
      calls.spans.map(span => [span.options.op, span.endCalls]),
      [
        ['jest test suite', 1],
        ['describe', 1],
        ['jest test', 1],
        ['test-fn', 1],
      ]
    );
    assert.equal(environment.testSpans, null);
    assert.equal(environment.openSpans, null);
    assert.equal(environment.sentry, null);
  });
});

test('does not retain state for large sequential suites', async () => {
  const testCount = 25_000;
  let createdSpans = 0;
  let endedSpans = 0;
  const Sentry = {
    init() {},
    isInitialized() {
      return false;
    },
    setTags() {},
    startInactiveSpan() {
      createdSpans += 1;
      return {
        end() {
          endedSpans += 1;
        },
        setStatus() {},
        setAttributes() {},
      };
    },
    startSpan(_options, callback) {
      return callback();
    },
    startNewTrace(callback) {
      return callback();
    },
    withActiveSpan(_span, callback) {
      return callback();
    },
  };

  await withMockedSentry(Sentry, async createEnvironment => {
    const environment = makeEnvironment(createEnvironment, {
      init: {dsn: 'https://public@example.com/1'},
      minHookDurationMs: Number.MAX_SAFE_INTEGER,
    });
    await environment.setup();
    const root = {name: 'ROOT_DESCRIBE_BLOCK'};
    const describeBlock = {name: 'large suite', parent: root};
    const beforeEachHook = {parent: describeBlock, type: 'beforeEach'};
    const afterEachHook = {parent: describeBlock, type: 'afterEach'};
    const send = event => environment.handleTestEvent(event);
    send({describeBlock: root, name: 'run_describe_start'});
    send({describeBlock, name: 'run_describe_start'});

    for (let i = 0; i < testCount; i += 1) {
      const testEntry = makeTest(`test ${i}`, describeBlock);
      send({name: 'test_started', test: testEntry});
      send({hook: beforeEachHook, name: 'hook_start'});
      send({hook: beforeEachHook, name: 'hook_success', test: testEntry});
      send({name: 'test_fn_start', test: testEntry});
      send({name: 'test_fn_success', test: testEntry});
      send({hook: afterEachHook, name: 'hook_start'});
      send({hook: afterEachHook, name: 'hook_success', test: testEntry});
      send({name: 'test_done', test: testEntry});
    }

    assert.equal(environment.testSpans.size, 0);
    assert.equal(environment.testFunctionSpans.size, 0);
    assert.equal(environment.hookStarts.size, 0);
    assert.equal(createdSpans, 2 + testCount * 2);
    assert.equal(endedSpans, testCount * 2);
    send({describeBlock, name: 'run_describe_finish'});
    send({describeBlock: root, name: 'run_describe_finish'});
    await environment.teardown();
    assert.equal(endedSpans, 2 + testCount * 2);
  });
});
