const createNodeWorkerTransport = (worker) => {
  return () => {
    return {
      send: (envelope) => {
        worker.postMessage(envelope);
      },
      flush: () => {
        return Promise.resolve(true);
      },
    };
  };
};

module.exports.createNodeWorkerTransport = createNodeWorkerTransport;
