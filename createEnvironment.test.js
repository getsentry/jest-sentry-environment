const createEnvironment = require("./createEnvironment");

describe("createEnvironment", () => {
  it("creates an environemnt", () => {
    const config = {
      projectConfig: { testEnvironmentOptions: { sentryConfig: {} } },
    };

    const EnvironmentConstructor = createEnvironment();

    expect(() => new EnvironmentConstructor(config)).not.toThrow();
  });
});
