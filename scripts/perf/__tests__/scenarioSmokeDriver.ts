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
 * Usage: tsx scenarioSmokeDriver.ts <scenario-id>
 */
import { allScenarios } from "../scenarios";
import type { PerfMode } from "../types";

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
  const missingCorrectness = (scenario.correctness ?? []).filter(
    (key) => !Object.prototype.hasOwnProperty.call(metrics, key)
  );

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      id: scenarioId,
      mode,
      elapsedMs: Math.round(elapsedMs),
      durationMs: sample.durationMs,
      metricCount: Object.keys(metrics).length,
      missingCorrectness,
    })}\n`
  );
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, id: process.argv[2], message })}\n`);
    process.exit(1);
  }
);
