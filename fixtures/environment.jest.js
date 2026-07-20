describe('instrumented suite', () => {
  beforeEach(() => {});
  afterEach(() => {});

  test('provides the instrumented jsdom environment', () => {
    expect(global.jsdom).toBeDefined();
    expect(global.Sentry).toBeDefined();
    expect(global.transaction).toBeDefined();
  });
});
