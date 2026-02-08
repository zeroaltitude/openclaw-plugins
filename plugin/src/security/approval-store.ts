/**
 * Per-session tool approval store with security codes.
 * 
 * Approval requires a time-limited, randomly generated code that must be
 * repeated back by the owner. This prevents social engineering attacks where
 * injected content tricks the user into approving dangerous tool access.
 * 
 * Format: .approve <all|tool> <code>
 * Codes expire after APPROVAL_TTL_MS (default: 60 seconds).
 */

import { randomBytes } from "crypto";

/** How long an approval code is valid (ms) */
const APPROVAL_TTL_MS = 60_000; // 60 seconds

/** Length of the hex approval code */
const CODE_LENGTH = 4; // 4 bytes = 8 hex chars

export interface PendingApproval {
  sessionKey: string;
  toolName: string;
  taintLevel: string;
  reason: string;
  requestedAt: number;
  /** The approval code the user must provide */
  code: string;
  /** When the code expires */
  expiresAt: number;
}

export interface ActiveApproval {
  toolName: string;
  /** When this approval expires (epoch ms). null = turn-scoped (cleared on turn end) */
  expiresAt: number | null;
}

export class ApprovalStore {
  /** Map<sessionKey, ActiveApproval[]> — approved tools per session */
  private approvals: Map<string, ActiveApproval[]> = new Map();

  /** Map<sessionKey, PendingApproval[]> — tools waiting for approval */
  private pending: Map<string, PendingApproval[]> = new Map();

  /** Generate a random approval code */
  private generateCode(): string {
    return randomBytes(CODE_LENGTH).toString("hex");
  }

  /**
   * Attempt to approve with a code.
   * Returns { ok, reason } indicating success or why it failed.
   */
  /**
   * Attempt to approve with a code.
   * @param durationMinutes — null = this turn only, number = minutes until expiry
   */
  approveWithCode(
    sessionKey: string,
    target: string, // "all" or a tool name
    code: string,
    durationMinutes?: number | null,
  ): { ok: boolean; approved: string[]; reason?: string } {
    const pendingList = this.pending.get(sessionKey);
    if (!pendingList || pendingList.length === 0) {
      return { ok: false, approved: [], reason: "No pending approvals" };
    }

    const now = Date.now();

    if (target === "all") {
      // All pending items must share the same code (generated together)
      // Check that at least one pending item matches the code and isn't expired
      const matching = pendingList.filter(p => p.code === code && p.expiresAt > now);
      if (matching.length === 0) {
        // Check if code was right but expired
        const expired = pendingList.filter(p => p.code === code && p.expiresAt <= now);
        if (expired.length > 0) {
          return { ok: false, approved: [], reason: "Approval code expired. New code will be issued." };
        }
        return { ok: false, approved: [], reason: "Invalid approval code" };
      }

      let list = this.approvals.get(sessionKey);
      if (!list) {
        list = [];
        this.approvals.set(sessionKey, list);
      }
      const expiresAt = durationMinutes != null ? Date.now() + durationMinutes * 60_000 : null;
      const approved: string[] = [];
      for (const p of matching) {
        // Remove any existing approval for this tool, then add new one
        const idx = list.findIndex(a => a.toolName === p.toolName);
        if (idx >= 0) list.splice(idx, 1);
        list.push({ toolName: p.toolName, expiresAt });
        approved.push(p.toolName);
      }
      // Clear all pending for this session
      this.pending.delete(sessionKey);
      return { ok: true, approved };
    } else {
      // Approve a specific tool
      const match = pendingList.find(p => p.toolName === target && p.code === code);
      if (!match) {
        const wrongCode = pendingList.find(p => p.toolName === target);
        if (!wrongCode) {
          return { ok: false, approved: [], reason: `No pending approval for tool: ${target}` };
        }
        if (wrongCode.expiresAt <= now) {
          return { ok: false, approved: [], reason: "Approval code expired. New code will be issued." };
        }
        return { ok: false, approved: [], reason: "Invalid approval code" };
      }
      if (match.expiresAt <= now) {
        return { ok: false, approved: [], reason: "Approval code expired. New code will be issued." };
      }

      let list = this.approvals.get(sessionKey);
      if (!list) {
        list = [];
        this.approvals.set(sessionKey, list);
      }
      const expiresAt = durationMinutes != null ? Date.now() + durationMinutes * 60_000 : null;
      const idx = list.findIndex(a => a.toolName === target);
      if (idx >= 0) list.splice(idx, 1);
      list.push({ toolName: target, expiresAt });
      // Remove from pending
      this.pending.set(sessionKey, pendingList.filter(p => p.toolName !== target));
      return { ok: true, approved: [target] };
    }
  }

  /** Check if a tool is approved for a session (respects expiration) */
  isApproved(sessionKey: string, toolName: string): boolean {
    const list = this.approvals.get(sessionKey);
    if (!list) return false;
    const now = Date.now();
    const approval = list.find(a => a.toolName === toolName);
    if (!approval) return false;
    // null expiresAt = turn-scoped (still valid until explicitly cleared)
    if (approval.expiresAt !== null && approval.expiresAt <= now) {
      // Expired — remove it
      const idx = list.indexOf(approval);
      if (idx >= 0) list.splice(idx, 1);
      return false;
    }
    return true;
  }

  /** Clear turn-scoped approvals (expiresAt === null). Called at turn end. */
  clearTurnScoped(sessionKey: string): void {
    const list = this.approvals.get(sessionKey);
    if (!list) return;
    const remaining = list.filter(a => a.expiresAt !== null);
    if (remaining.length === 0) {
      this.approvals.delete(sessionKey);
    } else {
      this.approvals.set(sessionKey, remaining);
    }
  }

  /**
   * Add pending approval requests and generate a shared code.
   * All tools in a batch share one code so "approve all <code>" works.
   * Returns the generated code.
   */
  addPendingBatch(items: Omit<PendingApproval, "code" | "expiresAt">[]): string {
    if (items.length === 0) return "";
    
    const code = this.generateCode();
    const now = Date.now();
    const expiresAt = now + APPROVAL_TTL_MS;

    for (const item of items) {
      let list = this.pending.get(item.sessionKey);
      if (!list) {
        list = [];
        this.pending.set(item.sessionKey, list);
      }
      // Replace existing pending for same tool (refresh code)
      const idx = list.findIndex(p => p.toolName === item.toolName);
      const entry: PendingApproval = { ...item, code, expiresAt };
      if (idx >= 0) {
        list[idx] = entry;
      } else {
        list.push(entry);
      }
    }
    return code;
  }

  /** @deprecated Use addPendingBatch instead */
  addPending(pending: Omit<PendingApproval, "code" | "expiresAt">): string {
    return this.addPendingBatch([pending]);
  }

  /** Get pending approvals for a session (filters out expired) */
  getPending(sessionKey: string): PendingApproval[] {
    const list = this.pending.get(sessionKey) ?? [];
    const now = Date.now();
    // Filter expired
    const valid = list.filter(p => p.expiresAt > now);
    if (valid.length !== list.length) {
      this.pending.set(sessionKey, valid);
    }
    return valid;
  }

  /** Get the current approval code for a session (if any pending) */
  getCurrentCode(sessionKey: string): string | null {
    const pending = this.getPending(sessionKey);
    return pending.length > 0 ? pending[0].code : null;
  }

  /** Get TTL remaining in seconds for the current code */
  getCodeTtlSeconds(sessionKey: string): number {
    const pending = this.getPending(sessionKey);
    if (pending.length === 0) return 0;
    return Math.max(0, Math.ceil((pending[0].expiresAt - Date.now()) / 1000));
  }

  /** Clear all approvals and pending for a session */
  clearSession(sessionKey: string): void {
    this.approvals.delete(sessionKey);
    this.pending.delete(sessionKey);
  }

  /** Get all currently approved tools for a session */
  getApproved(sessionKey: string): string[] {
    const list = this.approvals.get(sessionKey);
    if (!list) return [];
    const now = Date.now();
    return list.filter(a => a.expiresAt === null || a.expiresAt > now).map(a => a.toolName);
  }
}
