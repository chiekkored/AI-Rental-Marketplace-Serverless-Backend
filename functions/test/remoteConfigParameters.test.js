const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_PRICING_POLICY,
} = require("../utils/remoteConfig.util")._test;
const {
  classifyParameterValue,
  normalizeParameterValue,
  toParameterRows,
} = require("../calls/remote-config/remoteConfigParameters")._test;

test("classifies Remote Config default values", () => {
  assert.equal(classifyParameterValue("true"), "boolean");
  assert.equal(classifyParameterValue("false"), "boolean");
  assert.equal(classifyParameterValue("42"), "number");
  assert.equal(classifyParameterValue("3.14"), "number");
  assert.equal(classifyParameterValue('{"enabled":true}'), "json");
  assert.equal(classifyParameterValue("[1,2,3]"), "json");
  assert.equal(classifyParameterValue("{invalid"), "string");
  assert.equal(classifyParameterValue("hello"), "string");
});

test("normalizes primitive Remote Config values for publishing", () => {
  assert.equal(
    normalizeParameterValue({ name: "sample_bool", value: true, valueType: "boolean" }),
    "true",
  );
  assert.equal(
    normalizeParameterValue({ name: "sample_bool", value: "false", valueType: "boolean" }),
    "false",
  );
  assert.equal(
    normalizeParameterValue({ name: "sample_number", value: "10.5", valueType: "number" }),
    "10.5",
  );
  assert.equal(
    normalizeParameterValue({ name: "sample_string", value: "unchanged text", valueType: "string" }),
    "unchanged text",
  );
});

test("normalizes JSON values and validates pricing policy", () => {
  assert.equal(
    normalizeParameterValue({
      name: "json_config",
      value: '{ "enabled": true }',
      valueType: "json",
    }),
    '{"enabled":true}',
  );

  const pricingPolicy = normalizeParameterValue({
    name: "lend_pricing_policy",
    value: JSON.stringify(DEFAULT_PRICING_POLICY),
    valueType: "json",
  });
  assert.deepEqual(JSON.parse(pricingPolicy).renter_cancellation_policy, DEFAULT_PRICING_POLICY.renter_cancellation_policy);

  assert.throws(
    () =>
      normalizeParameterValue({
        name: "lend_pricing_policy",
        value: JSON.stringify({ invalid: true }),
        valueType: "json",
      }),
    /checkout_lock_expiry_minutes_by_method/,
  );
});

test("maps template parameters to sorted rows with template publish time", () => {
  const rows = toParameterRows({
    version: { updateTime: "2026-06-03T01:02:03Z" },
    parameters: {
      z_param: {
        defaultValue: { value: "true" },
        description: "Enabled flag",
        conditionalValues: { prod: { value: "false" } },
      },
      a_param: {
        defaultValue: { value: '{"limit":5}' },
      },
    },
  });

  assert.deepEqual(
    rows.map((row) => row.name),
    ["a_param", "z_param"],
  );
  assert.equal(rows[0].valueType, "json");
  assert.equal(rows[0].lastPublishedAt, "2026-06-03T01:02:03Z");
  assert.equal(rows[1].hasConditionalValues, true);
});
