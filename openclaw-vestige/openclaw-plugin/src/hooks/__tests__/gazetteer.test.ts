import * as path from "path";
import { Gazetteer } from "../referent/gazetteer.js";

/**
 * Build a minimal in-memory fake of the node fs API surface the gazetteer
 * uses (readdirSync, readFileSync, statSync, watch).
 */
function makeFakeFs(layout: Record<string, string | { dir: true }>) {
  const isDir = (p: string) => layout[p] && typeof layout[p] === "object";
  const childrenOf = (root: string): { name: string; dir: boolean }[] => {
    const out: { name: string; dir: boolean }[] = [];
    const seen = new Set<string>();
    const norm = root.endsWith("/") ? root : root + "/";
    for (const key of Object.keys(layout)) {
      if (!key.startsWith(norm)) continue;
      const rest = key.slice(norm.length);
      if (rest.length === 0) continue;
      const first = rest.split("/")[0];
      if (seen.has(first)) continue;
      seen.add(first);
      const fullChild = norm + first;
      out.push({ name: first, dir: isDir(fullChild) || rest.includes("/") });
    }
    return out;
  };
  return {
    readdirSync(p: string, opts: any) {
      const items = childrenOf(p);
      if (opts && opts.withFileTypes) {
        return items.map((i) => ({
          name: i.name,
          isDirectory: () => i.dir,
          isFile: () => !i.dir,
        }));
      }
      return items.map((i) => i.name);
    },
    readFileSync(p: string, _enc: string) {
      const v = layout[p];
      if (typeof v !== "string") throw new Error("ENOENT " + p);
      return v;
    },
    statSync(p: string) {
      const v = layout[p];
      if (!v) throw new Error("ENOENT " + p);
      return {
        isDirectory: () => typeof v === "object",
        isFile: () => typeof v === "string",
      };
    },
    watch(_p: string, _o: any, _cb: any) {
      return { close() {}, on() {} } as any;
    },
  } as any;
}

describe("Gazetteer", () => {
  it("harvests repo names from project roots", () => {
    const fakeFs = makeFakeFs({
      "/projects": { dir: true },
      "/projects/openclaw": { dir: true },
      "/projects/bh-ai": { dir: true },
      "/projects/dist": { dir: true }, // trivial, should be filtered
    });
    const gz = new Gazetteer({
      projectRoots: ["/projects"],
      noWatch: true,
      fs: fakeFs,
    });
    gz.init();
    const repos = gz.repoNames();
    expect(repos.has("openclaw")).toBe(true);
    expect(repos.has("bh-ai")).toBe(true);
    expect(repos.has("dist")).toBe(false);
  });

  it("harvests beads-id prefixes from .beads/issues.jsonl", () => {
    const beadsContent =
      JSON.stringify({ id: "openclaw-vestige-tst" }) +
      "\n" +
      JSON.stringify({ id: "openclaw-vestige-5fq" }) +
      "\n";
    const fakeFs = makeFakeFs({
      "/projects": { dir: true },
      "/projects/openclaw-vestige": { dir: true },
      "/projects/openclaw-vestige/.beads": { dir: true },
      "/projects/openclaw-vestige/.beads/issues.jsonl": beadsContent,
    });
    const gz = new Gazetteer({
      projectRoots: ["/projects"],
      noWatch: true,
      fs: fakeFs,
    });
    gz.init();
    const terms = gz.values().map((e) => e.term);
    expect(terms).toEqual(expect.arrayContaining(["openclaw-vestige", "openclaw-vestige-tst"]));
  });

  it("matches gazetteer terms case-insensitively at word boundaries", () => {
    const fakeFs = makeFakeFs({
      "/projects": { dir: true },
      "/projects/openclaw-vestige": { dir: true },
    });
    const gz = new Gazetteer({
      projectRoots: ["/projects"],
      noWatch: true,
      fs: fakeFs,
    });
    gz.init();
    const matches = gz.match("OpenClaw-Vestige is the plugin we ship");
    expect(matches.find((m) => m.norm === "openclaw-vestige")).toBeDefined();
  });

  it("harvests agent personas from IDENTITY.md/SOUL.md/USER.md", () => {
    const ws = "/home/agent";
    const fakeFs = makeFakeFs({
      "/projects": { dir: true },
      [ws]: { dir: true },
      [path.join(ws, "IDENTITY.md")]: "- **Name:** Tank\n- **Creature:** Engineer",
      [path.join(ws, "USER.md")]: "- **Name:** Eddie\n- **Role:** CIO",
    });
    const gz = new Gazetteer({
      projectRoots: ["/projects"],
      agentWorkspaces: [ws],
      noWatch: true,
      fs: fakeFs,
    });
    gz.init();
    const terms = gz.values().map((e) => e.term);
    expect(terms).toEqual(expect.arrayContaining(["Tank", "Eddie"]));
  });
});
