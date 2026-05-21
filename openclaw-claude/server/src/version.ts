export const OPENCLAW_CLAUDE_APP_SERVER_NAME = "@openclaw/claude-app-server";
export const OPENCLAW_CLAUDE_APP_SERVER_VERSION = "0.1.0";

/**
 * The codex-app-server protocol revision we mirror. The openclaw codex plugin
 * inspects the leading version in the `userAgent` field of the initialize
 * response; we expose a synthetic semver here so existing clients accept us.
 *
 * Bump when we land a protocol-incompatible change.
 */
export const REPORTED_PROTOCOL_VERSION = "0.130.0";
