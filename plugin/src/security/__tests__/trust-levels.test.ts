import { strict as assert } from "node:assert";
import { minTrust, getToolTrust, TRUST_ORDER, DEFAULT_TOOL_TRUST, type TrustLevel } from "../trust-levels.js";

// minTrust returns the lower (less trusted) of two levels
assert.equal(minTrust("system", "system"), "system");
assert.equal(minTrust("system", "untrusted"), "untrusted");
assert.equal(minTrust("untrusted", "system"), "untrusted");
assert.equal(minTrust("owner", "local"), "local");
assert.equal(minTrust("external", "shared"), "external");
assert.equal(minTrust("local", "local"), "local");

// getToolTrust returns correct defaults
assert.equal(getToolTrust("Read"), "local");
assert.equal(getToolTrust("web_fetch"), "untrusted");
assert.equal(getToolTrust("vestige_search"), "shared");
assert.equal(getToolTrust("message"), "external");
assert.equal(getToolTrust("gateway"), "system");

// Unknown tools default to "local"
assert.equal(getToolTrust("some_unknown_tool"), "local");

// Overrides take precedence
assert.equal(getToolTrust("web_fetch", { "web_fetch": "local" }), "local");
assert.equal(getToolTrust("exec", { "exec": "untrusted" }), "untrusted");

// TRUST_ORDER is correctly ordered
assert.equal(TRUST_ORDER[0], "system");
assert.equal(TRUST_ORDER[TRUST_ORDER.length - 1], "untrusted");
assert.equal(TRUST_ORDER.length, 6);

console.log("✅ trust-levels tests passed");
