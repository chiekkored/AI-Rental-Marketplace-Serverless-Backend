const { deactivateAccount } = require("../accountDeactivation.js");

exports.disableUser = async (request) => {
  const feedback =
    request.data?.feedback?.action === "disable"
      ? { ...request.data.feedback, action: "deactivate" }
      : request.data?.feedback;

  return deactivateAccount({
    ...request,
    data: {
      ...(request.data || {}),
      feedback,
    },
  });
};
