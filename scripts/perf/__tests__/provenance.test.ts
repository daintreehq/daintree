import { describe, expect, it } from "vitest";
import { describeEnvironment } from "../run";

/** Either a resolved version (`42.7.1`) or the declared range (`^42.7.0`). */
const ELECTRON_PATTERN = /\d+\.\d+\.\d+/;
const GIT_VERSION_PATTERN = /^\d+(?:\.\d+)+$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{7,40}(?:-dirty(?:-unknown)?)?$/;

describe("describeEnvironment — provenance", () => {
  it("records the three provenance fields", () => {
    const environment = describeEnvironment("test-machine");
    expect(Object.keys(environment)).toEqual(
      expect.arrayContaining(["electronVersion", "gitVersion", "sourceSha"])
    );
  });

  it("reports the Electron version the harness measures against, not the one it runs under", () => {
    // The perf suite runs under plain Node via tsx, so `process.versions.electron`
    // is undefined here. Reading it would record "no Electron" on every run.
    expect(process.versions.electron).toBeUndefined();
    const { electronVersion } = describeEnvironment("test-machine");
    expect(electronVersion).not.toBeNull();
    expect(electronVersion).toMatch(ELECTRON_PATTERN);
  });

  it("records a parsed git version and a source SHA in a real checkout", () => {
    const { gitVersion, sourceSha } = describeEnvironment("test-machine");
    expect(gitVersion).not.toBeNull();
    expect(gitVersion).toMatch(GIT_VERSION_PATTERN);
    expect(sourceSha).not.toBeNull();
    expect(sourceSha).toMatch(SOURCE_SHA_PATTERN);
  });

  it("never throws, and every null it returns carries a note", () => {
    // Provenance is a label on the results, never a reason to fail a run — but
    // a silently-null field would let a results file quietly lose the ability
    // to be diffed against another, so an absence has to say so.
    const notes: string[] = [];
    const environment = describeEnvironment("test-machine", notes);
    const nulls = (["electronVersion", "gitVersion", "sourceSha"] as const).filter(
      (key) => environment[key] === null
    );
    if (nulls.length > 0) expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((note) => typeof note === "string")).toBe(true);
  });

  it("is bounded — a provenance probe cannot stall a run", { timeout: 30_000 }, () => {
    const started = Date.now();
    describeEnvironment("test-machine");
    // Three probes, each capped at 5s, with generous headroom for a cold FS.
    expect(Date.now() - started).toBeLessThan(25_000);
  });

  it("leaves the pre-existing environment fields untouched", () => {
    const environment = describeEnvironment("greg-macbook");
    expect(environment.machineLabel).toBe("greg-macbook");
    expect(environment.platform).toBe(process.platform);
    expect(environment.arch).toBe(process.arch);
    expect(environment.nodeVersion).toBe(process.version);
  });
});
