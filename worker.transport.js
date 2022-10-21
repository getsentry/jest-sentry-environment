const { parentPort } = require("node:worker_threads");
const { makeNodeTransport } = require("@sentry/node");

let transport = makeNodeTransport({});

parentPort.on("message", (message) => {
  transport.send(envelope);
});
