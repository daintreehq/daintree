import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { allScenarios } from "../scenarios";

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
 *   Each scenario's `run()` completes once, returns a sample with a finite
 *   `durationMs`, emits no non-finite metric, and emits every metric key it
 *   declared in `correctness`.
 *
 * WHAT IT DOES NOT PROVE
 *   Nothing about the NUMBERS. A scenario whose subject got 10x slower, or
 *   whose predicate started reporting misses, passes here. This is a liveness
 *   check, not a measurement: it answers "is this benchmark still a benchmark",
 *   which is the one question the harness could not previously answer about
 *   itself. Correctness metrics are checked for PRESENCE, not for zero — one
 *   iteration under vitest contention is not a reading, and asserting zero
 *   would turn a busy machine into a red suite.
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
 * The rule is a single `run()` costing more than ~12 seconds on the reference
 * machine (M-series macOS, serial). Every one below is expensive BY DESIGN —
 * it idles for a fixed wall-clock window, or builds real multi-worktree git
 * topologies — so no amount of harness work makes it cheap, and a guard that
 * waited for them would cost ~5 minutes and get switched off.
 *
 * Times are the measured serial cost of ONE `run()`. They are here so the next
 * person can re-judge the trade rather than inherit it, and so that an entry
 * that stops being expensive is visible rather than permanent.
 *
 * This is a REAL GAP: these six are exactly as capable of dying silently as the
 * thirteen that did. Run them by hand after touching `lib/idleWindow*`,
 * `lib/gitPipeline*` or `lib/worktreeSidebar*`:
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

/** Ceiling for one scenario's child. Generous: the pool runs several at once. */
const CHILD_TIMEOUT_MS = 120_000;

/**
 * Four at a time. This file already competes with Vitest's own workers, and
 * several scenarios spawn real subprocesses; oversubscribing turns a liveness
 * check into a source of timing flakes elsewhere in the suite.
 */
const CONCURRENCY = Math.max(2, Math.min(4, availableParallelism() - 1));

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
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("VITEST")) continue;
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
      if (typeof parsed.message === "string")
        return parsed.message.split("\n")[0] ?? parsed.message;
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

function parseOk(result: DriverResult): { missingCorrectness?: string[] } | null {
  const line = result.stdout
    .split("\n")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .at(-1);
  if (line === undefined) return null;
  try {
    return JSON.parse(line) as { missingCorrectness?: string[] };
  } catch {
    return null;
  }
}

/** Content hash of a directory's files, so "nothing was written" is provable. */
function hashTree(dir: string): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (!statSync(full).isFile()) continue;
    hash.update(name).update("\0").update(readFileSync(full));
  }
  return hash.digest("hex");
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
    // A stale id is a gap that reads as a decision. Both lists are checked
    // against the matrix rather than against each other.
    const known = new Set(matrixIds);
    const stale = [...Object.keys(EXPENSIVE_SCENARIOS), ...Object.keys(KNOWN_DEAD)].filter(
      (id) => !known.has(id)
    );
    expect(stale).toEqual([]);
    expect(Object.keys(EXPENSIVE_SCENARIOS).filter((id) => id in KNOWN_DEAD)).toEqual([]);
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

  it("runs every scenario in the matrix without throwing", async () => {
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
      const missing = parsed?.missingCorrectness ?? [];
      if (missing.length > 0) {
        failures.push(`${id} ran but emitted no ${missing.join(", ")} — declared in correctness`);
      }
    }

    // The other direction: a scenario on the known-dead inventory that has
    // started working is a line to delete, not a silent improvement.
    const revived = Object.keys(KNOWN_DEAD).filter((id) => results.get(id)?.exitCode === 0);
    if (revived.length > 0) {
      failures.push(`${revived.join(", ")} now RUN — delete them from KNOWN_DEAD in this file`);
    }

    expect(failures.join("\n")).toBe("");

    // The guard measures; it must never write a reference or a history entry.
    expect(hashTree(CONFIG_DIR)).toBe(configBefore);
    expect(hashTree(HISTORY_DIR)).toBe(historyBefore);
  }, 900_000);
});
