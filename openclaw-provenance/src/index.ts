/**
 * OpenClaw Provenance Plugin
 *
 * Content provenance taint tracking and security policy enforcement.
 * Builds per-turn DAGs, tracks trust levels, and enforces declarative
 * security policies with owner-verified approval.
 */

import { registerSecurityHooks } from "./security/index.js";

interface PluginApi {
  registerTool(def: {
    name: string;
    description: string;
    parameters: any;
    execute: (
      id: string,
      params: any,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;
  }): void;
  on(
    hookName: string,
    handler: (...args: any[]) => any,
    opts?: Record<string, unknown>,
  ): void;
  pluginConfig: Record<string, unknown> | undefined;
  config: Record<string, unknown>;
  logger: {
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  };
}

export function register(api: PluginApi) {
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
    developerMode: (cfg.developerMode as boolean) ?? undefined,
    toolOutputTaints: (cfg.toolOutputTaints as any) ?? undefined,
    trustedSenderIds: (cfg.trustedSenderIds as string[]) ?? undefined,
    workspaceDir:
      (api.config as any)?.agents?.defaults?.workspace ??
      (api.config as any)?.agents?.workspace ??
      (api.config as any)?.workspaceDir ??
      undefined,
  });
}
