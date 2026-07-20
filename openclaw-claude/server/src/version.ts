export const OPENCLAW_CLAUDE_BRIDGE_NAME = "@zeroaltitude/openclaw-claude-bridge";
export const OPENCLAW_CLAUDE_BRIDGE_VERSION = "0.6.0";

/**
 * The codex-app-server protocol revision we mirror. The openclaw codex plugin
 * inspects the leading version in the `userAgent` field of the initialize
 * response; we expose a synthetic semver here so existing clients accept us.
 *
 * Bump when we land a protocol-incompatible change.
 */
export const REPORTED_PROTOCOL_VERSION = "0.130.0";
