import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { REGISTRY } from "../registry";

/**
 * `perf calibrate` answers the question every threshold depends on and nobody
 * had measured: how much does this number move when nothing changed?
 *
 * The CLI surface is what is asserted here rather than a full run, which spawns
 * a scenario several times and belongs in the hands of whoever is reading the
 * spread. What matters mechanically is that a bad invocation is refused rather
 * than silently producing a figure from the wrong scenario or too few rounds.
 */

const execFileAsync = promisify(execFile);
const perfDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(perfDir, "..", "..");

async function calibrate(args: string[]): Promise<{ code: number; stderr: string }> {
  try {
    const { stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", path.join(perfDir, "calibrate.ts"), ...args],
      { cwd: repoRoot }
    );
    return { code: 0, stderr };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? -1, stderr: failure.stderr ?? "" };
  }
}

describe("perf calibrate", () => {
  it("is reachable from the dispatcher", () => {
    // A benchmark tool nobody can find is one nobody uses — the same rule the
    // registry coverage test enforces for the specs.
    expect(REGISTRY.calibrate).toBeDefined();
    expect(REGISTRY.calibrate!.kind).toBe("diagnostic");
  });

  it("requires a scenario, like every other command here", { timeout: 60_000 }, async () => {
    const { code, stderr } = await calibrate([]);
    expect(code).toBe(1);
    expect(stderr).toContain("--scenario is required");
  });

  it("refuses too few rounds to show a spread", { timeout: 60_000 }, async () => {
    // Quartiles from four samples are two samples wearing a statistical name,
    // and a range from two runs is both of them.
    for (const rounds of ["2", "4"]) {
      const { code, stderr } = await calibrate(["--scenario", "PERF-036", "--rounds", rounds]);
      expect(code).toBe(1);
      expect(stderr).toContain("cannot show a spread");
    }
  });

  it("rejects an unknown flag rather than ignoring it", { timeout: 60_000 }, async () => {
    // Same stance as `run.ts`: a typo'd flag must never look like a clean run.
    const { code, stderr } = await calibrate(["--scenario", "PERF-036", "--round", "5"]);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown flag");
  });

  it("rejects an unknown mode", { timeout: 60_000 }, async () => {
    const { code, stderr } = await calibrate(["--scenario", "PERF-036", "--mode", "hourly"]);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown --mode");
  });
});
