/**
 * Regex-based referent extractor.
 *
 * Pulls structured ids out of free text — URLs, issue refs, file paths,
 * Beads ids, git SHAs, ISO dates, slack/discord uids. These are the
 * "deterministic high-value" referents. No model required.
 */

export type ReferentType =
  | "pr_url"
  | "issue_url"
  | "issue_ref"
  | "file_path"
  | "beads_id"
  | "git_sha"
  | "iso_date"
  | "agent_uid"
  | "url";

export interface Referent {
  type: ReferentType;
  value: string;
  /** Optional repo context (for issue_ref / pr_url / issue_url disambiguation) */
  repo?: string;
}

// PR/issue URLs from GitHub/GitLab. Captures owner, repo, kind, number.
const PR_URL_RE =
  /\bhttps?:\/\/(?:www\.)?(?:github|gitlab)\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|merge_requests|issues)\/(\d+)\b/gi;

// Bare #nnn issue refs — only emit when a repo name appears nearby (handled
// at the extraction layer where the gazetteer is available).
const ISSUE_REF_RE = /(?:^|[\s(\[])#(\d{1,6})\b/g;

// Beads ids: <prefix>-<short-id>, e.g. openclaw-vestige-tst, bh-ai-5fq
// Prefix: lowercase letters and dashes (>=1 segment). Suffix: 3-12 alnum.
const BEADS_ID_RE = /\b([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)-([a-z0-9]{3,12})\b/g;

// Git SHAs (7-40 hex chars). Word-boundary anchored to avoid eating long hex.
const GIT_SHA_RE = /\b([0-9a-f]{7,40})\b/g;

// ISO 8601 dates (date-only or with time)
const ISO_DATE_RE =
  /\b(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?(?:Z|[+-]\d{2}:?\d{2})?)\b/g;

// Slack/Discord uids: U + 10+ uppercase alnum chars (slack form). Discord
// snowflakes are 17-19 digits — separate matcher.
const SLACK_UID_RE = /\b(U[A-Z0-9]{8,})\b/g;
const DISCORD_SNOWFLAKE_RE = /\b<@!?(\d{17,20})>/g;

// File paths: absolute (/foo/bar) or repo-relative with at least one slash
// and a recognizable extension OR a clear path prefix.
// Conservative: require a leading "./", "../", "/" or "~/" OR contain a slash
// AND end with a typical extension.
const PATH_ABS_RE = /(?:^|[\s(])((?:~\/|\/|\.\.?\/)[\w./@~+-]+)(?=$|[\s)\],.;:!?])/g;
const PATH_RELATIVE_RE =
  /\b([\w.-]+(?:\/[\w.-]+)+\.(?:ts|tsx|js|jsx|py|md|json|yaml|yml|toml|sh|rs|go|c|h|cpp|hpp|html|css|sql))\b/g;

// Generic URL fallback (catches any remaining http/https not matched as PR/issue)
const URL_RE = /\bhttps?:\/\/[^\s)>\]]+/g;

// Common false positives in BEADS/SHA matchers — exclude obvious words
const SHA_BLOCKLIST = new Set([
  "deadbeef",
  "abcdef0",
  "feedface",
  "cafebabe",
  "fa11back",
]);

function pushUnique(out: Referent[], r: Referent): void {
  for (const existing of out) {
    if (existing.type === r.type && existing.value === r.value) return;
  }
  out.push(r);
}

/**
 * Extract structured referents from a piece of text.
 *
 * @param text         user message
 * @param knownRepos   optional set of repo names from gazetteer; used to
 *                     disambiguate bare `#nnn` refs (only emitted if a
 *                     known repo name appears in the same message).
 */
export function extractRegexReferents(
  text: string,
  knownRepos?: Set<string>,
): Referent[] {
  const out: Referent[] = [];
  if (!text || text.length === 0) return out;

  // PR / merge request URLs
  for (const m of text.matchAll(PR_URL_RE)) {
    const [, owner, repo, num] = m;
    const url = m[0];
    const isPR = /\/(?:pull|merge_requests)\//i.test(url);
    pushUnique(out, {
      type: isPR ? "pr_url" : "issue_url",
      value: url,
      repo: `${owner}/${repo}`,
    });
    pushUnique(out, {
      type: isPR ? "pr_url" : "issue_url",
      value: `#${num}`,
      repo: `${owner}/${repo}`,
    });
  }

  // Bare #nnn — only emit if we recognise a repo name in the text
  if (knownRepos && knownRepos.size > 0) {
    let matchedRepo: string | undefined;
    for (const repo of knownRepos) {
      if (repo.length < 2) continue;
      const re = new RegExp(`\\b${repo.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
      if (re.test(text)) {
        matchedRepo = repo;
        break;
      }
    }
    if (matchedRepo) {
      for (const m of text.matchAll(ISSUE_REF_RE)) {
        pushUnique(out, { type: "issue_ref", value: `#${m[1]}`, repo: matchedRepo });
      }
    }
  }

  // Beads ids
  for (const m of text.matchAll(BEADS_ID_RE)) {
    const value = m[0];
    // Skip if it overlaps with a URL match (e.g. github.com path segments)
    if (/https?:\/\//i.test(text.slice(Math.max(0, m.index! - 8), m.index!))) continue;
    pushUnique(out, { type: "beads_id", value });
  }

  // Git SHAs (avoid obvious words and ISO-date adjacencies)
  for (const m of text.matchAll(GIT_SHA_RE)) {
    const v = m[1];
    if (SHA_BLOCKLIST.has(v.toLowerCase())) continue;
    // Skip hex strings that are actually parts of dates/numbers — require at
    // least one a-f letter to count as a "real" sha. (Pure-decimal would be
    // a year/number, not a sha.)
    if (!/[a-f]/i.test(v)) continue;
    pushUnique(out, { type: "git_sha", value: v });
  }

  // ISO dates
  for (const m of text.matchAll(ISO_DATE_RE)) {
    pushUnique(out, { type: "iso_date", value: m[1] });
  }

  // Slack uids
  for (const m of text.matchAll(SLACK_UID_RE)) {
    pushUnique(out, { type: "agent_uid", value: m[1] });
  }
  for (const m of text.matchAll(DISCORD_SNOWFLAKE_RE)) {
    pushUnique(out, { type: "agent_uid", value: m[1] });
  }

  // File paths
  for (const m of text.matchAll(PATH_ABS_RE)) {
    pushUnique(out, { type: "file_path", value: m[1] });
  }
  for (const m of text.matchAll(PATH_RELATIVE_RE)) {
    pushUnique(out, { type: "file_path", value: m[1] });
  }

  // Generic URLs that weren't already captured as PR/issue urls
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0];
    if (out.some((r) => r.value === url)) continue;
    pushUnique(out, { type: "url", value: url });
  }

  return out;
}
