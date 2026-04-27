/**
 * Inbound + sub-agent identity capture for the provenance plugin.
 *
 * Two handlers that populate the IdentityStore so agent-loop hooks
 * (before_prompt_build, llm_output, message_sending, before_tool_call,
 * after_tool_call) can look up identity by sessionKey instead of relying
 * on agent hookCtx fields that mainline does not populate.
 *
 *   - inbound_claim:    fires once per inbound message. Reads
 *                       senderId/senderName/sourceProvider/groupId
 *                       from the event payload and metadata; computes
 *                       senderIsOwner from ownerNumbers config.
 *
 *   - subagent_spawned: fires when a sub-agent session is created.
 *                       Records the parent→child relationship as
 *                       spawnedBy on the child's IdentityRecord.
 *
 * Both handlers are observation-only; they never mutate the events.
 */

import {
  computeSenderIsOwner,
  deriveGroupId,
  type IdentityStore,
} from "./identity-store.js";

// ── Types (loosely typed to match the runtime event shapes) ────────────

interface InboundClaimEvent {
  channel?: string;
  conversationId?: string | null;
  threadId?: string | number | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  sessionKey?: string;
  isGroup?: boolean;
  metadata?: {
    groupId?: unknown;
    [k: string]: unknown;
  };
}

interface SubagentSpawnedEvent {
  parentSessionKey?: string;
  childSessionKey?: string;
  // Some openclaw versions emit alternate field names; we accept both shapes.
  sessionKey?: string;
  spawnedBy?: string;
}

interface AgentContext {
  sessionKey?: string;
  agentId?: string;
}

interface Logger {
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
}

// ── inbound_claim handler factory ──────────────────────────────────────

export function createInboundClaimHandler(params: {
  identityStore: IdentityStore;
  ownerNumbers: readonly string[];
  logger?: Logger;
}) {
  const { identityStore, ownerNumbers, logger } = params;

  return (event: InboundClaimEvent, ctx: AgentContext): void => {
    const sessionKey = event.sessionKey ?? ctx.sessionKey;
    if (!sessionKey) {
      logger?.warn(
        "[provenance] inbound_claim missing sessionKey on both event and ctx — cannot cache identity",
      );
      return;
    }

    const senderId = event.senderId ?? null;
    const senderIsOwner = computeSenderIsOwner(senderId, ownerNumbers);
    const sourceProvider =
      typeof event.channel === "string" && event.channel.length > 0
        ? event.channel
        : undefined;
    const groupId = deriveGroupId({
      sessionKey,
      isGroup: event.isGroup,
      metadataGroupId: event.metadata?.groupId,
      conversationId: event.conversationId ?? null,
      threadId: event.threadId ?? null,
    });

    identityStore.upsert({
      sessionKey,
      senderId,
      senderName: event.senderName ?? null,
      senderIsOwner,
      sourceProvider,
      groupId,
      // spawnedBy is set by the subagent_spawned handler; leave it
      // unmerged here so an existing value is preserved.
    });

    logger?.info(
      `[provenance] inbound_claim: cached identity for ${sessionKey} ` +
        `(sender=${senderId ?? "null"} owner=${senderIsOwner} group=${groupId ?? "none"} provider=${sourceProvider ?? "none"})`,
    );
  };
}

// ── subagent_spawned handler factory ───────────────────────────────────

export function createSubagentSpawnedHandler(params: {
  identityStore: IdentityStore;
  logger?: Logger;
}) {
  const { identityStore, logger } = params;

  return (event: SubagentSpawnedEvent, _ctx: AgentContext): void => {
    // Accept either named-fields shape or generic shape.
    const childSessionKey = event.childSessionKey ?? event.sessionKey;
    const parentSessionKey = event.parentSessionKey ?? event.spawnedBy;
    if (!childSessionKey || !parentSessionKey) {
      logger?.warn(
        "[provenance] subagent_spawned event missing parent/child sessionKey — " +
          `child=${childSessionKey ?? "null"} parent=${parentSessionKey ?? "null"}`,
      );
      return;
    }
    identityStore.setSpawnedBy(childSessionKey, parentSessionKey);
    logger?.info(
      `[provenance] subagent_spawned: recorded ${childSessionKey} as spawned by ${parentSessionKey}`,
    );
  };
}
