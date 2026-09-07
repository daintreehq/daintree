import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { allScenarios } from "../scenarios";
import { TIMING_DEPENDENT_TERMS } from "./timingDependentTerms";

/**
 * Does every scenario in the matrix still RUN?
 *
 * Nothing else in this suite executes a scenario's `run()`. The rest of the
 * perf tests check the oracles, the aggregation, the CLI and the baselines —
 * all of which stay green while a scenario is dead, because a scenario that
 * throws on its first line is invisible until somebody types its id. That is
 * how PERF-320..325, PERF-057/058 and PERF-360..364 sat broken: thirteen
 * scenarios, 8% of the matrix, killed by ONE line — `installModuleStubs()` at
 * module scope in `lib/cliAvailabilityFixture.ts`, which registers a
 * process-global resolve hook that answers for `electron` and `electron/store`
 * in every perf run, whichever id `--scenario` names.
 *
 * WHAT THIS GUARD PROVES
 *   Each scenario's `run()` completes once and returns a sample in which
 *   (a) every metric is finite, (b) every metric key declared in `correctness`
 *   is emitted AND reads exactly 0, and (c) the duration the runner would
 *   record is a positive measurement contained inside the bracket the driver
 *   spent calling `run()`.
 *
 *   (b) and (c) are what make "it ran" mean something. Key presence alone does
 *   not: strip a subject's `onProgress` and the declared keys still come back,
 *   carrying 16 and 4 misses. Every correctness metric is a MISS COUNT, so a
 *   healthy run is 0 BY CONSTRUCTION — it is a structural fact about the
 *   predicate, not a threshold about the machine, so asserting it cannot make
 *   this guard timing-sensitive. Every scenario driven here reports 0 on every
 *   declared term; none needed an exemption.
 *
 * WHAT IT DOES NOT PROVE
 *   Nothing about the NUMBERS. A scenario whose subject got 10x slower passes
 *   here. This is a liveness check, not a measurement: it answers "is this
 *   benchmark still a benchmark", which is the one question the harness could
 *   not previously answer about itself.
 *
 *   Nor can it prove the predicate is an ORACLE. A scenario rewritten to
 *   hardcode `{ someMisses: 0 }` and a plausible small duration satisfies every
 *   rule below, and no check outside the scenario can tell that apart from a
 *   real reading — the same limit `README.md` states about decorative
 *   predicates. What the duration rules do close is the shape that has actually
 *   bitten: a stub that keeps the keys and stops doing the work is
 *   near-instant, so a hardcoded duration is either the `0` sentinel (rejected
 *   for any scenario not named in WALL_CLOCK_TIMED) or a constant larger than
 *   the bracket it was measured in (rejected by containment).
 *
 * CONSIDERED AND REJECTED: RUNNING EACH SCENARIO TWICE
 *   A hardcoded duration is identical across two runs and a real measurement
 *   essentially never is, so a second `run()` in the same child would catch the
 *   one case containment cannot: a constant SMALLER than the bracket. It was
 *   built and measured rather than argued about. It works — across every
 *   scenario no pair of runs produced the same `durationMs`, and every one
 *   tolerated the repeat — and it costs 67s against 55s, +22%, on every
 *   `npm test`.
 *
 *   Rejected on what the second run does, not on what it checks. It doubles
 *   this guard's side-effect surface inside the unit suite: every real
 *   subprocess spawn, temp git tree, SIGKILL and port bind happens twice, in a
 *   file that already runs four children at once beside Vitest's own workers.
 *   That trades a small, never-observed defect (a scenario hardcoding a
 *   plausible duration — the historical one hardcoded `0`, which is caught
 *   above) for a larger, ordinary class of flake. Two scenarios say so
 *   outright: PERF-046 and PERF-224 declare `warmups: 0`, so repeating them is
 *   something the harness's own authors declined to do.
 *
 * WHY CHILD PROCESSES
 *   Every fixture that loads main-process code installs its module-resolution
 *   hooks behind `if (process.env.VITEST) return;`, because Vite resolves
 *   imports itself and the hooks never fire in a Vitest worker. Calling `run()`
 *   in-process here would load the real `electron` graph and fail for reasons
 *   that have nothing to do with the scenario. So each scenario is driven by
 *   `scenarioSmokeDriver.ts` under `node --import tsx`, one process per
 *   scenario — which is also exactly how `run.ts` drives them, so a pass here
 *   is a pass there.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERF_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(PERF_ROOT, "../..");
const DRIVER = path.join(HERE, "scenarioSmokeDriver.ts");

/**
 * Scenarios this guard deliberately does NOT run, and why.
 *
 * EIGHT are excluded on cost: a single `run()` costing more than ~12 seconds on
 * the reference machine (M-series macOS, serial). Each is expensive BY DESIGN —
 * it idles for a fixed wall-clock window, or builds real multi-worktree git
 * topologies — so no amount of harness work makes it cheap, and a guard that
 * waited for them would cost ~5 minutes and get switched off. Their entries
 * carry the measured serial cost of ONE `run()`, so the next person can
 * re-judge the trade rather than inherit it, and so an entry that stops being
 * expensive is visible rather than permanent.
 *
 * The NINTH, PERF-004, is not a cost exclusion at all: it launches the
 * packaged binary, so it cannot run without a `npm run package` build under
 * `release/` that no test environment has. Cheap or not, there is nothing here
 * for it to drive.
 *
 * All nine are a REAL GAP, and exactly as capable of dying silently as the
 * thirteen that did. Run them by hand after touching `lib/idleWindow*`,
 * `lib/gitPipeline*`, `lib/worktreeSidebar*` or `pty/ImagePathProbe`:
 *   npx tsx scripts/perf/__tests__/scenarioSmokeDriver.ts PERF-092
 */
const EXPENSIVE_SCENARIOS: Readonly<Record<string, string>> = {
  "PERF-004": "launches the packaged binary; needs a `npm run package` build under release/",
  "PERF-092": "~20s — idles a real ProcessTreeCache for a fixed 15s window",
  "PERF-093": "~24s — an 8s broken-probe window plus the recovery window after it",
  "PERF-094": "~27s — twenty WorktreeMonitors idled at the 5000ms performance cadence",
  "PERF-105": "~17s — a fixed 10s idle window on an armed git watcher",
  "PERF-106": "~17s — the same 10s idle window, after a transient probe failure",
  "PERF-138": "~19s — builds real 1/5/20/50-worktree git topologies before it measures",
  "PERF-247":
    "~15s — spawns vitest to mount the real lists, so driving it from inside `npm test` " +
    "would nest one vitest run in another. Its subject is covered directly instead, by " +
    "`scripts/perf/renderer/__tests__/reviewListsBench.test.tsx`, which runs here every time " +
    "and asserts the same windowing oracle at a size cheap enough to afford.",
  "PERF-405":
    "~62s — the 40 reads a 1500ms poll makes in a minute, against a failing PID, plus a drain for the last arm's children; a shorter window cannot show the backoff ladder still spacing retries in its back half",
};

/**
 * Scenarios that are dead RIGHT NOW, with the diagnosis. Not an exemption —
 * an inventory, asserted in both directions: a listed scenario that starts
 * running fails this test and tells you to delete its line.
 *
 * Empty. It held seven — PERF-057, PERF-058 and PERF-360..364 — all killed by
 * one cross-fixture stub leak: `lib/cliAvailabilityFixture.ts` registered its
 * resolve hook at MODULE SCOPE, and `scenarios/index.ts` imports every scenario
 * module eagerly, so PERF-393/394's `electron` and `/electron/store` stubs were
 * live in every perf process and (hooks run last-registered-first) won the
 * specifier from the fixtures that actually needed it. That hook is now
 * registered lazily from `loadCliModules()`, so it exists only in the runs that
 * asked for it, and all seven measure again.
 */
const KNOWN_DEAD: Readonly<Record<string, string>> = {};

/**
 * Scenarios that decline to self-time, and why — named, because otherwise the
 * duration rule cannot exist.
 *
 * `run.ts:799` substitutes its own wall-clock bracket for any non-positive
 * `durationMs`: `sample.durationMs > 0 ? sample.durationMs : wallClockMs`. That
 * sentinel is legitimate, and these scenarios use it on purpose. It is also,
 * character for character, what a scenario rewritten to hardcode
 * `durationMs: 0` returns — the shape that zeroed a p95 once already, when a
 * `>= 0` filter read the sentinel as a measurement.
 *
 * Nothing in the sample distinguishes the two, so they are separated BY NAME.
 * Every scenario not listed here must return a positive self-measured duration;
 * every scenario listed here must still be returning the sentinel. Both
 * directions fail loudly: adopting the sentinel means adding a line and saying
 * why, and a listed scenario that starts self-timing means deleting one.
 *
 * Only scenarios this guard actually drives are listed. PERF-092/093/094 and
 * PERF-105/106 also use the sentinel and are not here, because they are excluded
 * above and never run.
 */
const WALL_CLOCK_TIMED: Readonly<Record<string, string>> = {
  "PERF-020": "-1 — one synchronous replay pass; the whole run() body is the measurement",
  "PERF-021": "-1 — one synchronous replay pass; the whole run() body is the measurement",
  "PERF-022": "-1 — one synchronous replay pass; the whole run() body is the measurement",
  "PERF-023": "-1 — one synchronous replay pass; the whole run() body is the measurement",
  "PERF-024": "-1 — one synchronous replay pass; the whole run() body is the measurement",
  "PERF-030": "-1 — the pipeline plans ARE the bracket; no sub-timing to report",
  "PERF-031": "-1 — the pipeline plans ARE the bracket; no sub-timing to report",
  "PERF-032": "-1 — the pipeline plans ARE the bracket; no sub-timing to report",
  "PERF-033": "-1 — the pipeline plans ARE the bracket; no sub-timing to report",
  "PERF-034": "-1 — the pipeline plans ARE the bracket; no sub-timing to report",
  "PERF-035": "-1 — the awaited fleet sweep is the workload; cost is reported as cpuMs metrics",
  "PERF-042":
    "0 — reports event-loop lag; its own elapsed time is the synthetic load, not a reading",
  "PERF-074": "0 — counts only: no renderer, so no phase on the switch path has an honest duration",
  "PERF-075": "0 — counts only: no renderer, so no phase on the switch path has an honest duration",
  "PERF-076": "0 — counts only: no renderer, so no phase on the switch path has an honest duration",
  "PERF-077": "0 — counts only: no renderer, so no phase on the switch path has an honest duration",
  "PERF-409": "0 — census transport reports spawn counts and CPU totals over a fixed idle window",
};

/**
 * Slack on the containment rule, in milliseconds.
 *
 * A scenario's own bracket is nested inside the driver's, so a real measurement
 * can never exceed it — same process, same `performance.now()`. One millisecond
 * absorbs the one honest way that could read false: a scenario timing itself
 * with `Date.now()`, which quantizes to whole milliseconds and can round its
 * bracket up past the driver's on a sub-millisecond run. It is nowhere near
 * wide enough to admit a hardcoded constant: the widest real ratio measured
 * across the whole matrix is 0.993.
 */
const CONTAINMENT_SLACK_MS = 1;

/** Ceiling for one scenario's child. Generous: the pool runs several at once. */
const CHILD_TIMEOUT_MS = 120_000;

/**
 * Windows runs one child at a time. Its hosted runners pay much more for large
 * temp trees and native watcher/process startup; overlapping those children
 * caused access violations and three 120-second false liveness timeouts.
 * macOS/Linux use two: pools of three or four reproduced transient `git add`
 * failures in the large-tree fixtures while also starving unrelated timer
 * tests during the full suite.
 */
const concurrencyCeiling = process.platform === "win32" ? 1 : 2;
const CONCURRENCY = Math.max(1, Math.min(concurrencyCeiling, availableParallelism() - 1));

/**
 * The Windows pool is deliberately serial, so its full scenario sweep can
 * legitimately outlast the 15-minute allowance used by the parallel POSIX
 * pool. Individual children still have the two-minute deadline above: this
 * wider outer bracket permits the expected queue, not an unbounded child.
 */
const LIVENESS_TIMEOUT_MS = process.platform === "win32" ? 30 * 60_000 : 15 * 60_000;

interface DriverResult {
  id: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

/**
 * The child must NOT look like a Vitest process: every fixture disables its
 * module hooks when `VITEST` is set, so an inherited flag would silently turn
 * each scenario into a run against the real electron module graph.
 *
 * `DAINTREE_USER_DATA` goes too. `vitest.setup.ts` points it at one directory
 * per worker pid, and every fixture that needs a user-data root takes an
 * inherited value in preference to minting its own — so the whole pool would
 * share a single `daintree.db`. Two children opening that database at the same
 * time both read an empty `__drizzle_migrations` and both apply the same
 * migration, and the loser dies on `duplicate column name` before its scenario
 * runs. Unset, each child mints its own temp root.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("VITEST")) continue;
    if (key === "DAINTREE_USER_DATA") continue;
    env[key] = value;
  }
  return env;
}

function runScenario(id: string): Promise<DriverResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--expose-gc", "--import", "tsx", DRIVER, id], {
      cwd: REPO_ROOT,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CHILD_TIMEOUT_MS);

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ id, exitCode, timedOut, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
}

async function runPool(ids: readonly string[]): Promise<Map<string, DriverResult>> {
  const results = new Map<string, DriverResult>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const id = ids[index];
      if (id === undefined) return;
      results.set(id, await runScenario(id));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

/**
 * What to print for a failed child.
 *
 * The driver's own JSON line is preferred, because it carries the scenario's
 * error rather than the module graph's. When it is absent the child died before
 * the driver's catch — a broken import, usually — and the first few stderr
 * lines are the only evidence there is, so print several: a single line of a
 * module-resolution stack names a file in the chain and not the cause.
 */
function explain(result: DriverResult): string {
  if (result.timedOut) return `timed out after ${CHILD_TIMEOUT_MS}ms`;
  const line = result.stdout
    .split("\n")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .at(-1);
  if (line !== undefined) {
    try {
      const parsed = JSON.parse(line) as { message?: string };
      if (typeof parsed.message === "string") {
        const messageLines = parsed.message
          .split("\n")
          .map((raw) => raw.trim())
          .filter(Boolean)
          .slice(0, 5);
        if (messageLines.length > 0) return messageLines.join(" | ");
      }
    } catch {
      // Not the driver's JSON line — fall through to stderr.
    }
  }
  const stderrLines = result.stderr
    .split("\n")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (stderrLines.length === 0) return `exit code ${String(result.exitCode)} with no output`;
  return `died before the scenario ran (exit ${String(result.exitCode)}): ${stderrLines.join(" | ")}`;
}

/** The driver's JSON line. Everything it reports is judged below, not there. */
interface DriverReport {
  missingCorrectness?: string[];
  /** Declared workload floors naming a metric the scenario never emitted. */
  missingWorkload?: string[];
  /** Floors the sample fell short of, as `metric=value < floor`. */
  workloadShortfalls?: string[];
  /** Value of every declared correctness metric the sample actually emitted. */
  correctness?: Record<string, number>;
  /** What the scenario says it measured. Non-positive is the sentinel. */
  durationMs?: number;
  /** The driver's own bracket around `run()`, unrounded. */
  elapsedMs?: number;
}

function parseOk(result: DriverResult): DriverReport | null {
  const line = result.stdout
    .split("\n")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .at(-1);
  if (line === undefined) return null;
  try {
    return JSON.parse(line) as DriverReport;
  } catch {
    return null;
  }
}

/**
 * Everything wrong with one scenario's sample, as sentences.
 *
 * Collected rather than short-circuited: a scenario that has both stopped
 * measuring and started missing should say both, because "durationMs is 0" on
 * its own reads as a sentinel question and reads very differently beside 16
 * misses.
 */
function verdicts(id: string, report: DriverReport): string[] {
  const problems: string[] = [];

  const missing = report.missingCorrectness ?? [];
  if (missing.length > 0) {
    problems.push(`${id} ran but emitted no ${missing.join(", ")} — declared in correctness`);
  }

  // Every correctness metric is a miss count, so a healthy run is 0. This is
  // the term that catches a subject that still returns the right SHAPE while
  // having stopped doing the work.
  //
  // The scenario/term pairs in TIMING_DEPENDENT_TERMS are exempt. They are not weaker predicates — through
  // `run.ts` they grade exactly like the rest, and a real defect still moves
  // them. They are exempt HERE because this guard runs four children at a time
  // inside the unit suite, and a term whose expectation is "the timer had not
  // fired yet" slips when the box is loaded. Asserting them here would make the
  // guard flaky, and a flaky guard gets switched off — which would cost the
  // other ~800 terms it does check. Named, not hidden, and asserted in both
  // directions below so an entry cannot outlive its cause.
  const nonZero = Object.entries(report.correctness ?? {}).filter(
    ([key, value]) => value !== 0 && !(TIMING_DEPENDENT_TERMS[id] ?? []).includes(key)
  );
  if (nonZero.length > 0) {
    const detail = nonZero.map(([key, value]) => `${key}=${value}`).join(", ");
    problems.push(`${id} reported misses: ${detail} — a healthy run reads 0 on every one`);
  }

  // A floor naming a metric the scenario never emits is a broken declaration,
  // and it fails on any machine — the same class as a missing predicate. A
  // shortfall is judged too: the floors are set well under what the fixtures
  // build, so falling below one means the fixture scaled itself down.
  const missingWorkload = report.missingWorkload ?? [];
  if (missingWorkload.length > 0) {
    problems.push(
      `${id} declares workload floor(s) for ${missingWorkload.join(", ")} that the sample ` +
        `never emitted — the reading that would prove it built its workload is missing`
    );
  }
  const shortfalls = report.workloadShortfalls ?? [];
  if (shortfalls.length > 0) {
    problems.push(
      `${id} built less than it claims: ${shortfalls.join(", ")} — the numbers describe a ` +
        `smaller workload than the scenario says it measures`
    );
  }

  const durationMs = report.durationMs;
  const elapsedMs = report.elapsedMs;
  if (typeof durationMs !== "number" || typeof elapsedMs !== "number") {
    problems.push(`${id} reported no durationMs/elapsedMs — driver output changed?`);
    return problems;
  }

  const declaredSentinel = id in WALL_CLOCK_TIMED;
  if (declaredSentinel) {
    // The other direction on the sentinel list, in the same shape as KNOWN_DEAD.
    if (durationMs > 0) {
      problems.push(
        `${id} now self-times (durationMs ${durationMs}) — delete it from WALL_CLOCK_TIMED in this file`
      );
    }
    if (!(elapsedMs > 0)) {
      problems.push(`${id} took no measurable time at all (bracket ${elapsedMs}ms)`);
    }
    return problems;
  }

  if (!(durationMs > 0)) {
    problems.push(
      `${id} returned durationMs ${durationMs} — the harness reads a non-positive duration as ` +
        `the "wall-clock me instead" sentinel (run.ts:799), which is also what a hardcoded stub ` +
        `returns. If it is deliberate, name it in WALL_CLOCK_TIMED with the reason`
    );
  } else if (durationMs > elapsedMs + CONTAINMENT_SLACK_MS) {
    problems.push(
      `${id} claims ${durationMs.toFixed(3)}ms inside a ${elapsedMs.toFixed(3)}ms call — a ` +
        `measurement cannot outlast the bracket it was taken in, so this number was not measured`
    );
  }

  return problems;
}

/** Per-file content hashes, so "nothing was written" is provable AND diagnosable. */
function hashTree(dir: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (!statSync(full).isFile()) continue;
    hashes.set(name, createHash("sha256").update(readFileSync(full)).digest("hex"));
  }
  return hashes;
}

/**
 * Name the files that moved, and both things that could have moved them.
 *
 * A bare hash-vs-hash comparison fails with two hex strings and no way to tell
 * a scenario that wrote to `config/` — the defect this exists for — from a
 * `npm run perf` someone started in the same tree while the suite was running,
 * which is harmless and was observed during development. The second is possible
 * for `history/` only: `run.ts` writes it exclusively on a canonical run (no
 * `--iterations`, no `--warmups`), and this guard's driver always passes both,
 * so its own children provably cannot be the cause.
 */
function describeTreeDrift(
  dir: string,
  before: Map<string, string>,
  after: Map<string, string>
): string {
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((name) => before.get(name) !== after.get(name))
    .map((name) => {
      if (!before.has(name)) return `${name} (created)`;
      if (!after.has(name)) return `${name} (deleted)`;
      return `${name} (rewritten)`;
    });
  if (changed.length === 0) return "";
  return (
    `${path.basename(dir)}/ changed while the guard ran: ${changed.join(", ")}. ` +
    "Either a scenario wrote to it — which no scenario may do — or someone ran " +
    "`npm run perf` in this tree concurrently. Re-run alone to tell them apart."
  );
}

const CONFIG_DIR = path.join(PERF_ROOT, "config");
const HISTORY_DIR = path.join(PERF_ROOT, "history");

describe("perf scenario liveness", () => {
  const matrixIds = allScenarios.map((scenario) => scenario.id);

  /**
   * A scenario declared `unsupported` on this platform is skipped by `run.ts`
   * too, so running it here would assert something the runner never asks for.
   * Computed rather than listed, so the skip set follows the declarations.
   */
  const unsupportedHere = new Set(
    allScenarios
      .filter((scenario) => scenario.platforms?.[process.platform] === "unsupported")
      .map((scenario) => scenario.id)
  );

  const liveIds = matrixIds.filter(
    (id) => !(id in EXPENSIVE_SCENARIOS) && !(id in KNOWN_DEAD) && !unsupportedHere.has(id)
  );

  it("names only real scenarios in its exclusion lists", () => {
    // A stale id is a gap that reads as a decision. All three lists are checked
    // against the matrix rather than against each other.
    const known = new Set(matrixIds);
    const stale = [
      ...Object.keys(EXPENSIVE_SCENARIOS),
      ...Object.keys(KNOWN_DEAD),
      ...Object.keys(WALL_CLOCK_TIMED),
    ].filter((id) => !known.has(id));
    expect(stale).toEqual([]);
    expect(Object.keys(EXPENSIVE_SCENARIOS).filter((id) => id in KNOWN_DEAD)).toEqual([]);

    // A sentinel entry for a scenario this guard never drives could never be
    // checked in the other direction, so it would sit here forever whether or
    // not it stayed true.
    const unrunnable = Object.keys(WALL_CLOCK_TIMED).filter(
      (id) => id in EXPENSIVE_SCENARIOS || id in KNOWN_DEAD
    );
    expect(unrunnable).toEqual([]);

    // The timing exemption in the other direction: a term no live scenario
    // declares any more is an exemption that outlived its cause, and it would
    // silently keep excusing that name if some future scenario reused it.
    const declaredTerms = new Map(
      allScenarios
        .filter((scenario) => liveIds.includes(scenario.id))
        .map((scenario) => [scenario.id, new Set(scenario.correctness ?? [])] as const)
    );
    const orphanedExemptions = Object.entries(TIMING_DEPENDENT_TERMS).flatMap(([id, terms]) =>
      terms
        .filter((term) => !(declaredTerms.get(id) ?? new Set<string>()).has(term))
        .map((term) => `${id}.${term}`)
    );
    expect(orphanedExemptions).toEqual([]);
  });

  it("accounts for every scenario in the matrix", () => {
    // Partition, not overlap: every id either runs below or is named in one of
    // the three sets, so a new scenario cannot arrive without landing in one.
    const accounted = new Set([
      ...liveIds,
      ...Object.keys(EXPENSIVE_SCENARIOS),
      ...Object.keys(KNOWN_DEAD),
      ...unsupportedHere,
    ]);
    expect(matrixIds.filter((id) => !accounted.has(id))).toEqual([]);
    expect(accounted.size).toBe(new Set(matrixIds).size);
  });

  it(
    "runs every scenario in the matrix without throwing",
    async () => {
      const configBefore = hashTree(CONFIG_DIR);
      const historyBefore = hashTree(HISTORY_DIR);

      const results = await runPool([...liveIds, ...Object.keys(KNOWN_DEAD)]);

      const failures: string[] = [];
      for (const id of liveIds) {
        const result = results.get(id)!;
        if (result.exitCode !== 0) {
          failures.push(`${id} DID NOT RUN (${result.elapsedMs}ms): ${explain(result)}`);
          continue;
        }
        const parsed = parseOk(result);
        if (parsed === null) {
          failures.push(`${id} exited 0 but printed no parseable result line`);
          continue;
        }
        failures.push(...verdicts(id, parsed));
      }

      // The other direction: a scenario on the known-dead inventory that has
      // started working is a line to delete, not a silent improvement.
      const revived = Object.keys(KNOWN_DEAD).filter((id) => results.get(id)?.exitCode === 0);
      if (revived.length > 0) {
        failures.push(`${revived.join(", ")} now RUN — delete them from KNOWN_DEAD in this file`);
      }

      expect(failures.join("\n")).toBe("");

      // The guard measures; it must never write a reference or a history entry.
      const drift = [
        describeTreeDrift(CONFIG_DIR, configBefore, hashTree(CONFIG_DIR)),
        describeTreeDrift(HISTORY_DIR, historyBefore, hashTree(HISTORY_DIR)),
      ].filter(Boolean);
      expect(drift.join("\n")).toBe("");
    },
    LIVENESS_TIMEOUT_MS
  );
});
