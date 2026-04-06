import { describe, expect, it } from "vitest";

// We need to test the reducer logic. Since it's not exported, we'll test via a
// re-export pattern. For now, test the core logic inline.

// Replicate the types and reducer for unit testing.
// This mirrors the production code in AgentSetupWizard.tsx.

const AGENT_ORDER = ["claude", "gemini", "codex", "opencode", "cursor"];

type WizardStep =
  | { type: "health" }
  | { type: "selection" }
  | { type: "agent"; agentId: string }
  | { type: "complete" };

interface WizardState {
  step: WizardStep;
  history: WizardStep[];
  availability: Record<string, boolean>;
  selections: Record<string, boolean>;
  agentQueue: string[];
  selectionsInitialized: boolean;
}

type WizardAction =
  | { type: "HEALTH_CONTINUE" }
  | { type: "SELECTION_CONTINUE" }
  | { type: "AGENT_NEXT" }
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
    step: skipHealth ? { type: "selection" } : { type: "health" },
    history: [],
    availability,
    selections: {},
    agentQueue: [],
    selectionsInitialized: false,
  };
}

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "HEALTH_CONTINUE":
      return {
        ...state,
        step: { type: "selection" },
        history: [...state.history, state.step],
      };

    case "SELECTION_CONTINUE": {
      const queue = AGENT_ORDER.filter(
        (id) => state.selections[id] && state.availability[id] !== true
      );
      const nextStep: WizardStep =
        queue.length > 0 ? { type: "agent", agentId: queue[0] } : { type: "complete" };
      return {
        ...state,
        step: nextStep,
        history: [...state.history, state.step],
        agentQueue: queue,
      };
    }

    case "AGENT_NEXT": {
      if (state.step.type !== "agent") return state;
      const idx = state.agentQueue.indexOf(state.step.agentId);
      const nextStep: WizardStep =
        idx < state.agentQueue.length - 1
          ? { type: "agent", agentId: state.agentQueue[idx + 1] }
          : { type: "complete" };
      return {
        ...state,
        step: nextStep,
        history: [...state.history, state.step],
      };
    }

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

  it("advances from selection to first uninstalled selected agent", () => {
    let state = buildInitialState(partialAvail, false);
    state = wizardReducer(state, { type: "HEALTH_CONTINUE" });
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true, codex: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    // claude is installed, so queue should be [gemini, codex]
    expect(state.agentQueue).toEqual(["gemini", "codex"]);
    expect(state.step).toEqual({ type: "agent", agentId: "gemini" });
  });

  it("skips to complete when all selected agents are installed", () => {
    const allInstalled: Record<string, boolean> = { claude: true, gemini: true };
    let state = buildInitialState(allInstalled, true);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.agentQueue).toEqual([]);
    expect(state.step).toEqual({ type: "complete" });
  });

  it("skips to complete when no agents are selected", () => {
    let state = buildInitialState(emptyAvail, true);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: false, gemini: false },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.agentQueue).toEqual([]);
    expect(state.step).toEqual({ type: "complete" });
  });

  it("advances through agent queue", () => {
    let state = buildInitialState(emptyAvail, true);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true, codex: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "agent", agentId: "claude" });

    state = wizardReducer(state, { type: "AGENT_NEXT" });
    expect(state.step).toEqual({ type: "agent", agentId: "gemini" });

    state = wizardReducer(state, { type: "AGENT_NEXT" });
    expect(state.step).toEqual({ type: "agent", agentId: "codex" });

    state = wizardReducer(state, { type: "AGENT_NEXT" });
    expect(state.step).toEqual({ type: "complete" });
  });

  it("navigates back through history", () => {
    let state = buildInitialState(emptyAvail, false);
    state = wizardReducer(state, { type: "HEALTH_CONTINUE" });
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.step).toEqual({ type: "agent", agentId: "claude" });

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
      payload: { claude: true },
    });
    expect(state.availability.claude).toBe(true);
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
    expect(reset.agentQueue).toEqual([]);
    expect(reset.availability).toBe(partialAvail);
  });

  it("AGENT_NEXT is no-op when not on agent step", () => {
    const state = buildInitialState(emptyAvail, true);
    const next = wizardReducer(state, { type: "AGENT_NEXT" });
    expect(next).toBe(state);
  });

  it("rebuilds queue when going back to selection and re-confirming", () => {
    let state = buildInitialState(emptyAvail, true);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.agentQueue).toEqual(["claude", "gemini"]);

    // Go back to selection
    state = wizardReducer(state, { type: "BACK" });
    expect(state.step).toEqual({ type: "selection" });

    // Change selections
    state = wizardReducer(state, { type: "TOGGLE_SELECTION", agentId: "gemini", checked: false });
    state = wizardReducer(state, { type: "SELECTION_CONTINUE" });
    expect(state.agentQueue).toEqual(["claude"]);
    expect(state.step).toEqual({ type: "agent", agentId: "claude" });
  });
});
