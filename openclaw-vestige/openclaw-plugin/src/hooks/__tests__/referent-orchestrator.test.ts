import {
  extractReferents,
  buildSearchQuery,
  shouldSearchMemory,
  pickMemoryTag,
} from "../referent/index.js";
import { Gazetteer } from "../referent/gazetteer.js";

describe("shouldSearchMemory (cheap salience gate)", () => {
  it("rejects very short and trivial messages", () => {
    expect(shouldSearchMemory("ok")).toBe(false);
    expect(shouldSearchMemory("thanks")).toBe(false);
    expect(shouldSearchMemory("lol!")).toBe(false);
    expect(shouldSearchMemory("hi there")).toBe(false);
    expect(shouldSearchMemory("👍👍")).toBe(false);
  });

  it("accepts substantive messages", () => {
    expect(
      shouldSearchMemory("did you see PR https://github.com/openclaw/openclaw/pull/78589?"),
    ).toBe(true);
    expect(shouldSearchMemory("remember my anniversary is March 5th")).toBe(true);
  });
});

describe("extractReferents (regex + gazetteer; keybert disabled)", () => {
  function emptyGazetteer(): Gazetteer {
    const fakeFs = {
      readdirSync: () => [],
      readFileSync: () => {
        throw new Error("ENOENT");
      },
      statSync: () => {
        throw new Error("ENOENT");
      },
      watch: () => ({ close() {}, on() {} }),
    } as any;
    const gz = new Gazetteer({
      projectRoots: ["/nonexistent"],
      noWatch: true,
      fs: fakeFs,
    });
    gz.init();
    return gz;
  }

  it("returns regex referents for a PR-bearing message", async () => {
    const gz = emptyGazetteer();
    const refs = await extractReferents(
      "did you see PR https://github.com/openclaw/openclaw/pull/78589?",
      { gazetteer: gz, enableKeybert: false },
    );
    expect(refs.find((r) => r.value.includes("/pull/78589"))).toBeDefined();
    expect(refs.find((r) => r.value === "#78589")).toBeDefined();
  });

  it("dedupes overlapping values across layers", async () => {
    // Build a tiny gazetteer that contains "openclaw-vestige-tst" via beads
    const beadsContent = JSON.stringify({ id: "openclaw-vestige-tst" }) + "\n";
    const fakeFs = {
      readdirSync: (p: string, opts: any) => {
        if (p === "/projects") {
          const items = [{ name: "openclaw-vestige", dir: true }];
          return opts?.withFileTypes
            ? items.map((i) => ({
                name: i.name,
                isDirectory: () => i.dir,
                isFile: () => !i.dir,
              }))
            : items.map((i) => i.name);
        }
        return [];
      },
      readFileSync: (p: string) => {
        if (p === "/projects/openclaw-vestige/.beads/issues.jsonl") return beadsContent;
        throw new Error("ENOENT " + p);
      },
      statSync: (p: string) => {
        if (p === "/projects/openclaw-vestige") {
          return { isDirectory: () => true, isFile: () => false };
        }
        throw new Error("ENOENT " + p);
      },
      watch: () => ({ close() {}, on() {} }),
    } as any;
    const gz = new Gazetteer({
      projectRoots: ["/projects"],
      noWatch: true,
      fs: fakeFs,
    });
    gz.init();
    const refs = await extractReferents(
      "let's revisit openclaw-vestige-tst when ready",
      { gazetteer: gz, enableKeybert: false },
    );
    const tst = refs.filter((r) => r.value.toLowerCase() === "openclaw-vestige-tst");
    expect(tst.length).toBe(1);
    // regex layer should win the dedupe
    expect(tst[0].source).toBe("regex");
  });
});

describe("buildSearchQuery", () => {
  it("returns the user-message slice when there are no referents", () => {
    expect(buildSearchQuery("hello world", [])).toBe("hello world");
  });

  it("appends only referents that are not already present in the slice", () => {
    const refs = [
      { type: "pr_url" as const, value: "#78589", source: "regex" as const },
      { type: "beads_id" as const, value: "openclaw-vestige-5fq", source: "regex" as const },
    ];
    const q = buildSearchQuery("did you see #78589 in vestige?", refs);
    // #78589 already present in slice → not appended
    expect(q).not.toMatch(/#78589 .* #78589/);
    expect(q).toContain("openclaw-vestige-5fq");
  });
});

describe("pickMemoryTag", () => {
  it("falls back to 'memory' when nothing extracted", () => {
    expect(pickMemoryTag([])).toBe("memory");
  });

  it("uses the first referent's type:value", () => {
    const tag = pickMemoryTag([
      { type: "pr_url", value: "#78589", source: "regex" },
    ]);
    expect(tag).toBe("pr_url:#78589");
  });
});
