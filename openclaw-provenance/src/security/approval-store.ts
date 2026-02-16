/**
 * Owner-verified approval state management.
 *
 * Tracks which tools have been approved by the owner for a given session.
 * Approvals are gated by verified owner identity (senderIsOwner), not by codes.
 *
 * Approvals can be:
 * - Turn-scoped (default): cleared when the turn ends
 * - Time-scoped: expire after N minutes
 */

export interface ApprovalEntry {
  toolName: string;
  sessionKey: string;
  approvedAt: number;
  expiresAt: number | null; // null = turn-scoped (cleared at turn end)
}

export class ApprovalStore {
  /** sessionKey → toolName → ApprovalEntry */
  private approvals = new Map<string, Map<string, ApprovalEntry>>();

  /**
   * Approve a tool for a session.
   * @param sessionKey - Session to approve for
   * @param toolName - Tool name (or "all" for wildcard)
   * @param durationMinutes - Duration in minutes (null = turn-scoped)
   */
  approve(
    sessionKey: string,
    toolName: string,
    durationMinutes: number | null = null,
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
    });
  }

  /**
   * Approve multiple tools at once (e.g., from ".approve all").
   * @param sessionKey - Session to approve for
   * @param toolNames - Tool names to approve (or ["all"] for wildcard)
   * @param durationMinutes - Duration in minutes (null = turn-scoped)
   */
  approveMultiple(
    sessionKey: string,
    toolNames: string[],
    durationMinutes: number | null = null,
  ): void {
    for (const tool of toolNames) {
      this.approve(sessionKey, tool, durationMinutes);
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

    // Check specific tool approval
    const specific = sessionApprovals.get(toolLower);
    if (specific) {
      if (specific.expiresAt === null || specific.expiresAt > now) {
        return true;
      }
      // Expired — clean up
      sessionApprovals.delete(toolLower);
    }

    // Check wildcard "all" approval
    const wildcard = sessionApprovals.get("all");
    if (wildcard) {
      if (wildcard.expiresAt === null || wildcard.expiresAt > now) {
        return true;
      }
      sessionApprovals.delete("all");
    }

    return false;
  }

  /** Clear turn-scoped approvals for a session (called at turn end) */
  clearTurnScoped(sessionKey: string): void {
    const sessionApprovals = this.approvals.get(sessionKey);
    if (!sessionApprovals) return;

    for (const [key, entry] of sessionApprovals) {
      if (entry.expiresAt === null) {
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
