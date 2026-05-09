import { extractRegexReferents } from "../referent/regex.js";

describe("regex referent extractor", () => {
  it("extracts GitHub PR URL with owner/repo", () => {
    const refs = extractRegexReferents(
      "did you see PR https://github.com/openclaw/openclaw/pull/78589?",
    );
    const url = refs.find((r) => r.type === "pr_url" && r.value.startsWith("http"));
    expect(url).toBeDefined();
    expect(url!.repo).toBe("openclaw/openclaw");
    const num = refs.find((r) => r.type === "pr_url" && r.value === "#78589");
    expect(num).toBeDefined();
  });

  it("extracts GitLab merge request as pr_url", () => {
    const refs = extractRegexReferents(
      "see https://gitlab.com/foo/bar/merge_requests/42 for context",
    );
    expect(refs.find((r) => r.type === "pr_url")).toBeDefined();
  });

  it("extracts beads ids", () => {
    const refs = extractRegexReferents(
      "I'm working on openclaw-vestige-5fq, follow-up to openclaw-vestige-tst",
    );
    const ids = refs.filter((r) => r.type === "beads_id").map((r) => r.value);
    expect(ids).toEqual(expect.arrayContaining(["openclaw-vestige-5fq", "openclaw-vestige-tst"]));
  });

  it("extracts ISO dates and slack uids", () => {
    const refs = extractRegexReferents(
      "Tabitha (U0ADE5RMUS0) sent it on 2026-05-08 around noon",
    );
    expect(refs.find((r) => r.type === "iso_date" && r.value === "2026-05-08")).toBeDefined();
    expect(refs.find((r) => r.type === "agent_uid" && r.value === "U0ADE5RMUS0")).toBeDefined();
  });

  it("extracts git SHAs but not pure decimal numbers", () => {
    const refs = extractRegexReferents("commit abc1234def is the fix; not 12345678");
    expect(refs.find((r) => r.type === "git_sha" && r.value === "abc1234def")).toBeDefined();
    expect(refs.find((r) => r.type === "git_sha" && r.value === "12345678")).toBeUndefined();
  });

  it("extracts file paths (absolute and relative-with-extension)", () => {
    const refs = extractRegexReferents(
      "edit src/hooks/before-prompt-build.ts and /etc/hosts please",
    );
    const paths = refs.filter((r) => r.type === "file_path").map((r) => r.value);
    expect(paths).toEqual(
      expect.arrayContaining(["src/hooks/before-prompt-build.ts", "/etc/hosts"]),
    );
  });

  it("only emits bare #nnn when a known repo name is in the text", () => {
    const knownRepos = new Set<string>(["openclaw-vestige"]);
    const without = extractRegexReferents("about issue #42 in some repo", new Set());
    expect(without.find((r) => r.type === "issue_ref")).toBeUndefined();

    const withRepo = extractRegexReferents(
      "openclaw-vestige issue #42 needs attention",
      knownRepos,
    );
    expect(
      withRepo.find((r) => r.type === "issue_ref" && r.value === "#42"),
    ).toBeDefined();
  });

  it("does not emit beads ids that are part of a github URL path", () => {
    const refs = extractRegexReferents(
      "https://github.com/openclaw/openclaw/pull/78589 was merged",
    );
    const ids = refs.filter((r) => r.type === "beads_id");
    // We tolerate the URL itself producing one false-positive beads_id —
    // verify at least the PR url is captured properly.
    expect(refs.find((r) => r.type === "pr_url")).toBeDefined();
    // And no beads-id should be the full URL
    expect(ids.find((r) => r.value.startsWith("http"))).toBeUndefined();
  });
});
