/**
 * Regression tests for openclaw-d42b — `thread/refresh_tools` must not break
 * the live SDK MCP binding, and must actually apply the new catalog.
 *
 * The bug: openclaw sends `servers: { openclaw: { type: "sdk", name: "openclaw" } }`
 * — shape only, no `instance`. `Query.setMcpServers` uses the PRESENCE of
 * `instance` as its desired-state signal, so a shape-only entry made the SDK
 * disconnect the in-process transport while still telling the CLI the server
 * existed. Every later `mcp__openclaw__*` call then failed with
 * `SDK MCP server not found: openclaw` for the rest of the attempt's life.
 * Separately, the spec set was captured immutably at construction, so a refresh
 * could not change the surface at all.
 *
 * These tests run the REAL `buildDynamicToolsMcpServer` handle against a fake
 * that reimplements `Query.setMcpServers`'s diff semantics verbatim (see
 * `FakeSdkQuery`) over REAL in-memory MCP transports and a REAL MCP client. So
 * "a tool call still dispatches" is an actual `tools/call` round-trip through
 * the same machinery production uses, and the fake throws the same
 * `SDK MCP server not found` error the SDK does when the transport is gone.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AttemptRegistry,
  type AttemptEntry,
  type AttemptFingerprintInput,
} from "../src/attempt-registry.js";
import { buildDynamicToolsMcpServer, type DynamicToolsHandle } from "../src/dynamic-tools.js";
import type { Logger } from "../src/transport.js";
import { ControllableUserInputQueue } from "../src/user-input.js";

const SILENT: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const BASE_FINGERPRINT_INPUT: AttemptFingerprintInput = {
  model: "claude-x",
  thinking: null,
  cwd: undefined,
  disallowedTools: [],
  toolAliases: {},
  fastMode: false,
  allowAll: false,
  systemPromptAppend: undefined,
  mcpServersConfig: undefined,
  dynamicTools: [],
};

/**
 * Faithful stand-in for the SDK's `Query` MCP surface. The `setMcpServers` body
 * mirrors `@anthropic-ai/claude-agent-sdk@0.3.220` exactly:
 *
 *   sdk + "instance" in cfg -> desired[name] = cfg.instance ; else passthrough
 *   disconnect every connected name absent from desired
 *   connect every desired name not already connected
 *   tell the CLI { ...passthrough, ...shapesOf(desired) }
 *
 * `connect` also does what the real CLI does on connect: issue `tools/list` and
 * remember the result, which is how these tests observe the advertised surface.
 */
class FakeSdkQuery {
  /** Every `servers` object handed to setMcpServers, by reference. */
  readonly calls: Record<string, unknown>[] = [];
  /** name -> the McpServer instance the SDK considers connected. */
  readonly connected = new Map<string, { connect(t: unknown): Promise<void> }>();
  /** name -> the live MCP client standing in for the CLI's end of the transport. */
  private readonly clients = new Map<string, Client>();
  /** name -> tool names from the most recent tools/list, i.e. what the model sees. */
  readonly listed = new Map<string, string[]>();
  /** What the CLI was last told the server set is. */
  cliServers: Record<string, unknown> = {};
  /** How many tools/list round-trips have happened, total. */
  listCount = 0;

  async setMcpServers(servers: Record<string, unknown>) {
    this.calls.push(servers);
    const desired = new Map<string, { connect(t: unknown): Promise<void> }>();
    const passthrough: Record<string, unknown> = {};
    for (const [name, cfg] of Object.entries(servers)) {
      if (
        typeof cfg === "object" &&
        cfg !== null &&
        (cfg as { type?: unknown }).type === "sdk" &&
        "instance" in (cfg as object)
      ) {
        desired.set(name, (cfg as { instance: { connect(t: unknown): Promise<void> } }).instance);
      } else {
        passthrough[name] = cfg;
      }
    }
    const removed: string[] = [];
    const added: string[] = [];
    for (const name of [...this.connected.keys()]) {
      if (!desired.has(name)) {
        await this.#disconnect(name);
        removed.push(name);
      }
    }
    for (const [name, instance] of desired) {
      if (!this.connected.has(name)) {
        await this.#connect(name, instance);
        added.push(name);
      }
    }
    const shapes: Record<string, unknown> = {};
    for (const name of desired.keys()) shapes[name] = { type: "sdk", name };
    this.cliServers = { ...passthrough, ...shapes };
    return { added, removed };
  }

  async #connect(name: string, instance: { connect(t: unknown): Promise<void> }) {
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "fake-cli", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([instance.connect(serverEnd as never), client.connect(clientEnd)]);
    this.connected.set(name, instance);
    this.clients.set(name, client);
    await this.listTools(name);
  }

  async #disconnect(name: string) {
    await this.clients.get(name)?.close();
    this.clients.delete(name);
    this.connected.delete(name);
  }

  /** Emulates the CLI issuing `tools/list` over the in-process transport. */
  async listTools(name: string): Promise<string[]> {
    const client = this.clients.get(name);
    if (!client) throw new Error(`SDK MCP server not found: ${name}`);
    this.listCount += 1;
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name);
    this.listed.set(name, names);
    return names;
  }

  /**
   * Emulates a `mcp__<server>__<tool>` invocation arriving as an `mcp_message`
   * control request. Throws the SDK's exact error when the transport is gone —
   * which is the production symptom this whole fix exists to prevent.
   */
  async callTool(name: string, tool: string, args: unknown = {}) {
    const client = this.clients.get(name);
    if (!client) throw new Error(`SDK MCP server not found: ${name}`);
    return (await client.callTool({ name: tool, arguments: args as never })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
  }
}

type Harness = {
  registry: AttemptRegistry;
  entry: AttemptEntry;
  query: FakeSdkQuery;
  handle: DynamicToolsHandle;
  bridgeCalls: string[];
};

const ALPHA = [{ name: "alpha", description: "the alpha tool" }];
const BETA = [{ name: "beta", description: "the beta tool" }];

async function makeHarness(
  initialTools: AttemptFingerprintInput["dynamicTools"] = ALPHA,
  opts: { withHandle?: boolean } = {},
): Promise<Harness> {
  const withHandle = opts.withHandle ?? true;
  const bridgeCalls: string[] = [];
  const handle = buildDynamicToolsMcpServer({
    serverName: "openclaw",
    tools: initialTools,
    bridge: async ({ tool }) => {
      bridgeCalls.push(tool);
      return { contentItems: [{ type: "inputText", text: `dispatched:${tool}` }], success: true };
    },
    logger: SILENT,
  });
  handle.ctxRef.current = { threadId: "t1", turnId: "turn-1" };

  const query = new FakeSdkQuery();
  const now = Date.now();
  const entry: AttemptEntry = {
    threadId: "t1",
    fingerprint: "fp-0",
    fingerprintInput: { ...BASE_FINGERPRINT_INPUT, dynamicTools: initialTools },
    inputQueue: new ControllableUserInputQueue(),
    abortController: new AbortController(),
    liveTurnRef: { turn: { threadId: "t1", turnId: "turn-1" } as never },
    query,
    ...(withHandle ? { dynamicTools: handle } : {}),
    currentHandler: null,
    currentReject: null,
    closed: false,
    createdAtMs: now,
    lastUsedAtMs: now,
  };

  // Establish the attempt's initial state the way turn-runner does: the server
  // is registered WITH its instance at query() construction.
  await query.setMcpServers({
    openclaw: { type: "sdk", name: "openclaw", instance: handle.instance },
  });
  query.calls.length = 0; // don't count setup against the assertions below

  const registry = new AttemptRegistry(SILENT);
  registry.set(entry.threadId, entry);
  return { registry, entry, query, handle, bridgeCalls };
}

describe("dynamic-tools setTools (openclaw-d42b defect B: the surface was immutable)", () => {
  it("tools/list serves the NEW specs after a swap", async () => {
    const { query, handle } = await makeHarness(ALPHA);
    expect(query.listed.get("openclaw")).toEqual(["alpha"]);

    handle.setTools(BETA);

    expect(handle.getTools()).toEqual(BETA);
    expect(await query.listTools("openclaw")).toEqual(["beta"]);
  });

  it("tools/call rejects a tool removed by the swap — the half that makes a policy narrowing bite", async () => {
    const { query, handle, bridgeCalls } = await makeHarness(ALPHA);
    expect((await query.callTool("openclaw", "alpha")).isError).toBe(false);
    expect(bridgeCalls).toEqual(["alpha"]);

    handle.setTools(BETA);

    const res = await query.callTool("openclaw", "alpha");
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("Unknown dynamic tool: alpha");
    // The bridge must NOT have been reached — an un-advertised-but-still-callable
    // tool is exactly the policy bypass this fixes.
    expect(bridgeCalls).toEqual(["alpha"]);

    const added = await query.callTool("openclaw", "beta");
    expect(added.isError).toBe(false);
    expect(bridgeCalls).toEqual(["alpha", "beta"]);
  });
});

describe("AttemptRegistry.refreshDynamicTools (openclaw-d42b defect A: the transport was torn down)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness(ALPHA);
  });

  it("a mcp__openclaw__* call still dispatches after a refresh", async () => {
    const result = await h.registry.refreshDynamicTools("t1", {
      // Exactly what openclaw sends today: shape only, no instance.
      servers: { openclaw: { type: "sdk", name: "openclaw" } },
      dynamicTools: BETA,
    });
    expect(result).not.toBeNull();

    // THE regression assertion. Pre-fix this threw
    // `SDK MCP server not found: openclaw`.
    const res = await h.query.callTool("openclaw", "beta");
    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).toBe("dispatched:beta");
    expect(h.bridgeCalls).toEqual(["beta"]);
  });

  it("tools/list reflects the new specs after a refresh", async () => {
    expect(h.query.listed.get("openclaw")).toEqual(["alpha"]);

    await h.registry.refreshDynamicTools("t1", {
      servers: { openclaw: { type: "sdk", name: "openclaw" } },
      dynamicTools: BETA,
    });

    // Re-listed as part of the refresh, without the test asking for it.
    expect(h.query.listed.get("openclaw")).toEqual(["beta"]);
    expect(h.query.cliServers).toEqual({ openclaw: { type: "sdk", name: "openclaw" } });
  });

  it("hands setMcpServers the owned INSTANCE, never a bare shape", async () => {
    await h.registry.refreshDynamicTools("t1", {
      servers: { openclaw: { type: "sdk", name: "openclaw" } },
      dynamicTools: BETA,
    });

    // Two phases: withdraw, then reinstate with the instance. Only the
    // reinstate may name our server, and it MUST carry `instance` — a shape-only
    // entry is what disconnects the transport.
    expect(h.query.calls).toHaveLength(2);
    expect(h.query.calls[0]).not.toHaveProperty("openclaw");
    expect(h.query.calls[1]!.openclaw).toMatchObject({ type: "sdk", name: "openclaw" });
    expect(h.query.calls[1]!.openclaw).toHaveProperty("instance", h.handle.instance);
  });

  it("re-lists only when the specs actually changed", async () => {
    const before = h.query.listCount;
    await h.registry.refreshDynamicTools("t1", {
      servers: { openclaw: { type: "sdk", name: "openclaw" } },
      dynamicTools: ALPHA, // identical to the current set
    });
    // Single call, no withdraw/reinstate churn, no re-list.
    expect(h.query.calls).toHaveLength(1);
    expect(h.query.listCount).toBe(before);
    // ...and the binding is of course still live.
    expect((await h.query.callTool("openclaw", "alpha")).isError).toBe(false);
  });

  it("does not report our own withdraw/reinstate as a server-set change", async () => {
    const result = await h.registry.refreshDynamicTools("t1", {
      servers: { openclaw: { type: "sdk", name: "openclaw" } },
      dynamicTools: BETA,
    });
    // The server was present before and after; only its tools changed.
    expect(result).toEqual({ added: [], removed: [] });
  });

  it("preserves caller-supplied non-sdk servers across both phases", async () => {
    const remote = { type: "http", url: "https://example.invalid/mcp" };
    await h.registry.refreshDynamicTools("t1", {
      servers: { openclaw: { type: "sdk", name: "openclaw" }, remote },
      dynamicTools: BETA,
    });
    expect(h.query.calls[0]).toEqual({ remote });
    expect(h.query.calls[1]).toMatchObject({ remote });
    expect(h.query.cliServers).toEqual({
      remote,
      openclaw: { type: "sdk", name: "openclaw" },
    });
  });

  it("rejects an sdk server the bridge does not own instead of forwarding it", async () => {
    // Forwarding it verbatim is the bug: the SDK would disconnect our transport
    // (the name isn't in the desired-instance set) while still advertising it.
    await expect(
      h.registry.refreshDynamicTools("t1", {
        servers: { somebody_else: { type: "sdk", name: "somebody_else" } },
        dynamicTools: BETA,
      }),
    ).rejects.toThrow(/only owns 'openclaw'/);
    // And the live binding must be untouched by the rejection.
    expect((await h.query.callTool("openclaw", "alpha")).isError).toBe(false);
  });

  it("returns null (rotate) when an sdk server is requested but the attempt has none", async () => {
    const bare = await makeHarness(ALPHA, { withHandle: false });
    expect(
      await bare.registry.refreshDynamicTools("t1", {
        servers: { openclaw: { type: "sdk", name: "openclaw" } },
        dynamicTools: BETA,
      }),
    ).toBeNull();
  });

  it("PROVES the fake reproduces the original bug: forwarding a shape-only entry kills dispatch", async () => {
    // Guards the guard. If this ever stops throwing, FakeSdkQuery has drifted
    // from the SDK's real desired-state semantics and every assertion above
    // becomes vacuous.
    await h.query.setMcpServers({ openclaw: { type: "sdk", name: "openclaw" } });
    expect(h.query.cliServers).toEqual({ openclaw: { type: "sdk", name: "openclaw" } });
    await expect(h.query.callTool("openclaw", "alpha")).rejects.toThrow(
      "SDK MCP server not found: openclaw",
    );
  });
});
