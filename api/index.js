const { createRequestHandler } = require("../server");

const handler = createRequestHandler();

module.exports = async (req, res) => {
  return handler(req, res);
};
