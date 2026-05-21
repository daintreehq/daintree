// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeAgentSelection } from "../agentSettingsStore";
import { getEffectiveAgentIds } from "../../../shared/config/agentRegistry";
import { BUILT_IN_AGENT_IDS } from "../../../shared/config/agentIds";
import { DEFAULT_AGENT_SETTINGS, type AgentSettings, type CliAvailability } from "@shared/types";

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
    expect(result.agents.claude!.pinned).toBe(false);
    expect(result.agents.gemini!.pinned).toBe(true);
  });

  it("leaves pinned: undefined entries untouched (tri-state — visibility derives at read time)", () => {
    // #7673: the normalizer no longer materializes a concrete `pinned` for
    // upgraders. The tri-state read-time selector (isAgentToolbarVisible)
    // handles the install/uninstall flip without freezing state here.
    const settings = makeSettings({ claude: {} });
    const availability = availabilityFor({ claude: "installed" });
    const result = normalizeAgentSelection(settings, availability, true);
    expect(result.agents.claude!.pinned).toBeUndefined();
  });

  it("leaves pinned: undefined entries untouched even when availability says missing", () => {
    const settings = makeSettings({ claude: {} });
    const availability = availabilityFor({ claude: "missing" });
    const result = normalizeAgentSelection(settings, availability, true);
    expect(result.agents.claude!.pinned).toBeUndefined();
  });

  it("pins the first five installed built-ins on a fresh default install", () => {
    const installedIds = BUILT_IN_AGENT_IDS.slice(0, 7);
    const availability = availabilityFor(
      Object.fromEntries(installedIds.map((id) => [id, "installed"]))
    );
    const result = normalizeAgentSelection(DEFAULT_AGENT_SETTINGS, availability, true);

    expect(result.settingsVersion).toBe(2);
    for (const [index, id] of BUILT_IN_AGENT_IDS.entries()) {
      expect(result.agents[id]?.pinned).toBe(index < 5);
    }
  });

  it("sets non-installed built-ins to explicit unpinned on a fresh default install", () => {
    const availability = availabilityFor({ [BUILT_IN_AGENT_IDS[0]!]: "installed" });
    const result = normalizeAgentSelection(DEFAULT_AGENT_SETTINGS, availability, true);

    expect(result.agents[BUILT_IN_AGENT_IDS[0]!]?.pinned).toBe(true);
    for (const id of BUILT_IN_AGENT_IDS.slice(1)) {
      expect(result.agents[id]?.pinned).toBe(false);
    }
  });

  it("recovers a default-shaped settingsVersion 1 store from a missed first-run pin pass", () => {
    const settings: AgentSettings = {
      ...DEFAULT_AGENT_SETTINGS,
      settingsVersion: 1,
    };
    const availability = availabilityFor({
      claude: "ready",
      opencode: "installed",
      aider: "installed",
      gemini: "ready",
      codex: "ready",
      cursor: "ready",
    });

    const result = normalizeAgentSelection(settings, availability, true);

    expect(result.settingsVersion).toBe(2);
    expect(result.agents.claude?.pinned).toBe(true);
    expect(result.agents.opencode?.pinned).toBe(true);
    expect(result.agents.aider?.pinned).toBe(true);
    expect(result.agents.gemini?.pinned).toBe(true);
    expect(result.agents.codex?.pinned).toBe(true);
    expect(result.agents.cursor?.pinned).toBe(false);
  });

  it("seeds empty entries (no pinned) for missing registered agents when hasRealData is true and settings are not fresh defaults", () => {
    const settings: AgentSettings = { settingsVersion: 1, agents: {} };
    const allIds = getEffectiveAgentIds();
    const [firstInstalled] = allIds;
    const availability = availabilityFor({ [firstInstalled!]: "installed" });
    const result = normalizeAgentSelection(settings, availability, true);

    for (const id of allIds) {
      expect(result.agents[id]).toEqual({});
    }
  });

  it("leaves entries absent when hasRealData is false (pre-probe race)", () => {
    const settings: AgentSettings = { agents: {} };
    const result = normalizeAgentSelection(settings, availabilityFor(), false);
    // Pre-probe: don't phantom-synthesize anything — the orchestrator will
    // re-run normalization once availability lands. Empty input stays empty.
    expect(result.agents).toEqual({});
  });

  it("leaves existing entries with pinned: undefined untouched when hasRealData is false", () => {
    const settings = makeSettings({ claude: {} });
    const result = normalizeAgentSelection(settings, availabilityFor(), false);
    expect(result.agents.claude!.pinned).toBeUndefined();
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

  it("ignores availability entirely — only seeds empty records for missing agents", () => {
    const settings = makeSettings({ claude: {} });
    const result = normalizeAgentSelection(settings, undefined, true);
    expect(result.agents.claude!.pinned).toBeUndefined();
  });

  it("defaults to the pre-probe branch when called with only settings (back-compat)", () => {
    const settings: AgentSettings = { agents: {} };
    // No availability args passed — hasRealData defaults to false, so no
    // seeding occurs. Mirrors what happens during boot before
    // `cliAvailabilityStore.initialize()` has hydrated any real data.
    const result = normalizeAgentSelection(settings);
    expect(result.agents).toEqual({});
  });
});
