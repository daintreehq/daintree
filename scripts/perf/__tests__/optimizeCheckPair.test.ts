import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

/**
 * The optimize loop's gate, exercised end to end.
 *
 * `check-pair.mjs` is the one exit code that loop acts on: `perf compare` and
 * the runner both exit 0 when the apparatus is broken, so an unattended run
 * reading exit codes sees success everywhere else. That makes every branch here
 * load-bearing, and two of them were wrong before this file existed — a
 * `--max-cv` failure printed FAIL and still exited 0 with a CLAIM, because the
 * check was registered after the sweep that acts on the checks; and a negative
 * champion reading turned a regression into a percentage improvement.
 *
 * These tests drive the real script as a subprocess against synthesised summary
 * files, because the exit code IS the contract.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SKILL_DIR = join(HERE, "..", "..", "..", ".agents", "skills", "optimize");
const CHECK_PAIR = join(SKILL_DIR, "check-pair.mjs");
const PRECOMMIT = join(SKILL_DIR, "precommit.mjs");

const CHAMP_SHA = "a".repeat(40);
const CAND_SHA = "b".repeat(40);

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "optimize-gate-"));
  roots.push(root);
  return root;
}

/**
 * Arms are stamped an hour into the future, so they land AFTER any precommit
 * record a test writes. The gate requires the decision to predate the numbers,
 * and a fixed calendar date would make that assertion pass or fail depending on
 * the wall clock the suite runs at. An hour rather than a minute because this
 * file spawns a subprocess per case: a one-minute lead would turn a slow run
 * into a spurious chronology failure.
 */
const ARM_EPOCH = Date.now() + 3_600_000;

type ArmSpec = {
  label: string;
  sha: string;
  target: number;
  guard?: number;
  /** Minutes after ARM_EPOCH. Drives the interleave and chronology checks. */
  at: number;
  stdDevMs?: number;
  /** Overrides ARM_EPOCH — used to stamp an arm before the precommit record. */
  epoch?: number;
  /** `diagnostic` marks a reading the runner knows is not authoritative here. */
  applicability?: string;
};

function writeArm(dir: string, spec: ArmSpec): string {
  const path = join(dir, `${spec.label}.json`);
  const summary = {
    generatedAt: new Date((spec.epoch ?? ARM_EPOCH) + spec.at * 60_000).toISOString(),
    mode: "smoke",
    nodeVersion: "v22.13.0",
    platform: "darwin",
    label: spec.label,
    environment: {
      machineLabel: "host-test-darwin-arm64",
      platform: "darwin",
      arch: "arm64",
      cpuModel: "Test",
      cpuCount: 12,
      totalMemoryMb: 65536,
      osRelease: "25.3.0",
      nodeVersion: "v22.13.0",
      electronVersion: "42.0.0",
      gitVersion: "2.49.0",
      sourceSha: spec.sha,
    },
    protocol: { iterations: 20, warmups: 3, scenarioSelection: ["PERF-101"] },
    scenarioCount: 1,
    scenariosOutsideReference: [],
    scenariosSkipped: [],
    aggregates: [
      {
        id: "PERF-101",
        name: "Git Poll Cycle Scaling",
        description: "",
        tier: "heavy",
        runs: 20,
        p50Ms: 100,
        p95Ms: 110,
        p99Ms: 120,
        maxMs: 130,
        meanMs: 100,
        stdDevMs: spec.stdDevMs ?? 2,
        metricAverages: { gitSpawns: spec.target, residentBytes: spec.guard ?? 1000 },
        metricStats: {
          gitSpawns: {
            mean: spec.target,
            max: spec.target,
            min: spec.target,
            sum: spec.target * 20,
            count: 20,
          },
          residentBytes: {
            mean: spec.guard ?? 1000,
            max: spec.guard ?? 1000,
            min: spec.guard ?? 1000,
            sum: (spec.guard ?? 1000) * 20,
            count: 20,
          },
          refreshMisses: { mean: 0, max: 0, min: 0, sum: 0, count: 20 },
        },
        ...(spec.applicability ? { applicability: spec.applicability } : {}),
        outsideReference: false,
        measurementIssues: [],
        notes: [],
      },
    ],
  };
  writeFileSync(path, JSON.stringify(summary));
  return path;
}

/** champ, cand, cand, champ, champ, cand — the shape the gate requires. */
function writeInterleavedArms(
  dir: string,
  champ: number[],
  cand: number[],
  opts: { guardChamp?: number; guardCand?: number; stdDevMs?: number; epoch?: number } = {}
) {
  const order: Array<[string, string, number, number | undefined]> = [
    ["champ1", CHAMP_SHA, champ[0] as number, opts.guardChamp],
    ["cand1", CAND_SHA, cand[0] as number, opts.guardCand],
    ["cand2", CAND_SHA, cand[1] as number, opts.guardCand],
    ["champ2", CHAMP_SHA, champ[1] as number, opts.guardChamp],
    ["champ3", CHAMP_SHA, champ[2] as number, opts.guardChamp],
    ["cand3", CAND_SHA, cand[2] as number, opts.guardCand],
  ];
  const paths: Record<string, string> = {};
  order.forEach(([label, sha, target, guard], index) => {
    paths[label] = writeArm(dir, {
      label,
      sha,
      target,
      guard,
      at: index * 5,
      stdDevMs: opts.stdDevMs,
      epoch: opts.epoch,
    });
  });
  return paths;
}

function precommit(dir: string, extra: string[] = [], baselineSha: string = CHAMP_SHA) {
  const result = spawnSync(
    process.execPath,
    [
      PRECOMMIT,
      "--dir",
      dir,
      "--scenario",
      "PERF-101",
      "--target",
      "metricStats.gitSpawns.max",
      "--predicate",
      "refreshMisses",
      "--mode",
      "smoke",
      "--iterations",
      "20",
      "--warmups",
      "3",
      "--statistic",
      "median",
      "--threshold",
      "5",
      "--baseline-sha",
      baselineSha,
      ...extra,
    ],
    { encoding: "utf8" }
  );
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function ab(paths: Record<string, string>, extra: string[] = []) {
  const result = spawnSync(
    process.execPath,
    [
      CHECK_PAIR,
      "ab",
      "--scenario",
      "PERF-101",
      "--target",
      "metricStats.gitSpawns.max",
      "--predicate",
      "refreshMisses",
      "--threshold",
      "5",
      "--expect-champ-sha",
      CHAMP_SHA,
      "--expect-cand-sha",
      CAND_SHA,
      "--champ",
      paths.champ1 as string,
      "--champ",
      paths.champ2 as string,
      "--champ",
      paths.champ3 as string,
      "--cand",
      paths.cand1 as string,
      "--cand",
      paths.cand2 as string,
      "--cand",
      paths.cand3 as string,
      ...extra,
    ],
    { encoding: "utf8" }
  );
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe("check-pair ab verdicts", () => {
  it("claims a clean, unanimous, above-threshold win", () => {
    const dir = scratch();
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 43.6, 44.2]);
    const { status, out } = ab(paths);
    expect(out).toContain("VERDICT: CLAIM");
    expect(status).toBe(0);
  });

  it("refuses a claim when the candidate loses a pair", () => {
    const dir = scratch();
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 51, 44.2]);
    const { status, out } = ab(paths);
    expect(out).toContain("VERDICT: NO CLAIM");
    expect(status).toBe(4);
  });

  it("reports NO MEASUREMENT, not a disproof, when champion drift exceeds the ceiling", () => {
    const dir = scratch();
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 43.6, 44.2]);
    const { status, out } = ab(paths, ["--max-drift", "0.5"]);
    expect(out).toContain("VERDICT: NO MEASUREMENT");
    expect(status).toBe(5);
  });

  // Regression test: the CV check used to be registered AFTER the sweep that
  // acts on failed checks, so it printed FAIL and exited 0 with a CLAIM.
  it("fails the run when an arm's own iterations disagree beyond --max-cv", () => {
    const dir = scratch();
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 43.6, 44.2], { stdDevMs: 40 });
    const { status, out } = ab(paths, ["--max-cv", "5"]);
    expect(out).toContain("FAIL  within-arm spread under --max-cv");
    expect(out).not.toContain("VERDICT: CLAIM");
    expect(status).toBe(1);
  });

  // Regression test: with lower-is-better, -10 -> -5 is a regression that the
  // percentage arithmetic reported as a 50% improvement.
  it("refuses a negative champion reading rather than inverting the percentage", () => {
    const dir = scratch();
    const paths = writeInterleavedArms(dir, [-10, -10.1, -10.05], [-5, -5.1, -5.05]);
    const { status, out } = ab(paths);
    expect(out).toContain("FAIL  champ1: target is a usable positive reading");
    expect(status).toBe(1);
  });

  it("refuses a negative candidate reading", () => {
    const dir = scratch();
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [-1, -1.1, -1.05]);
    const { status, out } = ab(paths);
    expect(out).toContain("FAIL  cand1: target is not negative");
    expect(status).toBe(1);
  });

  // A Windows leg whose spawn observer cannot see Windows spawns still produces
  // a number; `run.ts` marks it diagnostic and nothing downstream refused it.
  it("refuses an arm the runner marked non-authoritative on this platform", () => {
    const dir = scratch();
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 43.6, 44.2]);
    paths.cand1 = writeArm(dir, {
      label: "cand1",
      sha: CAND_SHA,
      target: 44,
      at: 5,
      applicability: "diagnostic",
    });
    const { status, out } = ab(paths);
    expect(out).toContain("FAIL  cand1: scenario is authoritative on this platform");
    expect(status).toBe(1);
  });

  // A zero champion makes every percentage infinite, and usually means the
  // scenario measured nothing — which reads as the best score ever recorded.
  it("refuses a champion reading of zero", () => {
    const dir = scratch();
    const paths = writeInterleavedArms(dir, [0, 0, 0], [0, 0, 0]);
    const { status, out } = ab(paths);
    expect(out).toContain("FAIL  champ1: target is a usable positive reading");
    expect(status).toBe(1);
  });

  it("refuses arms that ran three of one side then three of the other", () => {
    const dir = scratch();
    const paths: Record<string, string> = {};
    (
      [
        ["champ1", CHAMP_SHA, 50],
        ["champ2", CHAMP_SHA, 50.4],
        ["champ3", CHAMP_SHA, 50.2],
        ["cand1", CAND_SHA, 44],
        ["cand2", CAND_SHA, 43.6],
        ["cand3", CAND_SHA, 44.2],
      ] as Array<[string, string, number]>
    ).forEach(([label, sha, target], index) => {
      paths[label] = writeArm(dir, { label, sha, target, at: index * 5 });
    });
    const { status, out } = ab(paths);
    expect(out).toContain("one side ran twice in a row");
    expect(status).toBe(1);
  });
});

describe("check-pair against a precommit record", () => {
  it("refuses a threshold that is not the precommitted one", () => {
    const dir = scratch();
    expect(precommit(dir).status).toBe(0);
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 43.6, 44.2]);
    const { status, out } = ab(paths, [
      "--precommit",
      join(dir, "precommit.json"),
      "--threshold",
      "1",
    ]);
    expect(out).toContain("FAIL  precommit: threshold");
    expect(status).toBe(1);
  });

  it("makes a guard breach a NO CLAIM rather than a green table", () => {
    const dir = scratch();
    expect(precommit(dir, ["--guard", "residentBytes:5"]).status).toBe(0);
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 43.6, 44.2], {
      guardChamp: 1000,
      guardCand: 2000,
    });
    const { status, out } = ab(paths, ["--precommit", join(dir, "precommit.json")]);
    expect(out).toContain("BREACH  residentBytes");
    expect(out).toContain("VERDICT: NO CLAIM");
    expect(status).toBe(4);
  });

  it("honours a guard trade only when it was declared BEFORE the numbers", () => {
    const dir = scratch();
    expect(
      precommit(dir, ["--guard", "residentBytes:5", "--allow-guard-regression", "residentBytes"])
        .status
    ).toBe(0);
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 43.6, 44.2], {
      guardChamp: 1000,
      guardCand: 2000,
    });
    const { status, out } = ab(paths, [
      "--precommit",
      join(dir, "precommit.json"),
      "--allow-guard-regression",
      "residentBytes",
    ]);
    expect(out).toContain("ALLOWED residentBytes");
    expect(status).toBe(0);
  });

  // The flag alone would reproduce exactly what the lock exists to prevent:
  // measure, see the breach, add the flag, re-run the same arms, call it a win.
  it("refuses a trade added on the command line but absent from the record", () => {
    const dir = scratch();
    expect(precommit(dir, ["--guard", "residentBytes:5"]).status).toBe(0);
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 43.6, 44.2], {
      guardChamp: 1000,
      guardCand: 2000,
    });
    const { status, out } = ab(paths, [
      "--precommit",
      join(dir, "precommit.json"),
      "--allow-guard-regression",
      "residentBytes",
    ]);
    expect(out).toContain(
      "FAIL  --allow-guard-regression residentBytes was declared in the record"
    );
    expect(status).toBe(1);
  });

  // Regression test: an earlier version computed the declaration lock AFTER the
  // zero-baseline branch, so every count guard reading zero on a healthy run --
  // which is most of them -- took the command-line flag on its own.
  it("holds the declaration lock for a guard whose champion reads zero", () => {
    const dir = scratch();
    expect(precommit(dir, ["--guard", "residentBytes:5"]).status).toBe(0);
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 43.6, 44.2], {
      guardChamp: 0,
      guardCand: 12,
    });
    const { status, out } = ab(paths, ["--precommit", join(dir, "precommit.json")]);
    expect(out).toContain("BREACH  residentBytes");
    expect(out).toContain("champion is zero");
    expect(status).toBe(4);
  });

  it("refuses a guard reading below zero rather than inverting its direction", () => {
    const dir = scratch();
    expect(precommit(dir, ["--guard", "residentBytes:5"]).status).toBe(0);
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 43.6, 44.2], {
      guardChamp: -10,
      guardCand: -5,
    });
    const { status, out } = ab(paths, ["--precommit", join(dir, "precommit.json")]);
    expect(out).toContain("INVALID residentBytes");
    expect(status).toBe(4);
  });

  it("refuses an allowance flag with no record to declare it", () => {
    const dir = scratch();
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 43.6, 44.2]);
    const { status, out } = ab(paths, ["--allow-guard-regression", "residentBytes"]);
    expect(out).toContain("--allow-guard-regression needs --precommit");
    expect(status).toBe(2);
  });

  it("refuses a declared trade for a guard that is not being watched", () => {
    const dir = scratch();
    const result = precommit(dir, ["--allow-guard-regression", "residentBytes"]);
    expect(result.status).toBe(2);
    expect(result.out).toContain("not one of the --guard entries");
  });

  it("fails a guard that stopped being emitted rather than reading it as a pass", () => {
    const dir = scratch();
    expect(precommit(dir, ["--guard", "vanishedMetric:5"]).status).toBe(0);
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 43.6, 44.2]);
    const { status, out } = ab(paths, ["--precommit", join(dir, "precommit.json")]);
    expect(out).toContain("ABSENT  vanishedMetric");
    expect(status).toBe(4);
  });

  // Mid-run the champion moves with every kept hypothesis, so this is opt-in —
  // but the ONE comparison that produces the reported number must be against
  // the branch point, and this is what pins that.
  it("refuses a headline whose champion is not the precommitted branch point", () => {
    const dir = scratch();
    expect(precommit(dir, [], "c".repeat(40)).status).toBe(0);
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 43.6, 44.2]);

    const withoutFlag = ab(paths, ["--precommit", join(dir, "precommit.json")]);
    expect(withoutFlag.status).toBe(0);

    const headline = ab(paths, ["--precommit", join(dir, "precommit.json"), "--headline"]);
    expect(headline.out).toContain("FAIL  precommit: headline champion is the branch point");
    expect(headline.status).toBe(1);
  });

  it("accepts a headline measured at the precommitted branch point", () => {
    const dir = scratch();
    expect(precommit(dir).status).toBe(0);
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 43.6, 44.2]);
    const { status } = ab(paths, ["--precommit", join(dir, "precommit.json"), "--headline"]);
    expect(status).toBe(0);
  });

  it("refuses arms that were measured before the decision was written", () => {
    const dir = scratch();
    expect(precommit(dir).status).toBe(0);
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 43.6, 44.2], {
      epoch: Date.now() - 86_400_000,
    });
    const { status, out } = ab(paths, ["--precommit", join(dir, "precommit.json")]);
    expect(out).toContain("FAIL  precommit: the decision predates every arm");
    expect(status).toBe(1);
  });

  it("refuses a forced record unless the overwrite is acknowledged", () => {
    const dir = scratch();
    expect(precommit(dir).status).toBe(0);
    expect(precommit(dir, ["--force"]).status).toBe(0);
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 43.6, 44.2]);

    const refused = ab(paths, ["--precommit", join(dir, "precommit.json")]);
    expect(refused.out).toContain("FAIL  precommit: record was not forced over an earlier one");
    expect(refused.status).toBe(1);

    const acknowledged = ab(paths, [
      "--precommit",
      join(dir, "precommit.json"),
      "--allow-forced-precommit",
    ]);
    expect(acknowledged.status).toBe(0);
  });

  it("requires the headline champion to be the precommitted branch point", () => {
    const dir = scratch();
    expect(precommit(dir).status).toBe(0);
    const paths = writeInterleavedArms(dir, [50, 50.4, 50.2], [44, 43.6, 44.2]);
    // The record's baselineSha is CHAMP_SHA, which the arms carry, so --headline
    // passes here and would fail against a mid-run champion.
    const { status } = ab(paths, ["--precommit", join(dir, "precommit.json"), "--headline"]);
    expect(status).toBe(0);
  });

  it("refuses to rewrite an existing record without --force", () => {
    const dir = scratch();
    expect(precommit(dir).status).toBe(0);
    const second = precommit(dir);
    expect(second.status).toBe(2);
    expect(second.out).toContain("That file is the lock");
  });

  it("refuses a tail statistic below the sample count it would need", () => {
    const dir = scratch();
    const result = spawnSync(
      process.execPath,
      [
        PRECOMMIT,
        "--dir",
        dir,
        "--scenario",
        "PERF-101",
        "--target",
        "p95Ms",
        "--predicate",
        "refreshMisses",
        "--mode",
        "smoke",
        "--iterations",
        "20",
        "--warmups",
        "3",
        "--statistic",
        "median",
        "--threshold",
        "5",
        "--baseline-sha",
        CHAMP_SHA,
      ],
      { encoding: "utf8" }
    );
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain("Covering the p95 needs about 59 samples");
  });

  it("refuses maxMs at any sample count", () => {
    const dir = scratch();
    const result = spawnSync(
      process.execPath,
      [
        PRECOMMIT,
        "--dir",
        dir,
        "--scenario",
        "PERF-101",
        "--target",
        "maxMs",
        "--predicate",
        "refreshMisses",
        "--mode",
        "smoke",
        "--iterations",
        "500",
        "--warmups",
        "3",
        "--statistic",
        "median",
        "--threshold",
        "5",
        "--baseline-sha",
        CHAMP_SHA,
      ],
      { encoding: "utf8" }
    );
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain("single largest sample");
  });
});
