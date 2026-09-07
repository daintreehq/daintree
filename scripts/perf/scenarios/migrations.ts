import type { PerfScenario } from "../types";
import {
  createHeavyMigrationFixture,
  getHeavyFixtureMinBytes,
  loadMigrationHarness,
} from "../lib/migrationFixture";

/**
 * The real electron-store migration chain, v0 → v28.
 *
 * This scenario used to reimplement all sixteen migrations inside this file and
 * time the copy. The copy could not regress when the product did — a migration
 * could change shape, gain a table rewrite or lose one entirely and the number
 * would not move — so it now drives the shipped `MigrationRunner` over the
 * shipped `migrations` barrel against a real `config.json`, opened through the
 * product's own `initializeStore()`. `lib/migrationFixture.ts` states the scope
 * limits (Electron stubbed, console silenced inside the bracket, a real SQLite
 * current project seeded so migration 003 runs its real path).
 *
 * The dominant cost is not the transforms. Each migration `set` is an
 * electron-store whole-file atomic write of a ~1.5 MB config, and the runner
 * copies the pre-migration store first, so this measures 25 rewrites plus one
 * backup — the shape `globalServicesInit` calls out as "~100ms for the full
 * chain" on the boot-critical path.
 *
 * ## The predicate
 *
 * Every accumulator is read back off disk after the bracket, never from
 * anything the chain reports about itself, and every expectation is recomputed
 * from `HEAVY_FIXTURE_COUNTS` rather than from a healthy run. A chain reduced
 * to `return state` keeps all three headline counts (terminals, recipes,
 * agents), produces a similar byte total, and finishes in a fraction of the
 * time — so the terms are the properties only a chain that ran can satisfy,
 * one per migration whose whole job is to rewrite something:
 *
 * - `terminalLocationMisses` (002) — 10,000 terminals each carrying `location`
 * - `recipeMigrationMisses` (003) — the global array emptied AND 500 recipes
 *   present in `projects/<id>/recipes.json`, each stamped with the project id
 * - `agentPinMisses` (012) / `phantomPinMisses` (013) / `agentPresetMisses`
 *   (016) — three passes over the same 200 agent entries, graded separately so
 *   dropping one pass cannot hide behind the other two
 * - `notificationMisses`, `windowStateMisses`, `notesArchiveMisses`,
 *   `auditRingMisses`, `scalarMigrationMisses` — one per remaining subject
 *   area, including the two sidecar stores (`window-states.json`,
 *   `audit-logs.json`) and the archived notes directory, which the config file
 *   cannot corroborate
 * - `backupMisses` — the runner's own pre-migration backup exists and is
 *   byte-for-byte the size of the v0 corpus. Skipping the copy is the single
 *   largest saving available inside the bracket and nothing else would see it.
 * - `schemaVersionMisses` — the chain terminated at the shipped head version
 */
const FIXTURE_BYTES = JSON.stringify(createHeavyMigrationFixture()).length;

export const migrationScenarios: PerfScenario[] = [
  {
    id: "PERF-080",
    name: "Migration Chain v0→v28 (real MigrationRunner)",
    description:
      "Run the shipped MigrationRunner over the shipped migrations barrel, v0 to head, against a " +
      "worst-case on-disk store (10k terminals, 500 recipes, 200 agents, six audit rings) opened " +
      "through the product's own initializeStore(). durationMs is the chain's wall time including " +
      "the pre-migration backup and electron-store's whole-file atomic write per migration. Twelve " +
      "miss accumulators are read back off config.json, the project recipes file and both sidecar " +
      "stores; each is 0 only when the migration that owns it actually rewrote what it owes.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 8, nightly: 12 },
    warmups: 2,
    correctness: [
      "migrationMisses",
      "terminalLocationMisses",
      "recipeMigrationMisses",
      "notificationMisses",
      "windowStateMisses",
      "agentPinMisses",
      "phantomPinMisses",
      "agentPresetMisses",
      "notesArchiveMisses",
      "auditRingMisses",
      "scalarMigrationMisses",
      "backupMisses",
      "schemaVersionMisses",
    ],
    async run(context) {
      // Sanity check: the corpus must stay large enough to exercise the O(N)
      // paths and the whole-file rewrite amplification they ride on.
      if (FIXTURE_BYTES < getHeavyFixtureMinBytes()) {
        throw new Error(
          `PERF-080 fixture too small: ${FIXTURE_BYTES} bytes < ${getHeavyFixtureMinBytes()} minimum. ` +
            `Add more data to createHeavyMigrationFixture() to exercise O(N) migration paths.`
        );
      }

      const harness = await loadMigrationHarness();
      const store = harness.prepareIteration();

      const started = context.now();
      await harness.runChain(store);
      const durationMs = context.now() - started;

      const grade = harness.grade();
      return {
        durationMs,
        metrics: { ...grade, fixtureBytes: harness.fixtureBytes },
        notes:
          grade.migrationMisses > 0
            ? `${grade.migrationMisses} post-condition(s) unmet — the chain did not finish the work the timing is attributed to`
            : undefined,
      };
    },
  },
];
