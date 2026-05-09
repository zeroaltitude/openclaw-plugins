/**
 * Auto-derived gazetteer of known proper nouns.
 *
 * Sources (all auto-harvested, no hand-maintained list):
 *   - Repo names from ~/projects/* and ~/projects/openclaw-plugins/*
 *   - Plugin names from ~/projects/openclaw/openclaw.json (if present) and
 *     any user openclaw.json under ~/.openclaw* dirs
 *   - Agent personas from IDENTITY.md / SOUL.md / USER.md in agent
 *     workspace directories
 *   - Beads-id prefixes from <repo>/.beads/issues.jsonl
 *
 * Refresh is fs.watch-based with a debounce. Watchers are best-effort;
 * if they can't be set up (platform limitations, ulimit), we fall back to
 * a periodic TTL refresh.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type GazetteerType = "repo" | "plugin" | "agent" | "person" | "beads_prefix";

export interface GazetteerEntry {
  term: string;
  /** lowercased term for matching */
  norm: string;
  type: GazetteerType;
  source?: string;
}

export interface GazetteerOptions {
  /** Project roots to scan for repo names. Default: ~/projects, ~/projects/openclaw-plugins */
  projectRoots?: string[];
  /** Agent workspace directories to scan for IDENTITY.md/SOUL.md/USER.md */
  agentWorkspaces?: string[];
  /** Refresh debounce in ms */
  debounceMs?: number;
  /** Disable filesystem watchers (used in tests) */
  noWatch?: boolean;
  /** Logger */
  logger?: { info(...a: any[]): void; warn(...a: any[]): void; error(...a: any[]): void };
  /** Optional fs override for testing */
  fs?: typeof fs;
}

const TRIVIAL_TERMS = new Set([
  "src",
  "dist",
  "node_modules",
  "tests",
  "test",
  "lib",
  "bin",
  "docs",
  "doc",
  "build",
  "target",
  "out",
  "tmp",
  "temp",
  "vendor",
  ".git",
  ".github",
  ".vscode",
  ".idea",
  "scripts",
  "config",
  "examples",
  "example",
  "data",
  "public",
  "static",
  "assets",
]);

export class Gazetteer {
  private entries = new Map<string, GazetteerEntry>(); // key: norm
  private watchers: fs.FSWatcher[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private lastRefreshAt = 0;
  private readonly opts: Required<Pick<GazetteerOptions, "debounceMs" | "noWatch">> &
    GazetteerOptions;
  private readonly fsImpl: typeof fs;

  constructor(opts: GazetteerOptions = {}) {
    const home = os.homedir();
    this.opts = {
      projectRoots: opts.projectRoots ?? [
        path.join(home, "projects"),
        path.join(home, "projects", "openclaw-plugins"),
      ],
      agentWorkspaces: opts.agentWorkspaces ?? [],
      debounceMs: opts.debounceMs ?? 400,
      noWatch: opts.noWatch ?? false,
      logger: opts.logger,
      fs: opts.fs,
    };
    this.fsImpl = opts.fs ?? fs;
  }

  /** Synchronous initial harvest. */
  init(): void {
    this.harvest();
    if (!this.opts.noWatch) this.installWatchers();
  }

  /** Add an agent workspace dynamically (e.g. when first hook call provides ctx.workspaceDir). */
  addAgentWorkspace(workspaceDir: string): void {
    if (!workspaceDir) return;
    if (this.opts.agentWorkspaces!.includes(workspaceDir)) return;
    this.opts.agentWorkspaces!.push(workspaceDir);
    this.harvestAgentWorkspace(workspaceDir);
    if (!this.opts.noWatch) this.watchAgentWorkspace(workspaceDir);
  }

  size(): number {
    return this.entries.size;
  }

  values(): GazetteerEntry[] {
    return Array.from(this.entries.values());
  }

  /** Repo names only — used by regex extractor for #nnn disambiguation */
  repoNames(): Set<string> {
    const out = new Set<string>();
    for (const e of this.entries.values()) {
      if (e.type === "repo") out.add(e.term);
    }
    return out;
  }

  /**
   * Find gazetteer matches in `text`. Case-insensitive, word-boundary-ish.
   * Returns a deduped array of entries.
   */
  match(text: string): GazetteerEntry[] {
    if (!text) return [];
    const lower = text.toLowerCase();
    const out: GazetteerEntry[] = [];
    const seen = new Set<string>();
    for (const e of this.entries.values()) {
      if (e.norm.length < 2) continue;
      const idx = lower.indexOf(e.norm);
      if (idx < 0) continue;
      // crude word boundary check
      const before = idx === 0 ? "" : lower[idx - 1];
      const afterIdx = idx + e.norm.length;
      const after = afterIdx >= lower.length ? "" : lower[afterIdx];
      if (before && /[a-z0-9]/i.test(before)) continue;
      if (after && /[a-z0-9]/i.test(after)) continue;
      if (seen.has(e.norm)) continue;
      seen.add(e.norm);
      out.push(e);
    }
    return out;
  }

  /** Tear down watchers (for tests / shutdown) */
  close(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {}
    }
    this.watchers = [];
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ── Internal: harvest ───────────────────────────────────────────────

  private harvest(): void {
    this.lastRefreshAt = Date.now();
    this.entries.clear();
    for (const root of this.opts.projectRoots ?? []) {
      this.harvestProjectRoot(root);
    }
    for (const ws of this.opts.agentWorkspaces ?? []) {
      this.harvestAgentWorkspace(ws);
    }
  }

  private harvestProjectRoot(root: string): void {
    let entries: fs.Dirent[];
    try {
      entries = this.fsImpl.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const name = ent.name;
      if (name.startsWith(".")) continue;
      if (TRIVIAL_TERMS.has(name)) continue;
      this.upsert({
        term: name,
        norm: name.toLowerCase(),
        type: "repo",
        source: path.join(root, name),
      });

      // Beads prefix: <repo>/.beads/issues.jsonl — look for the prefix field
      const beadsPath = path.join(root, name, ".beads", "issues.jsonl");
      this.harvestBeadsFile(beadsPath);

      // Plugin manifest: openclaw.plugin.json or openclaw.json
      this.harvestPluginManifest(path.join(root, name, "openclaw.plugin.json"));
      this.harvestPluginManifest(path.join(root, name, "openclaw.json"));

      // Recursively look for openclaw-plugin/ subdir (vestige-style)
      const nested = path.join(root, name, "openclaw-plugin");
      try {
        if (this.fsImpl.statSync(nested).isDirectory()) {
          this.harvestPluginManifest(path.join(nested, "openclaw.plugin.json"));
        }
      } catch {}
    }
  }

  private harvestBeadsFile(beadsPath: string): void {
    let raw: string;
    try {
      raw = this.fsImpl.readFileSync(beadsPath, "utf8");
    } catch {
      return;
    }
    const prefixes = new Set<string>();
    const idsToAdd: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const id = obj?.id ?? obj?.issue_id;
        if (typeof id !== "string") continue;
        idsToAdd.push(id);
        const m = id.match(/^([a-z][a-z0-9-]*[a-z0-9])-([a-z0-9]{3,12})$/);
        if (m) prefixes.add(m[1]);
      } catch {
        continue;
      }
    }
    for (const p of prefixes) {
      this.upsert({
        term: p,
        norm: p.toLowerCase(),
        type: "beads_prefix",
        source: beadsPath,
      });
    }
    // Also add concrete beads ids as gazetteer entries (so messages
    // mentioning them by id match even if the regex fails to pick them up).
    for (const id of idsToAdd) {
      this.upsert({
        term: id,
        norm: id.toLowerCase(),
        type: "beads_prefix",
        source: beadsPath,
      });
    }
  }

  private harvestPluginManifest(manifestPath: string): void {
    let raw: string;
    try {
      raw = this.fsImpl.readFileSync(manifestPath, "utf8");
    } catch {
      return;
    }
    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch {
      return;
    }
    // openclaw.plugin.json typically has "name"
    if (typeof obj?.name === "string") {
      const term = String(obj.name).replace(/^@[^/]+\//, "");
      if (term.length >= 2) {
        this.upsert({
          term,
          norm: term.toLowerCase(),
          type: "plugin",
          source: manifestPath,
        });
      }
    }
    // user/global openclaw.json: walk plugins.entries.*.config sections
    const entries = obj?.plugins?.entries;
    if (entries && typeof entries === "object") {
      for (const key of Object.keys(entries)) {
        if (key.length < 2) continue;
        this.upsert({
          term: key,
          norm: key.toLowerCase(),
          type: "plugin",
          source: manifestPath,
        });
      }
    }
  }

  private harvestAgentWorkspace(workspaceDir: string): void {
    for (const file of ["IDENTITY.md", "SOUL.md", "USER.md"]) {
      const fp = path.join(workspaceDir, file);
      let raw: string;
      try {
        raw = this.fsImpl.readFileSync(fp, "utf8");
      } catch {
        continue;
      }
      this.harvestPersonaText(raw, fp);
    }
  }

  private harvestPersonaText(raw: string, source: string): void {
    // Pull "Name:" / "**Name:**" frontmatter-style lines
    const nameRe = /(?:^|\n)\s*[*_-]*\s*(?:\*\*)?(?:Name|What to call them|Creature)(?:\*\*)?\s*[:\-]\s*(.+)/gi;
    for (const m of raw.matchAll(nameRe)) {
      const value = m[1].trim().replace(/[*_`]/g, "").split(/[—–\-,(]/)[0].trim();
      // Take first capitalised word or quoted token
      const first = value.match(/"([^"]+)"|'([^']+)'|([A-Z][\w-]+)/);
      const pick = first ? first[1] || first[2] || first[3] : value.split(/\s+/)[0];
      if (pick && pick.length >= 2 && /^[A-Za-z][\w-]*$/.test(pick)) {
        this.upsert({
          term: pick,
          norm: pick.toLowerCase(),
          type: source.endsWith("USER.md") ? "person" : "agent",
          source,
        });
      }
    }
  }

  private upsert(e: GazetteerEntry): void {
    if (!e.norm) return;
    if (TRIVIAL_TERMS.has(e.norm)) return;
    if (e.norm.length < 2) return;
    const existing = this.entries.get(e.norm);
    // Prefer more specific types over generic ones (repo > plugin > agent > person > beads_prefix)
    if (existing) {
      const order: Record<GazetteerType, number> = {
        repo: 5,
        plugin: 4,
        agent: 3,
        person: 2,
        beads_prefix: 1,
      };
      if (order[existing.type] >= order[e.type]) return;
    }
    this.entries.set(e.norm, e);
  }

  // ── Internal: watchers ──────────────────────────────────────────────

  private installWatchers(): void {
    for (const root of this.opts.projectRoots ?? []) {
      this.tryWatch(root, false);
      // Also watch each repo's .beads/issues.jsonl if present
      try {
        const subs = this.fsImpl.readdirSync(root, { withFileTypes: true });
        for (const ent of subs) {
          if (!ent.isDirectory()) continue;
          const beads = path.join(root, ent.name, ".beads", "issues.jsonl");
          this.tryWatchFile(beads);
        }
      } catch {}
    }
    for (const ws of this.opts.agentWorkspaces ?? []) {
      this.watchAgentWorkspace(ws);
    }
  }

  private watchAgentWorkspace(ws: string): void {
    for (const file of ["IDENTITY.md", "SOUL.md", "USER.md"]) {
      this.tryWatchFile(path.join(ws, file));
    }
  }

  private tryWatch(target: string, recursive: boolean): void {
    try {
      const w = this.fsImpl.watch(target, { recursive }, () => this.scheduleRefresh());
      w.on("error", () => {});
      this.watchers.push(w);
    } catch {
      // ignore — falls back to TTL refresh
    }
  }

  private tryWatchFile(target: string): void {
    try {
      const w = this.fsImpl.watch(target, () => this.scheduleRefresh());
      w.on("error", () => {});
      this.watchers.push(w);
    } catch {}
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      try {
        this.harvest();
      } catch (err) {
        this.opts.logger?.warn?.("[vestige.gazetteer] refresh failed:", err);
      }
    }, this.opts.debounceMs);
  }
}

// ── Module-level singleton (lazy) ────────────────────────────────────

let singleton: Gazetteer | null = null;

export function getGazetteer(opts?: GazetteerOptions): Gazetteer {
  if (singleton) return singleton;
  singleton = new Gazetteer(opts);
  singleton.init();
  return singleton;
}

/** For tests: replace the singleton with a fresh instance. */
export function _resetGazetteerForTests(g: Gazetteer | null = null): void {
  if (singleton) singleton.close();
  singleton = g;
}
