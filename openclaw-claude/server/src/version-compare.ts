/**
 * Returns negative if `version` is below `minimum`, zero if equal, positive
 * if above. Prerelease/build metadata is stripped before comparison.
 * Returns -1 when `version` is undefined so callers treat unknown versions
 * as too old.
 */
export function compareServerVersion(
  version: string | undefined,
  minimum: string,
): number {
  if (!version) return -1;
  const parse = (v: string) => {
    // Strip both prerelease (`-`) and build-metadata (`+`) suffixes before
    // tokenizing into numeric segments.
    const main = v.split(/[+-]/, 1)[0] ?? "0";
    return main.split(".").map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
  };
  const lhs = parse(version);
  const rhs = parse(minimum);
  for (let i = 0; i < Math.max(lhs.length, rhs.length); i++) {
    const a = lhs[i] ?? 0;
    const b = rhs[i] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}
