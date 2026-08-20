/**
 * Tool-approval state management.
 *
 * Tracks which tools have been approved for a given session, so the policy
 * engine can let an otherwise-blocked tool through (`policy-engine.ts`
 * `evaluateWithApprovals()`, plus the execution-layer re-check in
 * `index.ts`'s `before_tool_call`).
 *
 * ── Where the authorization actually lives ──
 *
 * This store performs NO authorization of its own: every `approve()` call it
 * receives is honoured unconditionally. The gate sits one layer up, at the
 * only mutation site — the `/approve-exec` command registered in
 * `security/index.ts` with `requireAuth: true`. Core enforces that flag in
 * openclaw `src/plugins/plugin-command-execution.ts`, refusing the
 * invocation unless `isAuthorizedSender` is true.
 *
 * `isAuthorizedSender` is NOT this plugin's `senderIsOwner`. Core resolves it
 * in `src/auto-reply/command-auth.ts`: owner status is the default basis, but
 * a configured `commandsAllowFrom` allowlist (or wildcard), or native-CLI
 * authorization, also satisfies it. On such a deployment a non-owner sender
 * can lift provenance tool blocks. An earlier version of this comment claimed
 * approvals were "gated by verified owner identity (senderIsOwner)" — no such
 * gate exists here or anywhere in this plugin; `senderIsOwner` is only ever
 * read for trust classification (`classifyInitialTrust`, `isOwnerDm`), never
 * for approvals.
 *
 * What the approval surface is *not* reachable from is the agent loop. Plugin
 * commands dispatch from an inbound message body starting with `/`, matched
 * before the loop runs, so a prompt-injected model cannot call
 * `/approve-exec` to unblock itself. That property — not an owner check in
 * this file — is what keeps tainted content away from approvals.
 *
 * Approvals can be:
 * - Session-scoped (default): cleared when the session is reset
 * - Turn-scoped: cleared when the turn ends
 * - Time-scoped: expire after N minutes
 */

export type ApprovalScope = "session" | "turn" | "time";

export interface ApprovalEntry {
  toolName: string;
  sessionKey: string;
  approvedAt: number;
  /** null for session- and turn-scoped approvals. */
  expiresAt: number | null;
  scope: ApprovalScope;
}

export class ApprovalStore {
  /** sessionKey → toolName → ApprovalEntry */
  private approvals = new Map<string, Map<string, ApprovalEntry>>();

  /**
   * Approve a tool for a session.
   * @param sessionKey - Session to approve for
   * @param toolName - Tool name (or "all" for wildcard)
   * @param durationMinutes - Duration in minutes (null = session- or turn-scoped)
   * @param scope - Lifetime when durationMinutes is null (default: session)
   */
  approve(
    sessionKey: string,
    toolName: string,
    durationMinutes: number | null = null,
    scope: Exclude<ApprovalScope, "time"> = "session",
  ): void {
    if (!this.approvals.has(sessionKey)) {
      this.approvals.set(sessionKey, new Map());
    }
    const sessionApprovals = this.approvals.get(sessionKey)!;
    const now = Date.now();
    const expiresAt =
      durationMinutes != null ? now + durationMinutes * 60 * 1000 : null;

    sessionApprovals.set(toolName.toLowerCase(), {
      toolName: toolName.toLowerCase(),
      sessionKey,
      approvedAt: now,
      expiresAt,
      scope: durationMinutes != null ? "time" : scope,
    });
  }

  /**
   * Approve multiple tools at once (e.g., from ".approve all").
   * @param sessionKey - Session to approve for
   * @param toolNames - Tool names to approve (or ["all"] for wildcard)
   * @param durationMinutes - Duration in minutes (null = session- or turn-scoped)
   * @param scope - Lifetime when durationMinutes is null (default: session)
   */
  approveMultiple(
    sessionKey: string,
    toolNames: string[],
    durationMinutes: number | null = null,
    scope: Exclude<ApprovalScope, "time"> = "session",
  ): void {
    for (const tool of toolNames) {
      this.approve(sessionKey, tool, durationMinutes, scope);
    }
  }

  /**
   * Check if a tool is approved for a session.
   * Checks for both specific tool approval and wildcard "all" approval.
   */
  isApproved(sessionKey: string, toolName: string): boolean {
    const sessionApprovals = this.approvals.get(sessionKey);
    if (!sessionApprovals) return false;

    const now = Date.now();
    const toolLower = toolName.toLowerCase();

    // A bare-tool approval covers its composite actions. For example,
    // `/approve-exec browser` unblocks `browser.snapshot`, while an
    // action-specific approval never grants the bare tool or sibling actions.
    const candidates = [toolLower];
    let separator = toolLower.lastIndexOf(".");
    while (separator > 0) {
      candidates.push(toolLower.slice(0, separator));
      separator = toolLower.lastIndexOf(".", separator - 1);
    }
    candidates.push("all");

    for (const candidate of candidates) {
      const approval = sessionApprovals.get(candidate);
      if (!approval) continue;
      if (approval.expiresAt === null || approval.expiresAt > now) {
        return true;
      }
      // Expired — clean up before checking less-specific approvals.
      sessionApprovals.delete(candidate);
    }

    return false;
  }

  /** Clear turn-scoped approvals for a session (called at turn end) */
  clearTurnScoped(sessionKey: string): void {
    const sessionApprovals = this.approvals.get(sessionKey);
    if (!sessionApprovals) return;

    for (const [key, entry] of sessionApprovals) {
      if (entry.scope === "turn") {
        sessionApprovals.delete(key);
      }
    }

    if (sessionApprovals.size === 0) {
      this.approvals.delete(sessionKey);
    }
  }

  /** Clear all approvals for a session */
  clearAll(sessionKey: string): void {
    this.approvals.delete(sessionKey);
  }

  /** List active approvals for a session (for diagnostics) */
  listApprovals(sessionKey: string): ApprovalEntry[] {
    const sessionApprovals = this.approvals.get(sessionKey);
    if (!sessionApprovals) return [];
    const now = Date.now();
    return Array.from(sessionApprovals.values()).filter(
      (e) => e.expiresAt === null || e.expiresAt > now,
    );
  }
}
