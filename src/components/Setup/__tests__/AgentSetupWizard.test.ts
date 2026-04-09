import { describe, expect, it } from "vitest";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import {
  buildInitialState,
  FEATURED_AGENT_IDS,
  MORE_AGENT_IDS,
  sortTierByInstalled,
  wizardReducer,
} from "../AgentSetupWizard";
import type { CliAvailability } from "@shared/types";

describe("sortTierByInstalled", () => {
  const tier = ["claude", "gemini", "codex"] as const;

  it("preserves original order when all uninstalled", () => {
    const result = sortTierByInstalled(tier, {} as CliAvailability);
    expect(result).toEqual(["claude", "gemini", "codex"]);
  });

  it("preserves original order when all installed", () => {
    const result = sortTierByInstalled(tier, {
      claude: "ready",
      gemini: "ready",
      codex: "ready",
    } as CliAvailability);
    expect(result).toEqual(["claude", "gemini", "codex"]);
  });

  it("floats installed agents to the front, preserving relative order", () => {
    const result = sortTierByInstalled(tier, {
      claude: "missing",
      gemini: "ready",
      codex: "installed",
    } as CliAvailability);
    expect(result).toEqual(["gemini", "codex", "claude"]);
  });

  it("handles single installed agent", () => {
    const result = sortTierByInstalled(tier, { codex: "ready" } as CliAvailability);
    expect(result).toEqual(["codex", "claude", "gemini"]);
  });

  it("treats missing and undefined availability the same", () => {
    const withMissing = sortTierByInstalled(tier, {
      claude: "missing",
      gemini: "ready",
      codex: "missing",
    } as CliAvailability);
    const withUndefined = sortTierByInstalled(tier, { gemini: "ready" } as CliAvailability);
    expect(withMissing).toEqual(withUndefined);
  });

  it("works with the more-agents tier", () => {
    const moreTier = ["opencode", "cursor", "kiro"] as const;
    const result = sortTierByInstalled(moreTier, {
      cursor: "installed",
      kiro: "missing",
    } as CliAvailability);
    expect(result).toEqual(["cursor", "opencode", "kiro"]);
  });

  it("returns empty array for empty input", () => {
    expect(sortTierByInstalled([], {} as CliAvailability)).toEqual([]);
  });

  it("ignores extra availability keys not in the tier", () => {
    const result = sortTierByInstalled(
      ["claude"] as const,
      { claude: "ready", gemini: "ready" } as CliAvailability
    );
    expect(result).toEqual(["claude"]);
  });
});

describe("tier partition completeness", () => {
  it("FEATURED + MORE covers all BUILT_IN_AGENT_IDS with no overlap", () => {
    const combined = [...FEATURED_AGENT_IDS, ...MORE_AGENT_IDS].sort();
    const expected = [...BUILT_IN_AGENT_IDS].sort();
    expect(combined).toEqual(expected);

    const overlap = FEATURED_AGENT_IDS.filter((id) => MORE_AGENT_IDS.includes(id));
    expect(overlap).toEqual([]);
  });
});

describe("AgentSetupWizard reducer", () => {
  const emptyAvail = {} as CliAvailability;
  const partialAvail = {
    claude: "ready",
    gemini: "missing",
    codex: "missing",
  } as CliAvailability;

  it("always starts at selection step", () => {
    const state = buildInitialState(emptyAvail);
    expect(state.step).toEqual({ type: "selection" });
    expect(state.history).toEqual([]);
  });

  it("advances from selection to cli step when not all installed", () => {
    let state = buildInitialState(partialAvail);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true, codex: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });
  });

  it("skips to complete when all selected agents are installed", () => {
    const allInstalled = { claude: "ready", gemini: "ready" } as CliAvailability;
    let state = buildInitialState(allInstalled);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "complete" });
    expect(state.history).toEqual([{ type: "selection" }]);
  });

  it("goes to cli when at least one selected agent is not installed", () => {
    const partial = { claude: "ready", gemini: "missing" } as CliAvailability;
    let state = buildInitialState(partial);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });
  });

  it("skips to complete when only selected agents are installed (unselected missing)", () => {
    const avail = { claude: "ready", gemini: "missing" } as CliAvailability;
    let state = buildInitialState(avail);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: false },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "complete" });
  });

  it("BACK from complete (after skip) returns to selection, not cli", () => {
    const allInstalled = { claude: "ready", gemini: "ready" } as CliAvailability;
    let state = buildInitialState(allInstalled);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "complete" });

    state = wizardReducer(state, { type: "BACK" });
    expect(state.step).toEqual({ type: "selection" });
    expect(state.history).toEqual([]);
  });

  it("goes to cli when availability changes after init to mark agent uninstalled", () => {
    const allInstalled = { claude: "ready", gemini: "ready" } as CliAvailability;
    let state = buildInitialState(allInstalled);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, {
      type: "SET_AVAILABILITY",
      payload: { claude: "ready", gemini: "missing" } as CliAvailability,
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });
  });

  it("advances from cli to complete", () => {
    let state = buildInitialState(emptyAvail);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });

    state = wizardReducer(state, { type: "CLI_CONTINUE" });
    expect(state.step).toEqual({ type: "complete" });
  });

  it("follows full wizard flow: selection -> cli -> complete", () => {
    let state = buildInitialState(emptyAvail);

    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });

    state = wizardReducer(state, { type: "CLI_CONTINUE" });
    expect(state.step).toEqual({ type: "complete" });

    expect(state.history).toEqual([{ type: "selection" }, { type: "cli" }]);
  });

  it("navigates back through history", () => {
    let state = buildInitialState(emptyAvail);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });

    state = wizardReducer(state, { type: "BACK" });
    expect(state.step).toEqual({ type: "selection" });

    // Back from selection does nothing (empty history)
    const unchanged = wizardReducer(state, { type: "BACK" });
    expect(unchanged.step).toEqual({ type: "selection" });
  });

  it("toggles agent selection", () => {
    let state = buildInitialState(emptyAvail);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: false, gemini: false },
    });
    state = wizardReducer(state, { type: "TOGGLE_SELECTION", agentId: "claude", checked: true });
    expect(state.selections.claude).toBe(true);
    expect(state.selections.gemini).toBe(false);

    state = wizardReducer(state, { type: "TOGGLE_SELECTION", agentId: "claude", checked: false });
    expect(state.selections.claude).toBe(false);
  });

  it("updates availability without changing selections", () => {
    let state = buildInitialState(emptyAvail);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: false },
    });
    state = wizardReducer(state, {
      type: "SET_AVAILABILITY",
      payload: { claude: "ready" } as CliAvailability,
    });
    expect(state.availability.claude).toBe("ready");
    expect(state.selections.claude).toBe(false);
  });

  it("resets to initial state", () => {
    let state = buildInitialState(emptyAvail);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });

    const reset = wizardReducer(state, { type: "RESET", availability: partialAvail });
    expect(reset.step).toEqual({ type: "selection" });
    expect(reset.history).toEqual([]);
    expect(reset.selections).toEqual({});
    expect(reset.availability).toBe(partialAvail);
  });

  it("navigates back from cli to selection and re-confirms", () => {
    let state = buildInitialState(emptyAvail);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });

    state = wizardReducer(state, { type: "BACK" });
    expect(state.step).toEqual({ type: "selection" });

    state = wizardReducer(state, { type: "TOGGLE_SELECTION", agentId: "gemini", checked: false });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });
    expect(state.selections.gemini).toBe(false);
  });
});
