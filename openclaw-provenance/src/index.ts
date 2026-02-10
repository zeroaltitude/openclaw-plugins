/**
 * OpenClaw Provenance Plugin
 *
 * Content provenance taint tracking and security policy enforcement.
 * Builds per-turn DAGs, tracks trust levels, and enforces declarative
 * security policies with code-based approval.
 */

import { registerSecurityHooks } from "./security/index.js";

// The OpenClaw plugin API type (provided at runtime)
interface PluginApi {
  registerTool(def: {
    name: string;
    description: string;
    parameters: any;
    execute: (id: string, params: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
  }): void;
  on(hookName: string, handler: (...args: any[]) => any, opts?: { priority?: number }): void;
  pluginConfig: Record<string, unknown> | undefined;
  config: Record<string, unknown>;
  logger: { info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void };
}

// ── Plugin entry point ───────────────────────────────────────────────────────
export function register(api: PluginApi) {
  const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;

  registerSecurityHooks(
    api,
    api.logger,
    {
      verbose: true,
      taintPolicy: (cfg.taintPolicy as any) ?? undefined,
      toolOverrides: (cfg.toolOverrides as any) ?? undefined,
      approvalTtlSeconds: (cfg.approvalTtlSeconds as number) ?? undefined,
      maxIterations: (cfg.maxIterations as number) ?? undefined,
      developerMode: (cfg.developerMode as boolean) ?? undefined,
      toolOutputTaints: (cfg.toolOutputTaints as any) ?? undefined,
      workspaceDir: (api.config as any)?.agents?.defaults?.workspace ?? (api.config as any)?.agents?.workspace ?? (api.config as any)?.workspaceDir ?? undefined,
    },
  );
}
