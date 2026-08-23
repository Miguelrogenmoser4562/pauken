import { describe, expect, it } from "vitest";
import { compareVersions, isNewer } from "./updates";

describe("compareVersions", () => {
  it("treats equal versions as equal", () => {
    expect(compareVersions("0.3.0", "0.3.0")).toBe(0);
    expect(compareVersions("v0.3.0", "0.3.0")).toBe(0);
    expect(compareVersions("0.3", "0.3.0")).toBe(0);
  });

  it("orders numeric segments", () => {
    expect(compareVersions("0.3.1", "0.3.0")).toBeGreaterThan(0);
    expect(compareVersions("0.3.0", "0.4.0")).toBeLessThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
  });

  it("handles extra segments", () => {
    expect(compareVersions("0.3.0.1", "0.3.0")).toBeGreaterThan(0);
    expect(compareVersions("0.3.0", "0.3.0.1")).toBeLessThan(0);
  });

  it("ignores prerelease suffixes", () => {
    expect(compareVersions("0.4.0-beta.1", "0.3.9")).toBeGreaterThan(0);
    expect(compareVersions("0.3.0-rc.2", "0.3.0")).toBe(0);
  });
});

describe("isNewer", () => {
  it("detects newer versions", () => {
    expect(isNewer("0.3.0", "0.4.0")).toBe(true);
    expect(isNewer("0.3.0", "v0.3.1")).toBe(true);
  });

  it("rejects equal or older versions", () => {
    expect(isNewer("0.3.0", "0.3.0")).toBe(false);
    expect(isNewer("0.4.0", "0.3.0")).toBe(false);
  });
});
