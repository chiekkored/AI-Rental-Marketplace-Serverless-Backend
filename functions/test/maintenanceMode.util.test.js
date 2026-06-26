const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeMaintenanceEnabled } = require("../utils/maintenanceMode.util")._test;

test("normalizeMaintenanceEnabled accepts booleans", () => {
  assert.equal(normalizeMaintenanceEnabled(true), true);
  assert.equal(normalizeMaintenanceEnabled(false), false);
});

test("normalizeMaintenanceEnabled rejects non-booleans", () => {
  assert.throws(() => normalizeMaintenanceEnabled("true"), /Maintenance mode enabled must be a boolean/);
  assert.throws(() => normalizeMaintenanceEnabled(1), /Maintenance mode enabled must be a boolean/);
  assert.throws(() => normalizeMaintenanceEnabled(null), /Maintenance mode enabled must be a boolean/);
});
