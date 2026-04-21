import type { PerfScenario } from "../types";
import { createHeavyMigrationFixture, getHeavyFixtureMinBytes } from "../lib/migrationFixture";

/**
 * Simulates the full migration chain from schema v0 → v17 against a
 * worst-case fixture. Each iteration replicates the exact O(N) patterns
 * from the real migration code (terminal mapping, recipe filtering,
 * agent entry loops) and the O(1) migrations (object spreads).
 *
 * A separate vitest test (`StoreMigrations.perf.test.ts`) exercises the
 * real migration functions for correctness; this scenario focuses on
 * latency measurement and regression gating.
 */
function runMigrationChain(fixture: ReturnType<typeof createHeavyMigrationFixture>): {
  terminalCount: number;
  recipeCount: number;
  agentCount: number;
  bytes: number;
} {
  // Deep-clone the fixture so each iteration starts from v0
  let state: Record<string, unknown> = JSON.parse(
    JSON.stringify(fixture as unknown as string)
  ) as Record<string, unknown>;

  // Migration 002 — Add location field to terminals (O(N) over terminals)
  const appState002 = state.appState as Record<string, unknown> | undefined;
  if (appState002?.terminals && Array.isArray(appState002.terminals)) {
    appState002.terminals = (appState002.terminals as Array<Record<string, unknown>>).map(
      (term) => ({ ...term, location: (term as Record<string, unknown>).location || "grid" })
    );
  }

  // Migration 003 — Migrate global recipes to project-scoped (O(N) over recipes)
  // (Simulation: filter + map the recipes array, no projectStore I/O)
  const appState003 = state.appState as Record<string, unknown> | undefined;
  if (appState003?.recipes && Array.isArray(appState003.recipes)) {
    const recipes = appState003.recipes as Array<Record<string, unknown>>;
    const existingIds = new Set<string>();
    const migratedRecipes = recipes
      .filter((r) => !existingIds.has(r.id as string))
      .map((legacyRecipe) => {
        const terminals = ((legacyRecipe.terminals || []) as Array<Record<string, unknown>>).map(
          (t) => ({
            type: t.type,
            title: t.title,
            command: t.command,
            env: t.env,
            initialPrompt: t.initialPrompt,
            devCommand: t.devCommand,
          })
        );
        return {
          id: legacyRecipe.id,
          name: legacyRecipe.name,
          projectId: "perf-project-0",
          worktreeId: legacyRecipe.worktreeId,
          terminals,
          createdAt: legacyRecipe.createdAt || Date.now(),
          showInEmptyState: legacyRecipe.showInEmptyState,
          lastUsedAt: legacyRecipe.lastUsedAt,
        };
      });
    // Clear global recipes (matches migration 003 behavior)
    (state.appState as Record<string, unknown>).recipes = [];
    void migratedRecipes;
  }

  // Migration 004 — Upgrade correction model (O(1))
  const voiceInput004 = state.voiceInput as Record<string, unknown> | undefined;
  if (voiceInput004) {
    if (voiceInput004.correctionModel === "gpt-5-nano") {
      voiceInput004.correctionModel = "gpt-5-mini";
    } else if (voiceInput004.correctionModel === undefined) {
      voiceInput004.correctionModel = "gpt-5-mini";
    }
  }

  // Migration 005 — Add getting-started checklist (O(1))
  const onboarding005 = state.onboarding as Record<string, unknown> | undefined;
  if (onboarding005 && !(onboarding005 as Record<string, unknown>).checklist) {
    const dismissed = onboarding005.completed === true;
    (onboarding005 as Record<string, unknown>).checklist = {
      dismissed,
      items: { openedProject: dismissed, launchedAgent: dismissed, createdWorktree: dismissed },
    };
  }

  // Migration 007 — Reduce default terminal scrollback (O(1))
  const terminalConfig007 = state.terminalConfig as Record<string, unknown> | undefined;
  if (terminalConfig007 && terminalConfig007.scrollbackLines === 2500) {
    terminalConfig007.scrollbackLines = 1000;
  }

  // Migration 008 — Split notification sounds (O(1))
  const notif008 = state.notificationSettings as Record<string, unknown> | undefined;
  if (notif008) {
    const soundFile = notif008.soundFile as string | undefined;
    notif008.completedSoundFile = soundFile || "chime.wav";
    notif008.waitingSoundFile = "waiting.wav";
    notif008.escalationSoundFile = "ping.wav";
    delete notif008.soundFile;
  }

  // Migration 009 — Seed windowStates from legacy windowState (O(1))
  const windowState009 = state.windowState as Record<string, unknown> | undefined;
  if (windowState009 && (windowState009.width !== 1200 || windowState009.y !== undefined)) {
    state.windowStates = {
      __legacy__: { ...windowState009, isMaximized: windowState009.isMaximized ?? false },
    };
  } else {
    state.windowStates = {};
  }

  // Migration 010 — Add working pulse settings (O(1))
  const notif010 = state.notificationSettings as Record<string, unknown> | undefined;
  if (notif010 && notif010.workingPulseEnabled === undefined) {
    notif010.workingPulseEnabled = false;
    notif010.workingPulseSoundFile = "pulse.wav";
  }

  // Migration 011 — Minimal soundscape defaults (O(1))
  const notif011 = state.notificationSettings as Record<string, unknown> | undefined;
  if (notif011) {
    if (notif011.waitingEnabled === false) notif011.waitingEnabled = true;
    if (notif011.waitingEscalationEnabled === true) notif011.waitingEscalationEnabled = false;
    if (notif011.uiFeedbackSoundEnabled === true) notif011.uiFeedbackSoundEnabled = false;
  }

  // Migration 012 — Default-pin agents and retire legacy fields (O(N) over agents)
  const agentSettings012 = state.agentSettings as Record<string, unknown> | undefined;
  if (agentSettings012?.agents && typeof agentSettings012.agents === "object") {
    const rawAgents = agentSettings012.agents as Record<string, Record<string, unknown>>;
    const updatedAgents: Record<string, Record<string, unknown>> = {};
    for (const [id, entry] of Object.entries(rawAgents)) {
      const pinned = entry.selected !== false;
      const { selected: _s, enabled: _e, ...rest } = entry;
      updatedAgents[id] = { ...rest, pinned };
    }
    agentSettings012.agents = updatedAgents;
  }

  // Migration 013 — Clean up phantom pinned entries (O(N) over agents)
  const agentSettings013 = state.agentSettings as Record<string, unknown> | undefined;
  if (agentSettings013?.agents && typeof agentSettings013.agents === "object") {
    const rawAgents = agentSettings013.agents as Record<string, Record<string, unknown>>;
    const kept: Record<string, Record<string, unknown>> = {};
    let changed = false;
    for (const [id, entry] of Object.entries(rawAgents)) {
      const keys = Object.keys(entry);
      if (keys.length === 1 && keys[0] === "pinned" && entry.pinned === true) {
        changed = true;
        continue;
      }
      kept[id] = entry;
    }
    if (changed) {
      agentSettings013.agents = kept;
    }
  }

  // Migration 014 — Consolidate telemetry consent (O(1))
  const legacyTelemetry = (state as Record<string, unknown>).telemetry as
    | Record<string, unknown>
    | undefined;
  const privacy014 = state.privacy as Record<string, unknown> | undefined;
  if (privacy014) {
    if (privacy014.telemetryLevel === undefined) {
      privacy014.telemetryLevel = legacyTelemetry?.enabled === true ? "errors" : "off";
    }
    if (typeof privacy014.hasSeenPrompt !== "boolean") {
      privacy014.hasSeenPrompt = legacyTelemetry?.hasSeenPrompt === true;
    }
  }
  delete (state as Record<string, unknown>).telemetry;

  // Migration 015 — Activation funnel and checklist rename (O(1))
  if (typeof state.activationFunnel !== "object" || state.activationFunnel === null) {
    state.activationFunnel = {};
  }
  const onboarding015 = state.onboarding as Record<string, unknown> | undefined;
  if (onboarding015?.checklist) {
    const checklist = onboarding015.checklist as Record<string, unknown>;
    const items = { ...((checklist.items as Record<string, unknown>) ?? {}) };
    delete items.subscribedNewsletter;
    if (typeof items.ranSecondParallelAgent !== "boolean") {
      items.ranSecondParallelAgent = false;
    }
    onboarding015.checklist = { ...checklist, items };
  }

  // Migration 016 — Rename flavorId → presetId (O(N) over agents)
  const agentSettings016 = state.agentSettings as Record<string, unknown> | undefined;
  if (agentSettings016?.agents && typeof agentSettings016.agents === "object") {
    const rawAgents = agentSettings016.agents as Record<string, Record<string, unknown>>;
    const migratedAgents: Record<string, Record<string, unknown>> = {};
    for (const [id, entry] of Object.entries(rawAgents)) {
      if (!entry || typeof entry !== "object") {
        migratedAgents[id] = entry;
        continue;
      }
      const { flavorId, customFlavors, ...rest } = entry;
      const next: Record<string, unknown> = { ...rest };
      if (flavorId !== undefined && next.presetId === undefined) next.presetId = flavorId;
      if (customFlavors !== undefined && next.customPresets === undefined) {
        next.customPresets = customFlavors;
      }
      migratedAgents[id] = next;
    }
    agentSettings016.agents = migratedAgents;
  }

  // Migration 017 — Add quiet hours (O(1))
  const notif017 = state.notificationSettings as Record<string, unknown> | undefined;
  if (notif017) {
    if (notif017.quietHoursEnabled === undefined) notif017.quietHoursEnabled = false;
    if (typeof notif017.quietHoursStartMin !== "number") notif017.quietHoursStartMin = 22 * 60;
    if (typeof notif017.quietHoursEndMin !== "number") notif017.quietHoursEndMin = 8 * 60;
    if (!Array.isArray(notif017.quietHoursWeekdays)) notif017.quietHoursWeekdays = [];
  }

  const appState = state.appState as Record<string, unknown> | undefined;
  const terminals = (appState?.terminals as Array<unknown>)?.length ?? 0;
  const agents = Object.keys(
    ((state.agentSettings as Record<string, unknown>)?.agents as Record<string, unknown>) ?? {}
  ).length;

  return {
    terminalCount: terminals,
    recipeCount: fixture.appState.recipes?.length ?? 0,
    agentCount: agents,
    bytes: JSON.stringify(state).length,
  };
}

const FIXTURE = createHeavyMigrationFixture();
const FIXTURE_JSON = JSON.stringify(FIXTURE);
const FIXTURE_BYTES = FIXTURE_JSON.length;

export const migrationScenarios: PerfScenario[] = [
  {
    id: "PERF-080",
    name: "Migration Chain v0→v17 Heavy Fixture",
    description:
      "Run the full migration chain from schema v0 to v17 against a worst-case " +
      "fixture (10k terminals, 500 recipes, 200 agents). Gates p95 < 500ms to " +
      "catch O(N) regressions.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 8, nightly: 12 },
    warmups: 2,
    run() {
      // Sanity check: fixture must stay large enough to exercise O(N) paths
      if (FIXTURE_BYTES < getHeavyFixtureMinBytes()) {
        throw new Error(
          `PERF-080 fixture too small: ${FIXTURE_BYTES} bytes < ${getHeavyFixtureMinBytes()} minimum. ` +
            `Add more data to createHeavyMigrationFixture() to exercise O(N) migration paths.`
        );
      }

      // Deep-clone fixture for this iteration
      const cloned = JSON.parse(FIXTURE_JSON) as ReturnType<typeof createHeavyMigrationFixture>;
      const result = runMigrationChain(cloned);

      return {
        durationMs: 0,
        metrics: result,
      };
    },
  },
];
