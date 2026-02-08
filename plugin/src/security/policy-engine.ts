/**
 * Declarative security policy engine.
 * Evaluates policies against the current provenance graph state.
 */

import type { TrustLevel, TaintPolicyMode } from "./trust-levels.js";
import { TRUST_ORDER, DEFAULT_TAINT_POLICY } from "./trust-levels.js";
import type { TaintPolicyConfig } from "./trust-levels.js";
import type { ApprovalStore } from "./approval-store.js";
import type { TurnProvenanceGraph } from "./provenance-graph.js";

export interface SecurityPolicy {
  name: string;
  /** Policy is evaluated when this condition is true */
  when: PolicyCondition;
  /** Action to take when condition is met */
  action: PolicyAction;
}

export interface PolicyCondition {
  /** Taint level includes any of these trust levels */
  contextTaintIncludes?: TrustLevel[];
  /** Iteration count >= this value */
  iterationGte?: number;
  /** Specific tools were used */
  toolsUsed?: string[];
}

export interface PolicyAction {
  /** Remove these tools from the available set */
  removeTools?: string[];
  /** Block these tools entirely */
  blockTools?: string[];
  /** Block the entire turn */
  blockTurn?: boolean;
  /** Reason for the action */
  reason?: string;
  /** Log the full context */
  logFullContext?: boolean;
  /** Persist the provenance graph */
  persistGraph?: boolean;
}

export interface PolicyEvaluation {
  policy: SecurityPolicy;
  matched: boolean;
  action?: PolicyAction;
}

/**
 * Evaluate a single policy condition against the current graph state.
 * @param skipTaintCheck — when true, contextTaintIncludes is ignored (policies apply unconditionally).
 *   Used when the taint policy mode is "confirm" or "restrict" — the mode itself 
 *   indicates the trust level is suspect, so all policies should be evaluated.
 */
function evaluateCondition(condition: PolicyCondition, graph: TurnProvenanceGraph, skipTaintCheck = false): boolean {
  if (condition.contextTaintIncludes && !skipTaintCheck) {
    const currentTaintIdx = TRUST_ORDER.indexOf(graph.maxTaint);
    const matches = condition.contextTaintIncludes.some(
      level => TRUST_ORDER.indexOf(level) <= currentTaintIdx
    );
    // The condition means: "is the context tainted at this level or worse?"
    // We match if the current taint is at or below any specified level
    if (!matches) return false;
  }

  if (condition.iterationGte !== undefined) {
    if (graph.iterationCount < condition.iterationGte) return false;
  }

  if (condition.toolsUsed) {
    const summary = graph.summary();
    const hasAll = condition.toolsUsed.every(t => summary.toolsUsed.includes(t));
    if (!hasAll) return false;
  }

  return true;
}

/**
 * Evaluate all policies and return matching actions.
 */
export function evaluatePolicies(
  policies: SecurityPolicy[],
  graph: TurnProvenanceGraph,
  skipTaintCheck = false,
): PolicyEvaluation[] {
  return policies.map(policy => {
    const matched = evaluateCondition(policy.when, graph, skipTaintCheck);
    return {
      policy,
      matched,
      action: matched ? policy.action : undefined,
    };
  });
}

/**
 * Get the set of tools to remove based on policy evaluations.
 */
export function getToolRemovals(evaluations: PolicyEvaluation[]): Set<string> {
  const removals = new Set<string>();
  for (const eval_ of evaluations) {
    if (eval_.matched && eval_.action) {
      for (const tool of eval_.action.removeTools ?? []) {
        removals.add(tool);
      }
      for (const tool of eval_.action.blockTools ?? []) {
        removals.add(tool);
      }
    }
  }
  return removals;
}

/**
 * Check if any policy wants to block the entire turn.
 */
export function shouldBlockTurn(evaluations: PolicyEvaluation[]): { block: boolean; reason?: string } {
  for (const eval_ of evaluations) {
    if (eval_.matched && eval_.action?.blockTurn) {
      return { block: true, reason: eval_.action.reason ?? eval_.policy.name };
    }
  }
  return { block: false };
}

/**
 * Evaluate the taint policy for the current graph state.
 * Returns "allow" (skip policies), "deny" (block turn), or "restrict" (normal evaluation).
 */
export function evaluateTaintPolicy(
  graph: TurnProvenanceGraph,
  taintPolicy?: TaintPolicyConfig,
): { mode: TaintPolicyMode; level: TrustLevel } {
  const config = { ...DEFAULT_TAINT_POLICY, ...taintPolicy };
  const currentTaint = graph.maxTaint;
  const mode = config[currentTaint] ?? "restrict";
  return { mode, level: currentTaint };
}

/**
 * Evaluate taint policy with approval support.
 * Returns which tools to remove after considering user approvals.
 */
export function evaluateTaintPolicyWithApprovals(
  graph: TurnProvenanceGraph,
  taintConfig: Required<TaintPolicyConfig>,
  policies: SecurityPolicy[],
  approvalStore: ApprovalStore,
  sessionKey: string,
): {
  mode: TaintPolicyMode;
  toolRemovals: Set<string>;
  pendingConfirmations: Array<{ toolName: string; reason: string }>;
  block?: boolean;
  blockReason?: string;
} {
  const taintLevel = graph.maxTaint;
  const mode = taintConfig[taintLevel] ?? "restrict";

  if (mode === "allow") {
    return { mode, toolRemovals: new Set(), pendingConfirmations: [] };
  }

  if (mode === "deny") {
    return {
      mode,
      toolRemovals: new Set(),
      pendingConfirmations: [],
      block: true,
      blockReason: `Turn blocked by taint policy: ${taintLevel} content is denied`,
    };
  }

  // For both "restrict" and "confirm": evaluate policies to get tool removals.
  // Skip taint-level checks on individual policies — the mode itself indicates
  // this trust level requires enforcement. Policies apply unconditionally.
  const skipTaintCheck = true;
  const evaluations = evaluatePolicies(policies, graph, skipTaintCheck);
  const allRemovals = getToolRemovals(evaluations);
  const blockCheck = shouldBlockTurn(evaluations);

  if (blockCheck.block) {
    return {
      mode,
      toolRemovals: allRemovals,
      pendingConfirmations: [],
      block: true,
      blockReason: blockCheck.reason,
    };
  }

  if (mode === "restrict") {
    return { mode, toolRemovals: allRemovals, pendingConfirmations: [] };
  }

  // mode === "confirm": check approvals, separate into approved vs pending
  const effectiveRemovals = new Set<string>();
  const pendingConfirmations: Array<{ toolName: string; reason: string }> = [];

  for (const toolName of allRemovals) {
    if (approvalStore.isApproved(sessionKey, toolName)) {
      // User already approved this tool — don't remove it
      continue;
    } else {
      // Tool is restricted and not yet approved — remove it and mark as pending
      effectiveRemovals.add(toolName);
      const matchingPolicy = evaluations.find(e =>
        e.matched && (e.action?.removeTools?.includes(toolName) || e.action?.blockTools?.includes(toolName))
      );
      pendingConfirmations.push({
        toolName,
        reason: matchingPolicy?.action?.reason ?? matchingPolicy?.policy.name ?? "security policy",
      });
    }
  }

  return { mode, toolRemovals: effectiveRemovals, pendingConfirmations };
}

/** Default security policies */
/**
 * Default security policies for all built-in OpenClaw tools.
 * These are always present and config policies merge on top.
 * 
 * Tool categories:
 *   - Execution:  exec (shell), browser (web automation)
 *   - Messaging:  message (send to channels/DMs)
 *   - Filesystem: Write, Edit (modify files)
 *   - Config:     gateway (change runtime config, restart)
 *   - Scheduling: cron (create persistent jobs)
 *   - Network:    web_fetch, web_search (read-only, these ARE the taint sources)
 *   - Memory:     Read, memory_search, memory_get (read-only local)
 *   - Agents:     sessions_spawn, sessions_send (delegate to sub-agents)
 *   - Nodes:      nodes (control paired devices)
 * 
 * Read-only tools (Read, web_fetch, web_search, memory_*, image, session_status,
 * sessions_list, sessions_history, agents_list) are not restricted — they are
 * either the taint source itself or read-only with no side effects.
 */
export const DEFAULT_POLICIES: SecurityPolicy[] = [
  // --- Execution ---
  {
    name: "no-exec-when-external",
    when: { contextTaintIncludes: ["external", "untrusted"] },
    action: {
      removeTools: ["exec"],
      reason: "exec disabled: context contains external content",
    },
  },
  {
    name: "no-browser-when-untrusted",
    when: { contextTaintIncludes: ["untrusted"] },
    action: {
      removeTools: ["browser"],
      reason: "browser disabled: context contains untrusted content",
    },
  },

  // --- Messaging ---
  {
    name: "no-message-when-untrusted",
    when: { contextTaintIncludes: ["untrusted"] },
    action: {
      removeTools: ["message"],
      reason: "messaging disabled: context contains untrusted content",
    },
  },

  // --- Filesystem ---
  {
    name: "no-write-when-external",
    when: { contextTaintIncludes: ["external", "untrusted"] },
    action: {
      removeTools: ["Write", "Edit"],
      reason: "file writes disabled: context contains external content",
    },
  },

  // --- Config ---
  {
    name: "no-config-change",
    when: { contextTaintIncludes: ["local", "shared", "external", "untrusted"] },
    action: {
      removeTools: ["gateway"],
      reason: "config changes disabled: prevents policy circumvention via config.patch",
    },
  },

  // --- Scheduling ---
  {
    name: "no-cron-when-external",
    when: { contextTaintIncludes: ["external", "untrusted"] },
    action: {
      removeTools: ["cron"],
      reason: "cron disabled: prevents scheduling persistent backdoors via tainted context",
    },
  },

  // --- Agent delegation ---
  {
    name: "no-spawn-when-untrusted",
    when: { contextTaintIncludes: ["untrusted"] },
    action: {
      removeTools: ["sessions_spawn", "sessions_send"],
      reason: "agent delegation disabled: prevents propagating untrusted content to sub-agents",
    },
  },

  // --- Device control ---
  {
    name: "no-nodes-when-external",
    when: { contextTaintIncludes: ["external", "untrusted"] },
    action: {
      removeTools: ["nodes"],
      reason: "node control disabled: context contains external content",
    },
  },

  // --- TTS (exfiltration vector) ---
  {
    name: "no-tts-when-untrusted",
    when: { contextTaintIncludes: ["untrusted"] },
    action: {
      removeTools: ["tts"],
      reason: "TTS disabled: prevents audio exfiltration of untrusted content",
    },
  },

  // --- Canvas ---
  {
    name: "no-canvas-when-untrusted",
    when: { contextTaintIncludes: ["untrusted"] },
    action: {
      removeTools: ["canvas"],
      reason: "canvas disabled: prevents rendering untrusted content",
    },
  },

  // --- Recursion limit ---
  {
    name: "max-recursion",
    when: { iterationGte: 10 },
    action: {
      blockTurn: true,
      reason: "Max recursion depth exceeded (10 iterations)",
    },
  },
];
