import { describe, expect, it } from "vitest";
import {
  createHeavyMigrationFixture,
  getHeavyFixtureMinBytes,
  HEAVY_FIXTURE_COUNTS,
  LEGACY_GITHUB_TOKEN,
  LEGACY_WINDOW_STATE,
} from "../lib/migrationFixture";
import { migrationScenarios } from "../scenarios/migrations";

const scenario = migrationScenarios[0]!;
const context = { mode: "ci" as const, now: () => performance.now() };

describe("PERF-080 heavy migration fixture", () => {
  const fixture = createHeavyMigrationFixture();

  it("stays above the byte floor that makes the O(N) paths worth timing", () => {
    expect(JSON.stringify(fixture).length).toBeGreaterThan(getHeavyFixtureMinBytes());
  });

  it("is a genuine v0 store: nothing the chain adds is already present", () => {
    expect(fixture._schemaVersion).toBe(0);
    // 002 adds `location`; 005 adds the checklist; 008 splits `soundFile`;
    // 016 renames `flavorId`. A fixture carrying any of these already would
    // let the owning migration no-op while still scoring zero misses.
    expect(fixture.appState.terminals.every((t) => !("location" in t))).toBe(true);
    expect("checklist" in fixture.onboarding).toBe(false);
    expect(fixture.notificationSettings.soundFile).toBe("ping.wav");
    expect(fixture.agentSettings.agents["agent-0"]!.flavorId).toBe("preset-0");
  });

  it("carries every legacy key a later migration is written to consume", () => {
    expect(fixture.telemetry.enabled).toBe(true); // 014
    expect(fixture.appState.fleetDeckOpen).toBe(true); // 019
    expect(fixture.plugins.disabledBuiltins).toHaveLength(HEAVY_FIXTURE_COUNTS.disabledBuiltins); // 021
    expect(fixture.mcpServer.auditLog).toHaveLength(HEAVY_FIXTURE_COUNTS.mcpAuditRecords); // 022
    expect(fixture.runHistory.records).toHaveLength(HEAVY_FIXTURE_COUNTS.runHistoryRecords); // 023
    expect(fixture.userConfig.githubToken).toBe(LEGACY_GITHUB_TOKEN); // 024
    expect(fixture.mcpServer.fullToolSurface).toBe(true); // 026
    expect(fixture.windowState.width).toBe(LEGACY_WINDOW_STATE.width); // 009/020
  });

  it("splits the agent corpus so 012 and 013 each have a real population", () => {
    const entries = Object.values(fixture.agentSettings.agents);
    expect(entries).toHaveLength(HEAVY_FIXTURE_COUNTS.agents);
    const phantoms = entries.filter(
      (entry) => Object.keys(entry).length === 1 && entry.pinned === true
    );
    expect(phantoms).toHaveLength(
      HEAVY_FIXTURE_COUNTS.agents - HEAVY_FIXTURE_COUNTS.survivingAgents
    );
  });
});

describe("PERF-080 drives the real migration chain", () => {
  it("runs the shipped runner to head with every post-condition met", async () => {
    const sample = await scenario.run(context);
    const metrics = sample.metrics as Record<string, number>;

    // A real measurement, not the `durationMs: 0` sentinel the scenario used
    // to report while its timing was unmeasured.
    expect(sample.durationMs).toBeGreaterThan(0);
    expect(sample.notes).toBeUndefined();

    // Every declared correctness metric is emitted, and every one is zero.
    for (const name of scenario.correctness ?? []) {
      expect(metrics[name], name).toBe(0);
    }

    expect(metrics.schemaVersion).toBe(28);
    expect(metrics.terminalCount).toBe(HEAVY_FIXTURE_COUNTS.terminals);
    expect(metrics.recipeCount).toBe(HEAVY_FIXTURE_COUNTS.recipes);
    expect(metrics.agentCount).toBe(HEAVY_FIXTURE_COUNTS.survivingAgents);
    // The runner's pre-migration backup is a real copy of a real store.
    expect(metrics.backupBytes).toBeGreaterThan(getHeavyFixtureMinBytes());
    // The chain talks; the fixture silences it inside the bracket but counts it.
    expect(metrics.chainLogLines).toBeGreaterThan(0);
    expect(metrics.bytes).toBeGreaterThan(0);
  }, 120_000);

  it("is repeatable: a second iteration starts from v0 again", async () => {
    const sample = await scenario.run(context);
    const metrics = sample.metrics as Record<string, number>;
    expect(metrics.migrationMisses).toBe(0);
    expect(metrics.schemaVersion).toBe(28);
  }, 120_000);
});
