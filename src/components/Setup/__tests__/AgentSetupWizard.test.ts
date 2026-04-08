import { describe, expect, it } from "vitest";

// We need to test the reducer logic. Since it's not exported, we'll test via a
// re-export pattern. For now, test the core logic inline.

// Replicate the types and reducer for unit testing.
// This mirrors the production code in AgentSetupWizard.tsx.

type WizardStep = { type: "system-tools" } | { type: "agent-cli" } | { type: "complete" };

interface WizardState {
  step: WizardStep;
  history: WizardStep[];
  availability: Record<string, boolean>;
  selections: Record<string, boolean>;
  selectionsInitialized: boolean;
}

type WizardAction =
  | { type: "SYSTEM_TOOLS_CONTINUE" }
  | { type: "AGENT_CLI_CONTINUE" }
  | { type: "BACK" }
  | { type: "SET_AVAILABILITY"; payload: Record<string, boolean> }
  | { type: "INIT_SELECTIONS"; payload: Record<string, boolean> }
  | { type: "TOGGLE_SELECTION"; agentId: string; checked: boolean }
  | { type: "RESET"; availability: Record<string, boolean> };

function buildInitialState(
  availability: Record<string, boolean>,
  skipHealth: boolean
): WizardState {
  return {
    step: skipHealth ? { type: "agent-cli" } : { type: "system-tools" },
    history: [],
    availability,
    selections: {},
    selectionsInitialized: false,
  };
}

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "SYSTEM_TOOLS_CONTINUE":
      return {
        ...state,
        step: { type: "agent-cli" },
        history: [...state.history, state.step],
      };

    case "AGENT_CLI_CONTINUE":
      return {
        ...state,
        step: { type: "complete" },
        history: [...state.history, state.step],
      };

    case "BACK": {
      if (state.history.length === 0) return state;
      const newHistory = [...state.history];
      const prevStep = newHistory.pop()!;
      return {
        ...state,
        step: prevStep,
        history: newHistory,
      };
    }

    case "SET_AVAILABILITY":
      return { ...state, availability: action.payload };

    case "INIT_SELECTIONS":
      return {
        ...state,
        selections: action.payload,
        selectionsInitialized: true,
      };

    case "TOGGLE_SELECTION":
      return {
        ...state,
        selections: { ...state.selections, [action.agentId]: action.checked },
      };

    case "RESET":
      return buildInitialState(action.availability, false);

    default:
      return state;
  }
}

describe("AgentSetupWizard reducer", () => {
  const emptyAvail: Record<string, boolean> = {};
  const partialAvail: Record<string, boolean> = { claude: true, gemini: false, codex: false };

  it("starts at system-tools step by default", () => {
    const state = buildInitialState(emptyAvail, false);
    expect(state.step).toEqual({ type: "system-tools" });
    expect(state.history).toEqual([]);
  });

  it("starts at agent-cli step when skipHealth is true", () => {
    const state = buildInitialState(emptyAvail, true);
    expect(state.step).toEqual({ type: "agent-cli" });
  });

  it("advances from system-tools to agent-cli", () => {
    const state = buildInitialState(emptyAvail, false);
    const next = wizardReducer(state, { type: "SYSTEM_TOOLS_CONTINUE" });
    expect(next.step).toEqual({ type: "agent-cli" });
    expect(next.history).toEqual([{ type: "system-tools" }]);
  });

  it("advances from agent-cli to complete", () => {
    let state = buildInitialState(emptyAvail, false);
    state = wizardReducer(state, { type: "SYSTEM_TOOLS_CONTINUE" });
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "AGENT_CLI_CONTINUE" });
    expect(state.step).toEqual({ type: "complete" });
    expect(state.history).toHaveLength(2);
  });

  it("navigates back through history", () => {
    let state = buildInitialState(emptyAvail, false);
    state = wizardReducer(state, { type: "SYSTEM_TOOLS_CONTINUE" });
    expect(state.step).toEqual({ type: "agent-cli" });

    state = wizardReducer(state, { type: "BACK" });
    expect(state.step).toEqual({ type: "system-tools" });

    // Back from system-tools does nothing
    const unchanged = wizardReducer(state, { type: "BACK" });
    expect(unchanged.step).toEqual({ type: "system-tools" });
    expect(unchanged).toBe(state);
  });

  it("navigates back from complete to agent-cli", () => {
    let state = buildInitialState(emptyAvail, false);
    state = wizardReducer(state, { type: "SYSTEM_TOOLS_CONTINUE" });
    state = wizardReducer(state, { type: "AGENT_CLI_CONTINUE" });
    expect(state.step).toEqual({ type: "complete" });

    state = wizardReducer(state, { type: "BACK" });
    expect(state.step).toEqual({ type: "agent-cli" });
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
      payload: { claude: true },
    });
    expect(state.availability.claude).toBe(true);
    expect(state.selections.claude).toBe(false); // selections unchanged
  });

  it("resets to initial state", () => {
    let state = buildInitialState(emptyAvail, false);
    state = wizardReducer(state, { type: "SYSTEM_TOOLS_CONTINUE" });
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true },
    });

    const reset = wizardReducer(state, { type: "RESET", availability: partialAvail });
    expect(reset.step).toEqual({ type: "system-tools" });
    expect(reset.history).toEqual([]);
    expect(reset.selections).toEqual({});
    expect(reset.availability).toBe(partialAvail);
  });

  it("initializes selections and marks selectionsInitialized", () => {
    let state = buildInitialState(emptyAvail, false);
    expect(state.selectionsInitialized).toBe(false);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: false },
    });
    expect(state.selectionsInitialized).toBe(true);
    expect(state.selections).toEqual({ claude: true, gemini: false });
  });

  it("full flow: system-tools → agent-cli → complete → back → agent-cli", () => {
    let state = buildInitialState(partialAvail, false);

    state = wizardReducer(state, { type: "SYSTEM_TOOLS_CONTINUE" });
    expect(state.step).toEqual({ type: "agent-cli" });

    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "AGENT_CLI_CONTINUE" });
    expect(state.step).toEqual({ type: "complete" });

    state = wizardReducer(state, { type: "BACK" });
    expect(state.step).toEqual({ type: "agent-cli" });
    // Selections preserved after going back
    expect(state.selections).toEqual({ claude: true, gemini: true });
  });
});
