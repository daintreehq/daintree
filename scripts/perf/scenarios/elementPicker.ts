import type { PerfScenario, ScenarioSample } from "../types";
import {
  createPickerHost,
  settledHeapBytes,
  type PickerArm,
  type PickerHostHarness,
} from "../lib/elementPickerFixture";

/**
 * PERF-410..412: what a selection in the Element Picker costs below the
 * renderer, on a fixed Svelte file and a fixed React module. Read
 * `lib/elementPickerFixture.ts` for what is and is not in frame.
 *
 * The structural half of #13889's budget — one host per cold start, none for a
 * warm selection, nothing left running or watching once the picker closes and
 * the host idles out — is in the correctness terms, which the CI liveness guard
 * holds at zero. The durations and the heap reading are reference values in
 * `config/budgets.json`, reported `[outside]` like every other number here.
 */

const ARMS: readonly PickerArm[] = ["svelte", "react"];
const OPEN_CLOSE_CYCLES = 20;
const MIB = 1024 * 1024;
/** Short enough to watch the host retire inside one iteration. */
const IDLE_MS = 250;

/** Disposes the host and waits for its process to go, then counts what is still running. */
async function teardown(harness: PickerHostHarness): Promise<number> {
  await harness.dispose();
  await harness.settle();
  return harness.liveForks();
}

async function runCold(): Promise<ScenarioSample> {
  const metrics: Record<string, number> = {
    svelteMisses: 0,
    reactMisses: 0,
    coldForkMisses: 0,
    leftoverHostMisses: 0,
  };
  let startMs = 0;
  let total = 0;
  for (const arm of ARMS) {
    // A host per arm, so each first selection loads its framework's resolver
    // into a process that has loaded nothing.
    const harness = await createPickerHost();
    try {
      const workspace = await harness.open();
      const begin = performance.now();
      metrics[`${arm}Misses`] = await harness.resolve(workspace, [arm]);
      const elapsed = performance.now() - begin;
      metrics[arm === "svelte" ? "coldSvelteMs" : "coldReactMs"] = elapsed;
      total += elapsed;
      metrics.coldForkMisses += Math.abs(harness.forks.length - 1);
      const forked = harness.forks[0];
      if (forked?.readyAt != null) startMs += (forked.readyAt - forked.forkedAt) / ARMS.length;
    } finally {
      metrics.leftoverHostMisses += await teardown(harness);
    }
  }
  metrics.hostStartMs = startMs;
  return { durationMs: total, metrics };
}

async function runWarm(): Promise<ScenarioSample> {
  const harness = await createPickerHost();
  const metrics: Record<string, number> = { svelteMisses: 0, reactMisses: 0, warmForkMisses: 0 };
  let total = 0;
  try {
    const workspace = await harness.open();
    // The first selection on a page with both frameworks pays both cold starts.
    const primeMisses = await harness.resolve(workspace, ARMS);
    const forked = harness.forks.length;
    for (const arm of ARMS) {
      const begin = performance.now();
      metrics[`${arm}Misses`] = await harness.resolve(workspace, [arm]);
      const elapsed = performance.now() - begin;
      metrics[arm === "svelte" ? "warmSvelteMs" : "warmReactMs"] = elapsed;
      total += elapsed;
    }
    metrics.svelteMisses += primeMisses;
    // A warm host answers from the process it already has.
    metrics.warmForkMisses = harness.forks.length - forked;
  } finally {
    metrics.leftoverHostMisses = await teardown(harness);
  }
  return { durationMs: total, metrics };
}

async function runOpenClose(): Promise<ScenarioSample> {
  const harness = await createPickerHost({ idleMs: IDLE_MS });
  const metrics: Record<string, number> = { cycleMisses: 0, leftoverWatchMisses: 0, cycleCount: 0 };
  let total = 0;
  let baseline = 0;
  try {
    for (let cycle = 0; cycle < OPEN_CLOSE_CYCLES; cycle += 1) {
      const begin = performance.now();
      const workspace = await harness.open();
      metrics.cycleMisses += await harness.resolve(workspace, ARMS);
      harness.close(workspace);
      total += performance.now() - begin;
      metrics.cycleCount += 1;
      // Read after the first cycle, once both resolvers and the host are up:
      // what is left to measure is what each further open and close keeps.
      if (cycle === 0) baseline = settledHeapBytes();
    }
    metrics.heapGrowthMb = (settledHeapBytes() - baseline) / MIB;
    // Every closed workspace gave its watches back.
    metrics.leftoverWatchMisses = harness.activeWatches();
    // Back-to-back opens keep one host; left alone, it retires.
    metrics.forkMisses = Math.abs(harness.forks.length - 1);
    await harness.settle(IDLE_MS * 20);
    metrics.idleRetireMisses = harness.liveForks();
  } finally {
    metrics.leftoverHostMisses = await teardown(harness);
  }
  metrics.cycleMs = total / OPEN_CLOSE_CYCLES;
  return { durationMs: total, metrics };
}

export const elementPickerScenarios: PerfScenario[] = [
  {
    id: "PERF-410",
    name: "Element Picker Cold Selection",
    description:
      "A first selection on a fresh ElementPickerHost, once per framework: the host process is forked, its resolver for that framework loaded with the Svelte compiler or Babel's parser and the map decoder, and the selection verified against a fixed .svelte file or a fixed React module whose frame is mapped through its inline map. Reports each arm's time to a verified answer and the process start inside it. One host per selection is a predicate; the time is a reference.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 6, ci: 12, nightly: 20 },
    warmups: 1,
    correctness: ["svelteMisses", "reactMisses", "coldForkMisses", "leftoverHostMisses"],
    run: runCold,
  },
  {
    id: "PERF-411",
    name: "Element Picker Warm Selection",
    description:
      "The same two selections asked again of a host that has answered both once: the resolvers are loaded and the process is up, so this is the cost of a selection while the picker is in use. Forking again for a warm selection is a predicate miss.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 6, ci: 12, nightly: 20 },
    warmups: 1,
    correctness: ["svelteMisses", "reactMisses", "warmForkMisses", "leftoverHostMisses"],
    run: runWarm,
  },
  {
    id: "PERF-412",
    name: "Element Picker Open/Close Memory",
    description:
      "Twenty back-to-back cycles of opening the picker on a worktree, selecting one Svelte and one React element, and closing it again, on one ElementPickerHost. Reports main's retained heap growth after the first cycle and the mean cycle time; every closed workspace releasing its watches, the cycles sharing one host process, and that process retiring once left idle are predicates. Main's heap only: the host process's memory goes with it when it retires.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 6, nightly: 10 },
    warmups: 1,
    correctness: [
      "cycleMisses",
      "leftoverWatchMisses",
      "forkMisses",
      "idleRetireMisses",
      "leftoverHostMisses",
    ],
    workloadFloors: { cycleCount: OPEN_CLOSE_CYCLES },
    run: runOpenClose,
  },
];
