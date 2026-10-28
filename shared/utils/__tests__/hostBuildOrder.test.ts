import { describe, expect, it } from "vitest";
import { compareReleaseVersions, hostBuildOrder } from "../hostBuildOrder.js";

const client = { version: "0.46.0", commit: "abc123" };

describe("hostBuildOrder", () => {
  it("calls a host that took a release first newer, and one left behind older", () => {
    expect(hostBuildOrder({ version: "0.47.0", commit: "def456" }, client)).toBe("newer");
    expect(hostBuildOrder({ version: "0.45.2", commit: "def456" }, client)).toBe("older");
    // Numeric, not lexical: 0.100 came after 0.46.
    expect(hostBuildOrder({ version: "0.100.0", commit: null }, client)).toBe("newer");
  });

  it("is the same build only with the same version and commit", () => {
    expect(hostBuildOrder({ version: "0.46.0", commit: "abc123" }, client)).toBe("same");
    expect(hostBuildOrder({ version: "0.46.0", commit: "def456" }, client)).toBe("unordered");
    expect(hostBuildOrder({ version: "0.46.0", commit: null }, client)).toBe("unordered");
  });

  it("orders nightlies by their prerelease tag and before their release", () => {
    const nightly = { version: "0.47.0-nightly.20261021", commit: "n1" };
    expect(hostBuildOrder({ version: "0.47.0-nightly.20261022", commit: "n2" }, nightly)).toBe(
      "newer"
    );
    expect(hostBuildOrder({ version: "0.47.0", commit: "r1" }, nightly)).toBe("newer");
    expect(hostBuildOrder({ version: "0.46.0", commit: "r0" }, nightly)).toBe("older");
  });

  it("orders nothing it can't read as a version", () => {
    expect(hostBuildOrder({ version: "dev", commit: "x" }, client)).toBe("unordered");
    expect(
      hostBuildOrder(
        { version: "0.47.0+local", commit: "x" },
        { version: "0.47.0+ci", commit: "y" }
      )
    ).toBe("unordered");
  });
});

describe("compareReleaseVersions", () => {
  it("says which release came first, or null when either can't be read", () => {
    expect(Math.sign(compareReleaseVersions("1.10.0", "1.9.0")!)).toBe(1);
    expect(Math.sign(compareReleaseVersions("1.9.0", "1.10.0")!)).toBe(-1);
    expect(compareReleaseVersions("1.9.0", "1.9.0")).toBe(0);
    expect(compareReleaseVersions("1.9", "1.9.0")).toBeNull();
  });
});
