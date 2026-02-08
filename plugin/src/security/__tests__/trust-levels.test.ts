import { strict as assert } from "node:assert";
import { minTrust, getToolTrust, TRUST_ORDER, DEFAULT_TOOL_TRUST, DEFAULT_TAINT_POLICY, type TrustLevel, type TaintPolicyMode } from "../trust-levels.js";

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

// DEFAULT_TAINT_POLICY has correct defaults
assert.equal(DEFAULT_TAINT_POLICY.system, "allow");
assert.equal(DEFAULT_TAINT_POLICY.owner, "allow");
assert.equal(DEFAULT_TAINT_POLICY.local, "allow");
assert.equal(DEFAULT_TAINT_POLICY.shared, "restrict");
assert.equal(DEFAULT_TAINT_POLICY.external, "restrict");
assert.equal(DEFAULT_TAINT_POLICY.untrusted, "restrict");

// TaintPolicyMode type check
const modes: TaintPolicyMode[] = ["allow", "deny", "restrict"];
assert.equal(modes.length, 3);

console.log("✅ trust-levels tests passed");
