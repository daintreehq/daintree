import { describe, expect, it } from "vitest";
import { buildInitialState, wizardReducer } from "../AgentSetupWizard";

describe("AgentSetupWizard reducer", () => {
  const emptyAvail: Record<string, string> = {};
  const partialAvail: Record<string, string> = {
    claude: "ready",
    gemini: "missing",
    codex: "missing",
  };

  it("starts at health step by default", () => {
    const state = buildInitialState(emptyAvail, false);
    expect(state.step).toEqual({ type: "health" });
    expect(state.history).toEqual([]);
  });

  it("starts at selection step when skipHealth is true", () => {
    const state = buildInitialState(emptyAvail, true);
    expect(state.step).toEqual({ type: "selection" });
  });

  it("advances from health to selection", () => {
    const state = buildInitialState(emptyAvail, false);
    const next = wizardReducer(state, { type: "HEALTH_CONTINUE" });
    expect(next.step).toEqual({ type: "selection" });
    expect(next.history).toEqual([{ type: "health" }]);
  });

  it("advances from selection to cli step", () => {
    let state = buildInitialState(partialAvail, false);
    state = wizardReducer(state, { type: "HEALTH_CONTINUE" });
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true, codex: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });
  });

  it("advances from selection to cli even when all agents installed", () => {
    const allInstalled: Record<string, string> = { claude: "ready", gemini: "ready" };
    let state = buildInitialState(allInstalled, true);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });
  });

  it("advances from cli to complete", () => {
    let state = buildInitialState(emptyAvail, true);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });

    state = wizardReducer(state, { type: "CLI_CONTINUE" });
    expect(state.step).toEqual({ type: "complete" });
  });

  it("follows full wizard flow: health -> selection -> cli -> complete", () => {
    let state = buildInitialState(emptyAvail, false);

    state = wizardReducer(state, { type: "HEALTH_CONTINUE" });
    expect(state.step).toEqual({ type: "selection" });

    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });

    state = wizardReducer(state, { type: "CLI_CONTINUE" });
    expect(state.step).toEqual({ type: "complete" });

    expect(state.history).toEqual([{ type: "health" }, { type: "selection" }, { type: "cli" }]);
  });

  it("navigates back through history", () => {
    let state = buildInitialState(emptyAvail, false);
    state = wizardReducer(state, { type: "HEALTH_CONTINUE" });
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });

    state = wizardReducer(state, { type: "BACK" });
    expect(state.step).toEqual({ type: "selection" });

    state = wizardReducer(state, { type: "BACK" });
    expect(state.step).toEqual({ type: "health" });

    // Back from health does nothing
    const unchanged = wizardReducer(state, { type: "BACK" });
    expect(unchanged.step).toEqual({ type: "health" });
  });

  it("toggles agent selection", () => {
    let state = buildInitialState(emptyAvail, true);
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
    let state = buildInitialState(emptyAvail, true);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: false },
    });
    state = wizardReducer(state, {
      type: "SET_AVAILABILITY",
      payload: { claude: "ready" },
    });
    expect(state.availability.claude).toBe("ready");
    expect(state.selections.claude).toBe(false); // selections unchanged
  });

  it("resets to initial state", () => {
    let state = buildInitialState(emptyAvail, false);
    state = wizardReducer(state, { type: "HEALTH_CONTINUE" });
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true },
    });

    const reset = wizardReducer(state, { type: "RESET", availability: partialAvail });
    expect(reset.step).toEqual({ type: "health" });
    expect(reset.history).toEqual([]);
    expect(reset.selections).toEqual({});
    expect(reset.availability).toBe(partialAvail);
  });

  it("navigates back from cli to selection and re-confirms", () => {
    let state = buildInitialState(emptyAvail, true);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });

    // Go back to selection
    state = wizardReducer(state, { type: "BACK" });
    expect(state.step).toEqual({ type: "selection" });

    // Change selections and re-confirm
    state = wizardReducer(state, { type: "TOGGLE_SELECTION", agentId: "gemini", checked: false });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });
    expect(state.selections.gemini).toBe(false);
  });
});
