# Jest Sentry Environment

Adds Sentry performance monitoring to your Jest test suites to find your slowest tests.

![Sentry Example](/docs/example.png)

## Installation

This package requires Node.js 24 or newer, Jest 30 or newer, and `@sentry/node` 8 or
newer.

Install the environment, the Sentry Node SDK, and the Jest environment you use. For
jsdom:

```bash
npm install --save-dev @sentry/jest-environment @sentry/node jest jest-environment-jsdom
```

For the Node environment, install `jest-environment-node` instead of
`jest-environment-jsdom`.

Then configure the environment and Sentry options in `jest.config.js`:

```javascript
module.exports = {
  // Use '@sentry/jest-environment/node' for the Node environment.
  testEnvironment: '@sentry/jest-environment/jsdom',
  testEnvironmentOptions: {
    sentryConfig: {
      // `init` will be passed to `Sentry.init()`
      init: {
        dsn: '<your DSN here>',
        environment: !!process.env.CI ? 'ci' : 'local',
        tracesSampleRate: 1,
      },

      tags: {
        branch: process.env.GITHUB_REF,
        commit: process.env.GITHUB_SHA,
      },
    },
  },
};
```

Set `init.dsn` to `false` to disable instrumentation without loading the Sentry SDK,
for example `dsn: process.env.SENTRY_DSN || false`.

Each test suite is recorded as a transaction. Executed tests are also recorded as
individually searchable transactions, with their hooks and test functions organized as
child spans. CPU profiling is not included.

You can either import the jsdom or node environments. You can also customize the base environment by specifying your own `testEnvironment`.

```javascript
module.exports = {
  testEnvironment: './path/to/env.js',
};
```

In `./path/to/env.js`:

```javascript
const {createEnvironment} = require('@sentry/jest-environment');

module.exports = createEnvironment({
  baseEnvironment: require('jest-environment-node'),
});
```
