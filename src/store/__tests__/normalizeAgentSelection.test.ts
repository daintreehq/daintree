// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeAgentSelection } from "../agentSettingsStore";
import type { AgentSettings, CliAvailability } from "@shared/types";

describe("normalizeAgentSelection", () => {
  const makeSettings = (
    agents: Record<string, { selected?: boolean; enabled?: boolean }>
  ): AgentSettings => ({
    agents: Object.fromEntries(
      Object.entries(agents).map(([id, overrides]) => [
        id,
        { customFlags: "", dangerousArgs: "", dangerousEnabled: false, ...overrides },
      ])
    ),
  });

  const availability: CliAvailability = {
    claude: true,
    gemini: false,
    codex: true,
    opencode: false,
    cursor: false,
  } as CliAvailability;

  it("fills selected: undefined using CLI availability", () => {
    const settings = makeSettings({
      claude: {},
      gemini: {},
    });
    const result = normalizeAgentSelection(settings, availability);
    expect(result.agents.claude.selected).toBe(true);
    expect(result.agents.gemini.selected).toBe(false);
  });

  it("preserves explicit selected: true and selected: false", () => {
    const settings = makeSettings({
      claude: { selected: false },
      gemini: { selected: true },
    });
    const result = normalizeAgentSelection(settings, availability);
    expect(result.agents.claude.selected).toBe(false);
    expect(result.agents.gemini.selected).toBe(true);
  });

  it("migrates deprecated enabled: false to selected: false", () => {
    const settings = makeSettings({
      claude: { enabled: false },
    });
    const result = normalizeAgentSelection(settings, availability);
    expect(result.agents.claude.selected).toBe(false);
  });

  it("does not overwrite selected: false with enabled migration", () => {
    const settings = makeSettings({
      claude: { enabled: false, selected: false },
    });
    const result = normalizeAgentSelection(settings, availability);
    expect(result.agents.claude.selected).toBe(false);
  });

  it("returns same reference when no changes are needed", () => {
    const settings = makeSettings({
      claude: { selected: true },
      gemini: { selected: false },
    });
    const result = normalizeAgentSelection(settings, availability);
    expect(result).toBe(settings);
  });
});
