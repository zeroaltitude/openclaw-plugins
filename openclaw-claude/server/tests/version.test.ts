import { describe, expect, it } from "vitest";

import { compareServerVersion } from "../src/version-compare.js";

describe("compareServerVersion", () => {
  it("returns 0 for equal versions", () => {
    expect(compareServerVersion("1.2.3", "1.2.3")).toBe(0);
  });

  it("returns negative when version is below minimum", () => {
    expect(compareServerVersion("1.2.2", "1.2.3")).toBeLessThan(0);
    expect(compareServerVersion("1.1.999", "1.2.0")).toBeLessThan(0);
    expect(compareServerVersion("0.9.0", "1.0.0")).toBeLessThan(0);
  });

  it("returns positive when version is above minimum", () => {
    expect(compareServerVersion("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareServerVersion("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });

  it("treats missing version as below minimum", () => {
    expect(compareServerVersion(undefined, "0.0.1")).toBe(-1);
  });

  it("strips prerelease/build metadata before comparing", () => {
    expect(compareServerVersion("1.2.3-beta.1", "1.2.3")).toBe(0);
    expect(compareServerVersion("1.2.3+build.42", "1.2.3")).toBe(0);
  });

  it("treats non-numeric segments as zero", () => {
    expect(compareServerVersion("1.x.0", "1.0.0")).toBe(0);
  });
});
