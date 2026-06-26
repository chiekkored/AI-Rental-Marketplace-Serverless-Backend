const deactivation = require("./deactivation");
const deletion = require("./deletion");
const disable = require("./disable");

module.exports = {
  ...deactivation,
  ...deletion,
  disableUser: disable.disableUser,
};
