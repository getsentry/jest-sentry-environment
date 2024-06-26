# jest-sentry-environment

Adds Sentry performance monitoring to your jest test suites to find your slowest tests.

![Sentry Example](/docs/example.png)


## Installation

First, you will need to add the `jest-sentry-environment` package to your application, as well as the Sentry SDKs.

```bash
npm install @sentry/node @sentry/tracing @sentry/profiling-node jest-sentry-environment
```

Then, in your jest configuration file, e.g. `jest.config.js` you will need to specify the path to the environment as well as some options. 

```javascript
{
  testEnvironment: '@sentry/jest-environment/jsdom', // or `@sentry/jest-environment/node` for node environment
  testEnvironmentOptions: {
    sentryConfig: {
      // `init` will be passed to `Sentry.init()`
      init: {
        dsn: '<your DSN here>'
        environment: !!process.env.CI ? 'ci' : 'local',
        tracesSampleRate: 1,
        profilesSampleRate: 1
      },

      transactionOptions: {
        // `tags` will be used for the test suite transaction
        tags: {
          branch: process.env.GITHUB_REF,
          commit: process.env.GITHUB_SHA,
        },
      },
    },
  },
}
```

You can either import the jsdom or node environments. You can also customize the base environment by specifying your own `testEnvironment`.

```json
testEnvironment: './path/to/env.js',
```

In `./path/to/env.js`:

```javascript
const {createEnvironment} = require('jest-sentry-environment');

return createEnvironment({
  baseEnvironment: require('jest-environment-node'),
});
```


