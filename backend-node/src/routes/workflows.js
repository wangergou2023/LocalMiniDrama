const { listWorkflows } = require('../services/workflowEngine');
const response = require('../response');

function list(req, res) {
  try {
    const type = req.query.type || '';
    const workflows = listWorkflows(type);
    response.success(res, workflows);
  } catch (e) {
    response.serverError(res, e.message);
  }
}

module.exports = { list };
