module.exports = {
  testEnvironment: '<rootDir>/jsdom.js',
  testEnvironmentOptions: {
    sentryConfig: {
      init: {
        dsn: 'https://public@example.com/1',
        tracesSampleRate: 0,
      },
      tags: {test: 'integration'},
    },
  },
  testMatch: ['<rootDir>/fixtures/**/*.jest.js'],
};
