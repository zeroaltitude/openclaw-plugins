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
 */
function evaluateCondition(condition: PolicyCondition, graph: TurnProvenanceGraph): boolean {
  if (condition.contextTaintIncludes) {
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
): PolicyEvaluation[] {
  return policies.map(policy => {
    const matched = evaluateCondition(policy.when, graph);
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

  // For both "restrict" and "confirm": evaluate policies to get tool removals
  const evaluations = evaluatePolicies(policies, graph);
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
export const DEFAULT_POLICIES: SecurityPolicy[] = [
  {
    name: "no-exec-when-external",
    when: { contextTaintIncludes: ["external", "untrusted"] },
    action: {
      removeTools: ["exec"],
      reason: "exec disabled: context contains external content",
    },
  },
  {
    name: "no-send-when-untrusted",
    when: { contextTaintIncludes: ["untrusted"] },
    action: {
      blockTools: ["message"],
      reason: "messaging disabled: context contains untrusted content",
    },
  },
  {
    name: "max-recursion",
    when: { iterationGte: 10 },
    action: {
      blockTurn: true,
      reason: "Max recursion depth exceeded (10 iterations)",
    },
  },
];
