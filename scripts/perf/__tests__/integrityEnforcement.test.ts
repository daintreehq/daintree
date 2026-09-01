import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { collectIntegrityIssues, parseArgs } from "../run";
import type { PerfRunSummary } from "../types";

/**
 * Does `--enforce-integrity` actually change the exit code, and only for the
 * right reason?
 *
 * The suite's stance — never fail a run because a number got worse — was being
 * read as "never fail a run", which meant a benchmark whose oracle had died
 * exited 0 and looked exactly like a healthy one. The flag separates the two
 * questions: evidence quality can fail closed while numeric drift stays
 * advisory. Both halves are asserted here as a subprocess, because an exit code
 * is the one thing an in-process test cannot observe.
 *
 * The broken evidence is produced honestly: a budgets file naming a metric the
 * scenario does not emit, which is the real "a configured reference stopped
 * meaning anything" case, not a mock.
 */

const execFileAsync = promisify(execFile);
const perfDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(perfDir, "..", "..");

/** Cheap, deterministic, and reports its own predicates cleanly. */
const SCENARIO = "PERF-036";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-integrity-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", path.join(perfDir, "run.ts"), ...args],
      { cwd: repoRoot }
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** A budgets file whose ceiling names a metric no scenario emits. */
function brokenBudgets(): string {
  const dir = tempDir();
  const file = path.join(dir, "budgets.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      defaultBudget: { maxRegressionPct: 25 },
      scenarios: {
        [SCENARIO]: { maxMetricValues: { aMetricNothingEmits: 1 } },
      },
    })
  );
  return file;
}

function baseArgs(outDir: string): string[] {
  return [
    "--mode",
    "smoke",
    "--scenario",
    SCENARIO,
    "--iterations",
    "1",
    "--warmups",
    "0",
    "--out-dir",
    outDir,
  ];
}

function readSummary(outDir: string): PerfRunSummary {
  return JSON.parse(
    fs.readFileSync(path.join(outDir, "latest-smoke.summary.json"), "utf-8")
  ) as PerfRunSummary;
}

describe("--enforce-integrity", () => {
  it("is parsed as a switch and defaults to off", () => {
    expect(parseArgs(["--scenario", SCENARIO]).enforceIntegrity).toBe(false);
    expect(parseArgs(["--scenario", SCENARIO, "--enforce-integrity"]).enforceIntegrity).toBe(true);
    expect(() => parseArgs(["--scenario", SCENARIO, "--enforce-integrity=yes"])).toThrow(
      /takes no value/
    );
  });

  it(
    "exits 0 and records a valid verdict when the evidence is sound",
    { timeout: 180_000 },
    async () => {
      const outDir = tempDir();
      const { code, stdout, stderr } = await runCli([...baseArgs(outDir), "--enforce-integrity"]);

      // The issues are in the message, not just the exit code. A bare
      // `expect(code).toBe(0)` failing under a loaded suite reports "expected 1
      // to be 0" and nothing about WHICH measurement broke, which is the one
      // fact needed to tell a real regression from a busy machine.
      expect(code, `integrity failed:\n${stderr}`).toBe(0);
      expect(stdout).toContain("integrity: ok");

      const summary = readSummary(outDir);
      expect(summary.integrity?.enforced).toBe(true);
      expect(summary.integrity?.valid).toBe(true);
      expect(summary.integrity?.issues).toEqual([]);
    }
  );

  it(
    "exits 1 when a configured metric has stopped being emitted",
    { timeout: 180_000 },
    async () => {
      const outDir = tempDir();
      const { code, stderr } = await runCli([
        ...baseArgs(outDir),
        "--budgets",
        brokenBudgets(),
        "--enforce-integrity",
      ]);

      expect(code).toBe(1);
      expect(stderr).toContain("INTEGRITY FAILURE");
      // The message has to say what did NOT cause the failure, because the
      // reflex on seeing a red perf run is to assume the numbers moved.
      expect(stderr).toContain("Numeric drift is still advisory");

      const summary = readSummary(outDir);
      expect(summary.integrity?.valid).toBe(false);
      expect(summary.integrity?.issues.join(" ")).toContain("aMetricNothingEmits");
      // Results are still written: a failing integrity verdict is a reason to
      // look at the evidence, not a reason to throw it away.
      expect(summary.aggregates).toHaveLength(1);
    }
  );

  it("leaves the same broken run at exit 0 without the flag", { timeout: 180_000 }, async () => {
    const outDir = tempDir();
    const { code, stdout } = await runCli([...baseArgs(outDir), "--budgets", brokenBudgets()]);

    // The default stance is unchanged. Every existing caller keeps exiting 0.
    expect(code).toBe(0);
    expect(stdout).toContain("measurement-issues=1");

    const summary = readSummary(outDir);
    expect(summary.integrity?.enforced).toBe(false);
    expect(summary.integrity?.valid).toBe(false);
  });

  it(
    "refuses to promote a broken measurement into the baseline",
    { timeout: 180_000 },
    async () => {
      const outDir = tempDir();
      const baselinePath = path.join(tempDir(), "baseline.smoke.json");
      fs.writeFileSync(
        baselinePath,
        JSON.stringify({ generatedAt: new Date().toISOString(), mode: "smoke", scenarios: {} })
      );

      const { code, stderr } = await runCli([
        ...baseArgs(outDir),
        "--budgets",
        brokenBudgets(),
        "--baseline",
        baselinePath,
        "--update-baseline",
      ]);

      expect(code).toBe(0);
      expect(stderr).toContain("NOT updating the baseline");

      // The reference every later run would have been read against.
      const written = JSON.parse(fs.readFileSync(baselinePath, "utf-8")) as {
        scenarios?: Record<string, unknown>;
      };
      expect(written.scenarios?.[SCENARIO]).toBeUndefined();
    }
  );

  it("treats a run that measured nothing as broken evidence, not sound evidence", () => {
    // Every selected scenario being `unsupported` here exits 0 by design, and
    // that stays true without the flag. Under enforcement it must not: an empty
    // result satisfies every other check vacuously, the way an empty page has
    // no typos. Asserted against the pure helper so the rule holds on every
    // platform rather than only on one that happens to own an unsupported
    // scenario.
    const empty = collectIntegrityIssues([], 1, "win32");
    expect(empty).toHaveLength(1);
    expect(empty[0]).toContain("no scenario produced a measurement");
    expect(empty[0]).toContain("win32");

    expect(
      collectIntegrityIssues([{ id: SCENARIO, measurementIssues: [], runs: 1 }], 0, "darwin")
    ).toEqual([]);
  });

  it("treats an aggregate that measured zero iterations the same way", () => {
    // The same emptiness one level down: every per-metric check passes over an
    // empty sample set and the row renders as an ordinary result.
    const issues = collectIntegrityIssues(
      [{ id: SCENARIO, measurementIssues: [], runs: 0 }],
      0,
      "darwin"
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("nothing was measured");
  });

  it("prefixes every issue with the scenario it came from", () => {
    // The issues land in one flat list on the summary, so without the id a
    // reader cannot tell which measurement is the broken one.
    expect(
      collectIntegrityIssues(
        [
          { id: "PERF-036", measurementIssues: ["predicate x was never emitted"], runs: 1 },
          { id: "PERF-163", measurementIssues: ["y non-finite", "z reported misses"], runs: 1 },
        ],
        0,
        "darwin"
      )
    ).toEqual([
      "PERF-036: predicate x was never emitted",
      "PERF-163: y non-finite",
      "PERF-163: z reported misses",
    ]);
  });

  it("counts a workload shortfall as broken evidence", () => {
    // The distinct failure: a scenario that built less than it claims reports a
    // BETTER number with every correctness predicate at zero, because the part
    // that ran behaved perfectly. It reaches the integrity verdict through
    // `measurementIssues` like any other broken measurement.
    const issues = collectIntegrityIssues(
      [
        {
          id: "PERF-034",
          measurementIssues: ['workload shortfall: "floodBytes" fell to 61000 against a floor'],
          runs: 2,
        },
      ],
      0,
      "darwin"
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("PERF-034: workload shortfall");
  });

  it("still promotes a sound measurement", { timeout: 180_000 }, async () => {
    const outDir = tempDir();
    const baselinePath = path.join(tempDir(), "baseline.smoke.json");
    fs.writeFileSync(
      baselinePath,
      JSON.stringify({ generatedAt: new Date().toISOString(), mode: "smoke", scenarios: {} })
    );

    const { code } = await runCli([
      ...baseArgs(outDir),
      "--baseline",
      baselinePath,
      "--update-baseline",
    ]);

    expect(code).toBe(0);
    const written = JSON.parse(fs.readFileSync(baselinePath, "utf-8")) as {
      scenarios?: Record<string, { p95Ms: number }>;
    };
    expect(written.scenarios?.[SCENARIO]?.p95Ms).toBeGreaterThan(0);
  });
});
