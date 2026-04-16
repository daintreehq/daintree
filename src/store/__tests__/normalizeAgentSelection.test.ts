// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeAgentSelection } from "../agentSettingsStore";
import { getEffectiveAgentIds } from "../../../shared/config/agentRegistry";
import type { AgentSettings, CliAvailability } from "@shared/types";

describe("normalizeAgentSelection", () => {
  const makeSettings = (agents: Record<string, { pinned?: boolean }>): AgentSettings => ({
    agents: Object.fromEntries(
      Object.entries(agents).map(([id, overrides]) => [
        id,
        { customFlags: "", dangerousArgs: "", dangerousEnabled: false, ...overrides },
      ])
    ),
  });

  function availabilityFor(
    overrides: Partial<Record<string, "ready" | "installed" | "missing">> = {}
  ): CliAvailability {
    return Object.fromEntries(
      getEffectiveAgentIds().map((id) => [id, overrides[id] ?? "missing"])
    ) as CliAvailability;
  }

  it("preserves explicit pinned: true and pinned: false regardless of availability", () => {
    const settings = makeSettings({
      claude: { pinned: false },
      gemini: { pinned: true },
    });
    const availability = availabilityFor({ claude: "ready", gemini: "missing" });
    const result = normalizeAgentSelection(settings, availability, true);
    expect(result.agents.claude.pinned).toBe(false);
    expect(result.agents.gemini.pinned).toBe(true);
  });

  it("synthesizes pinned: true for installed agents when hasRealData is true", () => {
    const settings = makeSettings({ claude: {} });
    const availability = availabilityFor({ claude: "installed" });
    const result = normalizeAgentSelection(settings, availability, true);
    expect(result.agents.claude.pinned).toBe(true);
  });

  it("synthesizes pinned: true for ready agents when hasRealData is true", () => {
    const settings = makeSettings({ claude: {} });
    const availability = availabilityFor({ claude: "ready" });
    const result = normalizeAgentSelection(settings, availability, true);
    expect(result.agents.claude.pinned).toBe(true);
  });

  it("synthesizes pinned: false for missing agents when hasRealData is true (issue #5158)", () => {
    const settings = makeSettings({ claude: {} });
    const availability = availabilityFor({ claude: "missing" });
    const result = normalizeAgentSelection(settings, availability, true);
    expect(result.agents.claude.pinned).toBe(false);
  });

  it("creates entries only for installed agents when store is empty and hasRealData is true", () => {
    const settings: AgentSettings = { agents: {} };
    const allIds = getEffectiveAgentIds();
    const [firstInstalled] = allIds;
    const availability = availabilityFor({ [firstInstalled]: "installed" });
    const result = normalizeAgentSelection(settings, availability, true);

    for (const id of allIds) {
      if (id === firstInstalled) {
        expect(result.agents[id]).toEqual({ pinned: true });
      } else {
        expect(result.agents[id]).toEqual({ pinned: false });
      }
    }
  });

  it("leaves pinned absent when hasRealData is false (pre-probe race)", () => {
    const settings: AgentSettings = { agents: {} };
    const result = normalizeAgentSelection(settings, availabilityFor(), false);
    // Pre-probe: don't phantom-synthesize anything — the orchestrator will
    // re-run normalization once availability lands. Empty input stays empty.
    expect(result.agents).toEqual({});
  });

  it("leaves existing entries with pinned: undefined untouched when hasRealData is false", () => {
    const settings = makeSettings({ claude: {} });
    const result = normalizeAgentSelection(settings, availabilityFor(), false);
    expect(result.agents.claude.pinned).toBeUndefined();
  });

  it("returns same reference when no changes are needed", () => {
    const settings: AgentSettings = {
      agents: Object.fromEntries(
        getEffectiveAgentIds().map((id) => [
          id,
          { customFlags: "", dangerousArgs: "", dangerousEnabled: false, pinned: true },
        ])
      ),
    };
    const result = normalizeAgentSelection(settings, availabilityFor(), true);
    expect(result).toBe(settings);
  });

  it("treats undefined availability as fully missing when hasRealData is true", () => {
    const settings = makeSettings({ claude: {} });
    const result = normalizeAgentSelection(settings, undefined, true);
    expect(result.agents.claude.pinned).toBe(false);
  });

  it("defaults to the pre-probe branch when called with only settings (back-compat)", () => {
    const settings: AgentSettings = { agents: {} };
    // No availability args passed — hasRealData defaults to false, so no
    // phantom synthesis occurs. Mirrors what happens during boot before
    // `cliAvailabilityStore.initialize()` has hydrated any real data.
    const result = normalizeAgentSelection(settings);
    expect(result.agents).toEqual({});
  });
});
