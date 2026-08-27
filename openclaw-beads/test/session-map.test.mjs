import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSessionOverrideFromNotes,
  surfaceFromSessionKey,
  isLiveChannelSurface,
  pickSessionForIssue,
  readRecentAgentSessions,
  listKnownAgents,
  buildSessionMap,
} from "../dist/session-map.js";

describe("session-map: parseSessionOverrideFromNotes", () => {
  it("returns undefined for missing/empty notes", () => {
    assert.equal(parseSessionOverrideFromNotes(undefined), undefined);
    assert.equal(parseSessionOverrideFromNotes(""), undefined);
    assert.equal(parseSessionOverrideFromNotes(null), undefined);
  });

  it("extracts Session: <key> line", () => {
    const notes = [
      "Context: ~/.openclaw-tank/contexts/foo.md",
      "Session: agent:tank:discord:tank:direct:12345",
      "More notes here",
    ].join("\n");
    assert.equal(
      parseSessionOverrideFromNotes(notes),
      "agent:tank:discord:tank:direct:12345",
    );
  });

  it("ignores Session lines mid-line or with junk", () => {
    assert.equal(parseSessionOverrideFromNotes("foo Session: bar"), undefined);
    assert.equal(parseSessionOverrideFromNotes("Session: a b"), undefined); // whitespace in value
  });
});

describe("session-map: surface helpers", () => {
  it("extracts surface from sessionKey", () => {
    assert.equal(surfaceFromSessionKey("agent:tank:discord:tank:direct:1"), "discord");
    assert.equal(surfaceFromSessionKey("agent:main:cron:abc"), "cron");
    assert.equal(surfaceFromSessionKey("agent:tank:subagent:xyz"), "subagent");
    assert.equal(surfaceFromSessionKey("agent:tank:main"), "main");
  });

  it("classifies live channel surfaces", () => {
    assert.equal(isLiveChannelSurface("discord"), true);
    assert.equal(isLiveChannelSurface("slack"), true);
    assert.equal(isLiveChannelSurface("telegram"), true);
    assert.equal(isLiveChannelSurface("cron"), false);
    assert.equal(isLiveChannelSurface("subagent"), false);
    assert.equal(isLiveChannelSurface("main"), false);
  });
});

describe("session-map: pickSessionForIssue", () => {
  const liveDiscord = {
    sessionKey: "agent:tank:discord:tank:direct:1",
    agentId: "tank",
    surface: "discord",
    lastInteractionAt: 1000,
    isLiveChannel: true,
  };
  const liveSlack = {
    sessionKey: "agent:tank:slack:c1",
    agentId: "tank",
    surface: "slack",
    lastInteractionAt: 2000,
    isLiveChannel: true,
  };
  const cronOlder = {
    sessionKey: "agent:tank:cron:job1",
    agentId: "tank",
    surface: "cron",
    lastInteractionAt: 500,
    isLiveChannel: false,
  };
  const subagentNewer = {
    sessionKey: "agent:tank:subagent:abc",
    agentId: "tank",
    surface: "subagent",
    lastInteractionAt: 3000,
    isLiveChannel: false,
  };

  it("returns undefined when no candidates", () => {
    assert.equal(pickSessionForIssue({ id: "x" }, []), undefined);
  });

  it("prefers live channel over more-recent non-live", () => {
    const pick = pickSessionForIssue({ id: "x" }, [liveDiscord, subagentNewer]);
    assert.deepEqual(pick, { sessionKey: liveDiscord.sessionKey, source: "heuristic" });
  });

  it("among live channels, picks most recent", () => {
    const pick = pickSessionForIssue({ id: "x" }, [liveDiscord, liveSlack]);
    assert.deepEqual(pick, { sessionKey: liveSlack.sessionKey, source: "heuristic" });
  });

  it("among non-live, picks most recent", () => {
    const pick = pickSessionForIssue({ id: "x" }, [cronOlder, subagentNewer]);
    assert.deepEqual(pick, { sessionKey: subagentNewer.sessionKey, source: "heuristic" });
  });

  it("explicit override wins when sessionKey matches a candidate", () => {
    const issue = {
      id: "x",
      notes: "Session: agent:tank:cron:job1\nother text",
    };
    const pick = pickSessionForIssue(issue, [liveDiscord, cronOlder]);
    assert.deepEqual(pick, { sessionKey: cronOlder.sessionKey, source: "explicit" });
  });

  it("stale override falls back to heuristic", () => {
    const issue = { id: "x", notes: "Session: agent:tank:gone:long-ago" };
    const pick = pickSessionForIssue(issue, [liveDiscord, cronOlder]);
    assert.deepEqual(pick, { sessionKey: liveDiscord.sessionKey, source: "heuristic" });
  });
});

describe("session-map: readRecentAgentSessions", () => {
  it("filters by recency and returns expected SessionEntry shape", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "smap-"));
    try {
      const agentDir = join(tmp, "agents", "tank", "sessions");
      mkdirSync(agentDir, { recursive: true });
      const now = 10_000_000;
      const sessions = {
        "agent:tank:main": { lastInteractionAt: now - 100 },
        "agent:tank:discord:tank:direct:1": { lastInteractionAt: now - 50 },
        "agent:tank:cron:abc": { lastInteractionAt: now - 9999 }, // stale
        "agent:tank:bogus": "not-an-object",
        "missing-time": {},
      };
      writeFileSync(join(agentDir, "sessions.json"), JSON.stringify(sessions));
      const out = await readRecentAgentSessions(tmp, "tank", 1000, now);
      const keys = out.map((s) => s.sessionKey).sort();
      assert.deepEqual(keys, ["agent:tank:discord:tank:direct:1", "agent:tank:main"]);
      const discord = out.find((s) => s.sessionKey === "agent:tank:discord:tank:direct:1");
      assert.equal(discord.surface, "discord");
      assert.equal(discord.isLiveChannel, true);
      assert.equal(discord.agentId, "tank");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns [] when sessions.json missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "smap-"));
    try {
      const out = await readRecentAgentSessions(tmp, "tank", 1000);
      assert.deepEqual(out, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("session-map: listKnownAgents", () => {
  it("lists agent dirs ignoring dotfiles", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "smap-"));
    try {
      mkdirSync(join(tmp, "agents", "tank"), { recursive: true });
      mkdirSync(join(tmp, "agents", "main"), { recursive: true });
      mkdirSync(join(tmp, "agents", ".trust-audit-heartbeat"), { recursive: true });
      writeFileSync(join(tmp, "agents", "stray.txt"), "x");
      const agents = await listKnownAgents(tmp);
      const sorted = agents.toSorted();
      assert.deepEqual(sorted, ["main", "stray.txt", "tank"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns [] when agents/ missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "smap-"));
    try {
      const agents = await listKnownAgents(tmp);
      assert.deepEqual(agents, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("session-map: buildSessionMap (integration)", () => {
  it("binds issues to live channels, records unbound when no candidates", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "smap-"));
    try {
      // Set up fake workspace with two agents.
      const tankSessions = {
        "agent:tank:discord:tank:direct:1": { lastInteractionAt: 5000 },
        "agent:tank:cron:job1": { lastInteractionAt: 4900 },
      };
      mkdirSync(join(tmp, "agents", "tank", "sessions"), { recursive: true });
      writeFileSync(
        join(tmp, "agents", "tank", "sessions", "sessions.json"),
        JSON.stringify(tankSessions),
      );
      // narcissus has no recent sessions
      mkdirSync(join(tmp, "agents", "narcissus", "sessions"), { recursive: true });
      writeFileSync(
        join(tmp, "agents", "narcissus", "sessions", "sessions.json"),
        JSON.stringify({}),
      );

      // Set up fake beads repo (JSONL fast-path).
      const repoDir = join(tmp, "repo-foo");
      mkdirSync(join(repoDir, ".beads"), { recursive: true });
      const issues = [
        { id: "foo-001", title: "tank task with override", status: "open", assignee: "tank",
          notes: "Session: agent:tank:cron:job1\nOther stuff" },
        { id: "foo-002", title: "tank heuristic", status: "in_progress", assignee: "tank" },
        { id: "foo-003", title: "ignored: closed", status: "closed", assignee: "tank" },
        { id: "foo-004", title: "for narcissus", status: "open", assignee: "narcissus" },
        { id: "foo-005", title: "any-owner", status: "open", assignee: "any" },
        // openclaw-1lw7: unassigned is now the broadcast tier that `any` used
        // to mean, so it must bind exactly like foo-005 does.
        { id: "foo-006", title: "unassigned broadcast", status: "open" },
      ];
      writeFileSync(
        join(repoDir, ".beads", "issues.jsonl"),
        issues.map((i) => JSON.stringify(i)).join("\n"),
      );
      // Test repo (should be skipped)
      const testRepo = join(tmp, "repo-test-fixtures");
      mkdirSync(join(testRepo, ".beads"), { recursive: true });
      writeFileSync(
        join(testRepo, ".beads", "issues.jsonl"),
        JSON.stringify({ id: "tst-001", title: "ignored", status: "open", assignee: "tank" }),
      );

      const result = await buildSessionMap({
        workspaceDir: tmp,
        repos: [
          { name: "foo", path: repoDir, default: true },
          { name: "test-fixtures", path: testRepo },
        ],
        recencyMs: 60_000,
        nowMs: 10_000,
      });
      const map = result.cache;
      assert.ok(result.timings, "timings populated");
      assert.equal(typeof result.timings.totalMs, "number");
      assert.equal(typeof result.timings.readIssuesMs, "number");
      assert.ok(Array.isArray(result.timings.slowestRepos));

      // Exactly the bindings we expect:
      const tankBindings = map.bindings.filter((b) => b.agentId === "tank");
      const explicit = tankBindings.find((b) => b.issueId === "foo-001");
      assert.equal(explicit?.sessionKey, "agent:tank:cron:job1");
      assert.equal(explicit?.source, "explicit");

      const heuristic = tankBindings.find((b) => b.issueId === "foo-002");
      assert.equal(heuristic?.sessionKey, "agent:tank:discord:tank:direct:1");
      assert.equal(heuristic?.source, "heuristic");

      // foo-005 (any-owner) binds to BOTH agents that have sessions: tank
      // gets a live-channel pick; narcissus has no sessions → unbound.
      const anyForTank = map.bindings.find(
        (b) => b.issueId === "foo-005" && b.agentId === "tank",
      );
      assert.ok(anyForTank, "foo-005 should bind for tank");
      const anyForNarc = map.unbound.find(
        (u) => u.issueId === "foo-005" && u.agentId === "narcissus",
      );
      assert.ok(anyForNarc, "foo-005 should be unbound for narcissus");
      assert.equal(anyForNarc?.reason, "no-recent-sessions");

      // foo-006 (unassigned) must behave identically to foo-005 (legacy any).
      // This pins the SECOND copy of the broadcast rule, in session-map.ts,
      // against the copy in index.ts — they drifted apart is the failure mode.
      const unassignedForTank = map.bindings.find(
        (b) => b.issueId === "foo-006" && b.agentId === "tank",
      );
      assert.ok(unassignedForTank, "unassigned foo-006 should bind for tank, like any-owner foo-005");
      const unassignedForNarc = map.unbound.find(
        (u) => u.issueId === "foo-006" && u.agentId === "narcissus",
      );
      assert.ok(unassignedForNarc, "unassigned foo-006 should be unbound for narcissus, like foo-005");

      // foo-004 binds for narcissus → unbound (no sessions)
      const narc004 = map.unbound.find(
        (u) => u.issueId === "foo-004" && u.agentId === "narcissus",
      );
      assert.ok(narc004);

      // Closed issue not in either list
      assert.ok(!map.bindings.some((b) => b.issueId === "foo-003"));
      assert.ok(!map.unbound.some((u) => u.issueId === "foo-003"));

      // Test-named repo skipped entirely
      assert.ok(!map.bindings.some((b) => b.issueId === "tst-001"));
      assert.ok(!map.unbound.some((u) => u.issueId === "tst-001"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
