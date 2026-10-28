// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeAgentSelection } from "../agentSettingsStore";
import { getEffectiveAgentIds } from "../../../shared/config/agentRegistry";
import { DEFAULT_AGENT_SETTINGS, type AgentSettings } from "@shared/types";

describe("normalizeAgentSelection", () => {
  it("seeds empty entries for missing registered agents once real availability exists", () => {
    const settings: AgentSettings = { settingsVersion: 1, agents: {} };
    const result = normalizeAgentSelection(settings, true);

    for (const id of getEffectiveAgentIds()) {
      expect(result.agents[id]).toEqual({});
    }
  });

  it("never writes a toolbar pin, even on a fresh default install (#14702)", () => {
    // First-run pins are this machine's now, seeded by main from its own CLI
    // check, so agent settings stay free of them.
    const result = normalizeAgentSelection(DEFAULT_AGENT_SETTINGS, true);

    expect(result.settingsVersion).toBe(DEFAULT_AGENT_SETTINGS.settingsVersion);
    for (const entry of Object.values(result.agents)) {
      expect(entry).not.toHaveProperty("pinned");
    }
  });

  it("leaves entries absent when hasRealData is false (pre-probe race)", () => {
    const settings: AgentSettings = { agents: {} };
    const result = normalizeAgentSelection(settings, false);
    // Pre-probe: don't phantom-synthesize anything — the orchestrator will
    // re-run normalization once availability lands. Empty input stays empty.
    expect(result.agents).toEqual({});
  });

  it("returns same reference when no changes are needed", () => {
    const settings: AgentSettings = {
      agents: Object.fromEntries(
        getEffectiveAgentIds().map((id) => [
          id,
          { customFlags: "", dangerousArgs: "", dangerousEnabled: false },
        ])
      ),
    };
    const result = normalizeAgentSelection(settings, true);
    expect(result).toBe(settings);
  });

  it("defaults to the pre-probe branch when called with only settings (back-compat)", () => {
    const settings: AgentSettings = { agents: {} };
    // hasRealData defaults to false, so no seeding occurs. Mirrors what happens
    // during boot before `cliAvailabilityStore.initialize()` has hydrated any
    // real data.
    const result = normalizeAgentSelection(settings);
    expect(result.agents).toEqual({});
  });
});
