/**
 * Per-session tool approval store.
 * Tracks user-granted overrides for tools that were restricted by taint policy.
 */

export interface PendingApproval {
  sessionKey: string;
  toolName: string;
  taintLevel: string;
  reason: string;
  requestedAt: number;
}

export class ApprovalStore {
  /** Map<sessionKey, Set<toolName>> — approved tools per session */
  private approvals: Map<string, Set<string>> = new Map();

  /** Map<sessionKey, PendingApproval[]> — tools waiting for approval */
  private pending: Map<string, PendingApproval[]> = new Map();

  /** Grant approval for a tool in a session */
  approve(sessionKey: string, toolName: string): void {
    let set = this.approvals.get(sessionKey);
    if (!set) {
      set = new Set();
      this.approvals.set(sessionKey, set);
    }
    set.add(toolName);
    // Remove from pending
    const pendingList = this.pending.get(sessionKey);
    if (pendingList) {
      this.pending.set(sessionKey, pendingList.filter(p => p.toolName !== toolName));
    }
  }

  /** Grant approval for ALL tools in a session */
  approveAll(sessionKey: string): void {
    const pendingList = this.pending.get(sessionKey);
    if (pendingList) {
      let set = this.approvals.get(sessionKey);
      if (!set) {
        set = new Set();
        this.approvals.set(sessionKey, set);
      }
      for (const p of pendingList) {
        set.add(p.toolName);
      }
      this.pending.delete(sessionKey);
    }
    // Also add a wildcard marker
    let set = this.approvals.get(sessionKey);
    if (!set) {
      set = new Set();
      this.approvals.set(sessionKey, set);
    }
    set.add("*");
  }

  /** Check if a tool is approved for a session */
  isApproved(sessionKey: string, toolName: string): boolean {
    const set = this.approvals.get(sessionKey);
    if (!set) return false;
    return set.has(toolName) || set.has("*");
  }

  /** Add a pending approval request */
  addPending(pending: PendingApproval): void {
    let list = this.pending.get(pending.sessionKey);
    if (!list) {
      list = [];
      this.pending.set(pending.sessionKey, list);
    }
    // Don't duplicate
    if (!list.some(p => p.toolName === pending.toolName)) {
      list.push(pending);
    }
  }

  /** Get pending approvals for a session */
  getPending(sessionKey: string): PendingApproval[] {
    return this.pending.get(sessionKey) ?? [];
  }

  /** Clear all approvals and pending for a session */
  clearSession(sessionKey: string): void {
    this.approvals.delete(sessionKey);
    this.pending.delete(sessionKey);
  }

  /** Get all approved tools for a session */
  getApproved(sessionKey: string): string[] {
    const set = this.approvals.get(sessionKey);
    return set ? Array.from(set) : [];
  }
}
