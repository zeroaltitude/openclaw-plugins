/**
 * Per-turn provenance graph.
 * 
 * Built iteratively as hooks fire during an agent turn.
 * Tracks data flow, trust levels, and actions to enable
 * taint-based security policies.
 */

import { type TrustLevel, TRUST_ORDER, minTrust, getToolTrust } from "./trust-levels.js";

export interface GraphNode {
  id: string;
  kind: "input" | "system_prompt" | "history" | "llm_call" | "tool_call" | "tool_result" | "output" | "policy_decision";
  trust: TrustLevel;
  tool?: string;
  iteration?: number;
  blocked?: boolean;
  blockReason?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: "triggers" | "produces" | "consumes" | "derives_from" | "blocked_by";
}

export interface TurnGraphSummary {
  maxTaint: TrustLevel;
  externalSources: string[];
  toolsUsed: string[];
  toolsBlocked: string[];
  iterationCount: number;
  nodeCount: number;
  edgeCount: number;
}

export class TurnProvenanceGraph {
  readonly turnId: string;
  readonly sessionKey: string;
  readonly startedAt: number;
  
  private nodes: Map<string, GraphNode> = new Map();
  private edges: GraphEdge[] = [];
  private _maxTaint: TrustLevel = "system";
  private _iterationCount = 0;
  private _sealed = false;
  private _nodeCounter = 0;
  private _externalSources: string[] = [];
  private _toolsUsed: string[] = [];
  private _toolsBlocked: string[] = [];

  constructor(sessionKey: string, turnId?: string) {
    this.sessionKey = sessionKey;
    this.turnId = turnId ?? `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.startedAt = Date.now();
  }

  /** Current accumulated taint level (lowest trust seen) */
  get maxTaint(): TrustLevel { return this._maxTaint; }
  
  /** Number of loop iterations so far */
  get iterationCount(): number { return this._iterationCount; }

  /** Whether the graph has been sealed (turn complete) */
  get sealed(): boolean { return this._sealed; }

  /** Generate a unique node ID */
  private nextNodeId(prefix: string): string {
    return `${prefix}-${++this._nodeCounter}`;
  }

  /** Update the accumulated taint level */
  private updateTaint(trust: TrustLevel): void {
    this._maxTaint = minTrust(this._maxTaint, trust);
  }

  /** Reset taint to a specific level (owner override via .reset-trust) */
  resetTaint(level: TrustLevel): void {
    if (this._sealed) throw new Error("Cannot modify sealed graph");
    this._maxTaint = level;
  }

  /** Add a node to the graph */
  addNode(node: Omit<GraphNode, "timestamp"> & { timestamp?: number }): GraphNode {
    if (this._sealed) throw new Error("Cannot modify sealed graph");
    const full: GraphNode = { ...node, timestamp: node.timestamp ?? Date.now() };
    this.nodes.set(full.id, full);
    this.updateTaint(full.trust);
    return full;
  }

  /** Add an edge to the graph */
  addEdge(edge: GraphEdge): void {
    if (this._sealed) throw new Error("Cannot modify sealed graph");
    this.edges.push(edge);
  }

  /** Get a node by ID */
  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** Get all nodes */
  getAllNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  /** Get all edges */
  getAllEdges(): GraphEdge[] {
    return [...this.edges];
  }

  // =========================================================================
  // High-level operations called by hook handlers
  // =========================================================================

  /** Record the initial context assembly (called from context_assembled hook) */
  recordContextAssembled(systemPrompt: string, messageCount: number, initialTrust?: TrustLevel): string {
    const nodeId = this.nextNodeId("ctx");
    this.addNode({
      id: nodeId,
      kind: "system_prompt",
      trust: "system",
    });
    // Add a history node representing all prior messages.
    // Trust is classified from sender/channel metadata when available,
    // falling back to "owner" for backward compatibility.
    if (messageCount > 0) {
      const histId = this.nextNodeId("hist");
      this.addNode({
        id: histId,
        kind: "history",
        trust: initialTrust ?? "owner",
        metadata: { messageCount },
      });
    }
    return nodeId;
  }

  /** Record an LLM call (called from before_llm_call hook) */
  recordLlmCall(iteration: number, toolCount: number): string {
    this._iterationCount = Math.max(this._iterationCount, iteration);
    const nodeId = this.nextNodeId("llm");
    this.addNode({
      id: nodeId,
      kind: "llm_call",
      trust: this._maxTaint, // LLM call inherits accumulated taint
      iteration,
      metadata: { toolCount },
    });
    return nodeId;
  }

  /** Record a tool call from after_llm_call (called from after_llm_call hook) */
  recordToolCall(toolName: string, iteration: number, llmNodeId?: string, toolTrustOverrides?: Record<string, TrustLevel>): string {
    const trust = getToolTrust(toolName, toolTrustOverrides);
    const nodeId = this.nextNodeId("tool");
    this.addNode({
      id: nodeId,
      kind: "tool_call",
      trust,
      tool: toolName,
      iteration,
    });
    this._toolsUsed.push(toolName);
    
    // Track external sources
    const idx = TRUST_ORDER.indexOf(trust);
    if (idx >= TRUST_ORDER.indexOf("external")) {
      this._externalSources.push(toolName);
    }

    if (llmNodeId) {
      this.addEdge({ from: llmNodeId, to: nodeId, relation: "triggers" });
    }
    return nodeId;
  }

  /** Record a blocked tool call */
  recordBlockedTool(toolName: string, reason: string, iteration: number): string {
    const nodeId = this.nextNodeId("blocked");
    this.addNode({
      id: nodeId,
      kind: "policy_decision",
      trust: "system",
      tool: toolName,
      iteration,
      blocked: true,
      blockReason: reason,
    });
    this._toolsBlocked.push(toolName);
    return nodeId;
  }

  /** Record the final output (called from before_response_emit hook) */
  recordOutput(contentLength: number): string {
    const nodeId = this.nextNodeId("out");
    this.addNode({
      id: nodeId,
      kind: "output",
      trust: this._maxTaint, // output inherits accumulated taint
      metadata: { contentLength },
    });
    return nodeId;
  }

  /** Record a loop iteration boundary */
  recordIterationEnd(iteration: number, toolCallsMade: number, willContinue: boolean): void {
    this._iterationCount = Math.max(this._iterationCount, iteration);
  }

  /** Seal the graph — no more modifications allowed */
  seal(): TurnGraphSummary {
    this._sealed = true;
    return this.summary();
  }

  /** Get the current summary */
  summary(): TurnGraphSummary {
    return {
      maxTaint: this._maxTaint,
      externalSources: [...this._externalSources],
      toolsUsed: [...this._toolsUsed],
      toolsBlocked: [...this._toolsBlocked],
      iterationCount: this._iterationCount,
      nodeCount: this.nodes.size,
      edgeCount: this.edges.length,
    };
  }

  /** Export to a JSON-serializable object */
  toJSON(): Record<string, unknown> {
    return {
      turnId: this.turnId,
      sessionKey: this.sessionKey,
      startedAt: this.startedAt,
      sealed: this._sealed,
      summary: this.summary(),
      nodes: Array.from(this.nodes.values()),
      edges: this.edges,
    };
  }
}

/**
 * Global graph store — maintains per-session active graphs.
 * Plugin-scoped (closure over module state).
 */
/** Extract the root cause reason from a turn's provenance graph for watermark storage */
function buildWatermarkReason(graph: TurnProvenanceGraph): string {
  const nodes = graph.getAllNodes();
  const taintIdx = TRUST_ORDER.indexOf(graph.maxTaint);

  // Content scan detection (external markers in history)
  const contentScan = nodes.find(n => n.id === "content-scan-taint");
  if (contentScan && TRUST_ORDER.indexOf(contentScan.trust) >= taintIdx) {
    return "external markers in history";
  }

  // Tool calls that escalated taint
  const toolNodes = nodes.filter(n => n.kind === "tool_call" && TRUST_ORDER.indexOf(n.trust) >= taintIdx);
  if (toolNodes.length > 0) {
    const toolNames = toolNodes.map(n => n.tool).filter(Boolean);
    return toolNames.join(", ") || "tool call";
  }

  // History contamination
  const historyNode = nodes.find(n => n.id === "history" && TRUST_ORDER.indexOf(n.trust) >= taintIdx);
  if (historyNode) return "history contamination";

  return "unknown";
}

export class ProvenanceStore {
  private activeGraphs: Map<string, TurnProvenanceGraph> = new Map();
  private completedGraphs: TurnProvenanceGraph[] = [];
  private maxCompletedGraphs: number;

  /**
   * Session-level taint watermark — tracks the worst taint level seen
   * across all turns in a session. This prevents taint amnesia when
   * tainted content (e.g. web_fetch responses) persists in the LLM
   * context window across turn boundaries.
   * 
   * Cleared explicitly by .reset-trust or when the session ends.
   */
  private sessionTaintWatermark: Map<string, TrustLevel> = new Map();
  private sessionTaintWatermarkReason: Map<string, string> = new Map();

  constructor(maxCompletedGraphs = 100) {
    this.maxCompletedGraphs = maxCompletedGraphs;
  }

  /** Start a new turn graph for a session (replaces any existing active graph) */
  startTurn(sessionKey: string): TurnProvenanceGraph {
    // Seal and archive any existing graph
    const existing = this.activeGraphs.get(sessionKey);
    if (existing && !existing.sealed) {
      existing.seal();
      this.archiveGraph(existing, sessionKey);
    }
    const graph = new TurnProvenanceGraph(sessionKey);
    this.activeGraphs.set(sessionKey, graph);
    return graph;
  }

  /** Get the active graph for a session */
  getActive(sessionKey: string): TurnProvenanceGraph | undefined {
    return this.activeGraphs.get(sessionKey);
  }

  /** Complete a turn — seal and archive the graph */
  completeTurn(sessionKey: string): TurnGraphSummary | undefined {
    const graph = this.activeGraphs.get(sessionKey);
    if (!graph) return undefined;
    const summary = graph.seal();
    this.activeGraphs.delete(sessionKey);
    this.archiveGraph(graph, sessionKey);
    return summary;
  }

  /** Get the session taint watermark (worst taint across all turns) */
  getSessionTaintWatermark(sessionKey: string): { level: TrustLevel; reason: string } | undefined {
    const level = this.sessionTaintWatermark.get(sessionKey);
    if (!level) return undefined;
    return { level, reason: this.sessionTaintWatermarkReason.get(sessionKey) ?? "unknown" };
  }

  /** Clear the session taint watermark (used by .reset-trust) */
  clearSessionTaintWatermark(sessionKey: string): void {
    this.sessionTaintWatermark.delete(sessionKey);
    this.sessionTaintWatermarkReason.delete(sessionKey);
  }

  /** Get recent completed graphs */
  getCompleted(limit?: number): TurnProvenanceGraph[] {
    return this.completedGraphs.slice(-(limit ?? this.maxCompletedGraphs));
  }

  private archiveGraph(graph: TurnProvenanceGraph, sessionKey: string): void {
    this.completedGraphs.push(graph);
    if (this.completedGraphs.length > this.maxCompletedGraphs) {
      this.completedGraphs.shift();
    }
    // Update session taint watermark with this turn's max taint
    const turnTaint = graph.maxTaint;
    const existing = this.sessionTaintWatermark.get(sessionKey);
    if (existing) {
      const merged = minTrust(existing, turnTaint);
      this.sessionTaintWatermark.set(sessionKey, merged);
      // Update reason if taint escalated (got worse)
      if (merged !== existing) {
        this.sessionTaintWatermarkReason.set(sessionKey, buildWatermarkReason(graph));
      }
    } else {
      this.sessionTaintWatermark.set(sessionKey, turnTaint);
      this.sessionTaintWatermarkReason.set(sessionKey, buildWatermarkReason(graph));
    }
  }
}
