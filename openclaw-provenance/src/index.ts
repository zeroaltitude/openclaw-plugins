/**
 * OpenClaw Provenance Plugin
 *
 * Content provenance taint tracking and security policy enforcement.
 * Builds per-turn DAGs, tracks trust levels, and enforces declarative
 * security policies with owner-verified approval.
 */

// @ts-ignore TS7016: plugin-sdk types not available; using runtime definition
import type { OpenClawPluginApi } from "openclaw/plugin-sdk" assert { "resolution-mode": "require" };
import { registerSecurityHooks } from "./security/index.js";
import type { TrustLevel } from "./security/trust-levels.js";

export function register(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;

  const hooksInternalEnabled =
    (api.config as any)?.hooks?.internal?.enabled === true;
  if (!hooksInternalEnabled) {
    api.logger.warn(
      "[provenance] ⚠️  hooks.internal.enabled is not true in config — " +
        "security hooks will NOT be enforced. Enable internal hooks for full protection.",
    );
  }

  registerSecurityHooks(api, api.logger, {
    verbose: true,
    taintPolicy: (cfg.taintPolicy as any) ?? undefined,
    toolOverrides: (cfg.toolOverrides as any) ?? undefined,
    maxIterations: (cfg.maxIterations as number) ?? undefined,
    toolOutputTaints: (cfg.toolOutputTaints as any) ?? undefined,
    trustedSenderIds: (cfg.trustedSenderIds as string[]) ?? undefined,
    agentOverrides: (cfg.agentOverrides as any) ?? undefined,
    compositeTools: (cfg.compositeTools as any) ?? undefined,
    uriExtractors: (cfg.uriExtractors as any) ?? undefined,
    uriTrust: (cfg.uriTrust as any) ?? undefined,
    missingIdentityTrust: (cfg.missingIdentityTrust as TrustLevel) ?? undefined,
    workspaceDir:
      (api.config as any)?.agents?.defaults?.workspace ??
      (api.config as any)?.agents?.workspace ??
      (api.config as any)?.workspaceDir ??
      undefined,
  });
}
