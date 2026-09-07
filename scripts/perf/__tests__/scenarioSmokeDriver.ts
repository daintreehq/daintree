/**
 * Runs ONE scenario's `run()` exactly once and prints the outcome as a single
 * JSON line on stdout. Not a test file — `scenarioLiveness.test.ts` spawns this
 * under `tsx`, one process per scenario.
 *
 * It has to be a separate process, and it has to be `tsx`. Every fixture in
 * `lib/` that loads main-process code installs its module-resolution hooks
 * behind `if (process.env.VITEST) return;`, because Vite resolves imports
 * itself and the hooks never fire under Vitest. Calling `run()` from inside a
 * Vitest worker would therefore load the real `electron` module graph and fail
 * for reasons that have nothing to do with the scenario. One scenario per
 * process is also how `run.ts` drives them, so what this proves is what the
 * runner would do.
 *
 * WHAT IT DECIDES AND WHAT IT REPORTS. Apparatus facts are thrown here — a
 * sample that is not an object, a non-finite `durationMs`, a non-finite metric,
 * because none of those can be true of anything and none needs a per-scenario
 * exemption. Everything a VERDICT needs — the self-measured duration, the
 * bracket the driver spent around `run()`, the value of every declared
 * correctness metric — is reported instead, and judged in
 * `scenarioLiveness.test.ts`, which is where the exclusion tables and their
 * reasons live.
 *
 * Usage: tsx scenarioSmokeDriver.ts <scenario-id>
 */
import { allScenarios } from "../scenarios";
import type { PerfMode } from "../types";
import { cleanupPerfTempRoots } from "../lib/tempRoots";
import { closeAllParcelWatcherSubscriptions } from "../../../electron/utils/parcelWatcherBackend";

/** The cheapest mode a scenario declares, preferred smoke-first. */
const MODE_PREFERENCE: readonly PerfMode[] = ["smoke", "ci", "nightly", "soak"];

async function main(): Promise<void> {
  const scenarioId = process.argv[2];
  if (!scenarioId) throw new Error("scenarioSmokeDriver needs a scenario id");

  const scenario = allScenarios.find((candidate) => candidate.id === scenarioId);
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`);

  const mode = MODE_PREFERENCE.find((candidate) => scenario.modes.includes(candidate));
  if (!mode) throw new Error(`${scenarioId} declares no modes`);

  const started = performance.now();
  const sample = await scenario.run({ mode, now: () => performance.now() });
  const elapsedMs = performance.now() - started;

  if (typeof sample !== "object" || sample === null) {
    throw new Error(`${scenarioId} returned ${String(sample)} instead of a sample`);
  }
  if (!Number.isFinite(sample.durationMs)) {
    throw new Error(`${scenarioId} returned a non-finite durationMs: ${String(sample.durationMs)}`);
  }

  const metrics = sample.metrics ?? {};
  const nonFinite = Object.entries(metrics)
    .filter(([, value]) => !Number.isFinite(value))
    .map(([key]) => key);
  if (nonFinite.length > 0) {
    throw new Error(`${scenarioId} emitted non-finite metrics: ${nonFinite.join(", ")}`);
  }

  // Correctness metrics are the harness's own invariant: declared, emitted on
  // every iteration, and zero on a healthy one. A liveness guard that ignored
  // them would pass a scenario whose subject had stopped doing its work.
  //
  // The VALUES are reported rather than judged here. Presence is an apparatus
  // fact and belongs with the other apparatus throws above; "this reading is
  // wrong" is a verdict, and the verdict needs the exclusion table — with its
  // per-scenario reasons — that lives in `scenarioLiveness.test.ts`.
  const declared = scenario.correctness ?? [];
  const missingCorrectness = declared.filter(
    (key) => !Object.prototype.hasOwnProperty.call(metrics, key)
  );
  const correctness: Record<string, number> = {};
  for (const key of declared) {
    const value = metrics[key];
    if (typeof value === "number") correctness[key] = value;
  }

  // Workload floors are an APPARATUS fact, not a verdict: a floor naming a
  // metric the scenario never emits is a broken declaration on any machine,
  // and one that is met is met. Reported alongside the predicates so the
  // liveness guard can assert both without re-deriving either.
  const floors = scenario.workloadFloors ?? {};
  const missingWorkload = Object.keys(floors).filter(
    (key) => !Object.prototype.hasOwnProperty.call(metrics, key)
  );
  const workloadShortfalls: string[] = [];
  for (const [key, floor] of Object.entries(floors)) {
    const value = metrics[key];
    if (typeof value === "number" && value < floor) {
      workloadShortfalls.push(`${key}=${value} < ${floor}`);
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      id: scenarioId,
      mode,
      // Unrounded, and load-bearing: the test compares the scenario's own
      // duration against this bracket, and rounding a 0.19ms scenario's
      // bracket to 0 would make a real measurement look like it had reported
      // more time than it was given.
      elapsedMs,
      durationMs: sample.durationMs,
      metricCount: Object.keys(metrics).length,
      missingCorrectness,
      correctness,
      missingWorkload,
      workloadShortfalls,
    })}\n`
  );
}

main().then(
  async () => {
    await closeAllParcelWatcherSubscriptions();
    // Run once while the event loop is still alive; the process exit hook is a
    // second attempt for roots whose native handles were still settling.
    cleanupPerfTempRoots();
    process.exit(0);
  },
  async (error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, id: process.argv[2], message })}\n`);
    await closeAllParcelWatcherSubscriptions();
    cleanupPerfTempRoots();
    process.exit(1);
  }
);
