const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../../utils/error.util");
const {
  PRICING_POLICY_PARAMETER,
  normalizePricingPolicyConfig,
} = require("../../utils/remoteConfig.util");

const PARAMETER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,255}$/;
const VALUE_TYPES = new Set(["boolean", "number", "string", "json"]);

async function listRemoteConfigParameters(request) {
  assertAdmin(request.auth);

  try {
    const template = await admin.remoteConfig().getTemplate();
    return {
      success: true,
      etag: template.etag || null,
      lastPublishedAt: readTemplateUpdateTime(template),
      parameters: toParameterRows(template),
    };
  } catch (error) {
    if (error?.code) throw error;
    throwAndLogHttpsError("internal", error.message || "Unable to load Remote Config parameters");
  }
}

async function publishRemoteConfigParameter(request) {
  assertAdmin(request.auth);

  const name = normalizeParameterName(request.data?.name);
  const valueType = normalizeValueType(request.data?.valueType);
  const value = normalizeParameterValue({
    name,
    value: request.data?.value,
    valueType,
  });
  const description =
    typeof request.data?.description === "string"
      ? request.data.description.trim()
      : undefined;

  try {
    const template = await admin.remoteConfig().getTemplate();
    const current = template.parameters[name] || {};
    template.parameters[name] = {
      ...current,
      defaultValue: { value },
      ...(description !== undefined ? { description } : {}),
    };

    const updatedTemplate = await admin.remoteConfig().publishTemplate(template);
    return {
      success: true,
      etag: updatedTemplate.etag || null,
      lastPublishedAt: readTemplateUpdateTime(updatedTemplate),
      parameter: toParameterRow(name, updatedTemplate.parameters[name], updatedTemplate),
    };
  } catch (error) {
    if (error?.code) throw error;
    throwAndLogHttpsError("invalid-argument", error.message || "Unable to publish Remote Config parameter");
  }
}

async function removeRemoteConfigParameter(request) {
  assertAdmin(request.auth);

  const name = normalizeParameterName(request.data?.name);
  if (name === PRICING_POLICY_PARAMETER) {
    throwAndLogHttpsError("failed-precondition", "Pricing policy cannot be removed.");
  }

  try {
    const template = await admin.remoteConfig().getTemplate();
    if (!template.parameters[name]) {
      throwAndLogHttpsError("not-found", "Remote Config parameter was not found.");
    }

    delete template.parameters[name];
    const updatedTemplate = await admin.remoteConfig().publishTemplate(template);
    return {
      success: true,
      etag: updatedTemplate.etag || null,
      lastPublishedAt: readTemplateUpdateTime(updatedTemplate),
      name,
    };
  } catch (error) {
    if (error?.code) throw error;
    throwAndLogHttpsError("internal", error.message || "Unable to remove Remote Config parameter");
  }
}

function assertAdmin(auth) {
  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }
  if (auth.token?.admin !== true) {
    throwAndLogHttpsError("permission-denied", "Only admins can manage Remote Config");
  }
}

function toParameterRows(template) {
  return Object.entries(template.parameters || {})
    .map(([name, parameter]) => toParameterRow(name, parameter, template))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function toParameterRow(name, parameter, template) {
  const value = readDefaultValue(parameter);
  return {
    name,
    value,
    valueType: classifyParameterValue(value),
    description: typeof parameter?.description === "string" ? parameter.description : "",
    hasConditionalValues: Boolean(Object.keys(parameter?.conditionalValues || {}).length),
    lastPublishedAt: readTemplateUpdateTime(template),
  };
}

function readDefaultValue(parameter) {
  const value = parameter?.defaultValue?.value;
  if (value == null) return "";
  return String(value);
}

function classifyParameterValue(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "true" || text === "false") return "boolean";
  if (text !== "" && Number.isFinite(Number(text))) return "number";
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      JSON.parse(text);
      return "json";
    } catch (error) {
      return "string";
    }
  }
  return "string";
}

function normalizeParameterName(name) {
  if (typeof name !== "string" || !name.trim()) {
    throwAndLogHttpsError("invalid-argument", "Remote Config parameter name is required.");
  }
  const normalized = name.trim();
  if (!PARAMETER_NAME_PATTERN.test(normalized)) {
    throwAndLogHttpsError("invalid-argument", "Remote Config parameter name is invalid.");
  }
  return normalized;
}

function normalizeValueType(valueType) {
  if (typeof valueType !== "string" || !VALUE_TYPES.has(valueType)) {
    throwAndLogHttpsError("invalid-argument", "Remote Config value type is invalid.");
  }
  return valueType;
}

function normalizeParameterValue({ name, value, valueType }) {
  if (valueType === "boolean") {
    if (value === true || value === "true") return "true";
    if (value === false || value === "false") return "false";
    throwAndLogHttpsError("invalid-argument", "Boolean Remote Config values must be true or false.");
  }

  if (valueType === "number") {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
      throwAndLogHttpsError("invalid-argument", "Number Remote Config values must be finite.");
    }
    return String(numberValue);
  }

  if (typeof value !== "string") {
    throwAndLogHttpsError("invalid-argument", "Remote Config value must be text.");
  }

  if (valueType === "json" || name === PRICING_POLICY_PARAMETER) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throwAndLogHttpsError("invalid-argument", "JSON Remote Config values must be valid JSON.");
    }

    if (name === PRICING_POLICY_PARAMETER) {
      normalizePricingPolicyConfig(parsed);
    }

    return JSON.stringify(parsed);
  }

  return value;
}

function readTemplateUpdateTime(template) {
  return (
    template?.version?.updateTime ||
    template?.version?.update_time ||
    template?.version?.publishTime ||
    null
  );
}

module.exports = {
  listRemoteConfigParameters,
  publishRemoteConfigParameter,
  removeRemoteConfigParameter,
  _test: {
    classifyParameterValue,
    normalizeParameterValue,
    toParameterRows,
  },
};
