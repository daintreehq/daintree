import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentDictation } from "@shared/types";

const focus = vi.hoisted(() => ({
  target: null as null | { panelId: string; panelTitle?: string; projectId?: string },
  assistantTarget: { panelId: "assistant-1", panelTitle: "Daintree Assistant" },
  assistantLast: false,
}));

vi.mock("@/services/VoiceRecordingService", () => ({
  voiceRecordingService: {
    getFocusedComposerTarget: (assistant: boolean) =>
      assistant ? focus.assistantTarget : focus.target,
  },
}));
vi.mock("@/lib/composerSurface", () => ({ wasAssistantLastFocused: () => focus.assistantLast }));
vi.mock("@/store/macroFocusStore", () => ({ isAssistantFocused: () => false }));

const help = vi.hoisted(() => ({ terminalId: "assistant-1", requestFocus: vi.fn() }));
vi.mock("@/store/helpPanelStore", () => {
  const getState = () => ({ terminalId: help.terminalId, requestFocus: help.requestFocus });
  return {
    useHelpPanelStore: Object.assign(getState, { getState }),
    selectActiveSlot: (state: { terminalId: string }) => state,
  };
});

const panels = vi.hoisted(() => ({
  byId: {} as Record<string, unknown>,
  setPreferredTerminalFocusTarget: vi.fn(),
}));

vi.mock("@/store/panelStore", () => {
  const getState = () => ({
    panelsById: panels.byId,
    setPreferredTerminalFocusTarget: panels.setPreferredTerminalFocusTarget,
  });
  return { usePanelStore: Object.assign(getState, { getState }) };
});

const inputBlock = vi.hoisted(() => ({ current: null as null | { kind: string } }));
vi.mock("@/services/terminal/inputGate", () => ({
  getTerminalInputBlock: () => inputBlock.current,
}));

const focusPanelInput = vi.hoisted(() => vi.fn<(id: string) => boolean>(() => true));
vi.mock("@/components/Panel/panelFocusRegistry", () => ({ focusPanelInput }));

const copyWithToast = vi.hoisted(() => vi.fn<(label: string, value: string) => void>());
vi.mock("@/lib/copyWithToast", () => ({ copyWithToast }));

const { insertRecentDictation, copyRecentDictation, focusRecoveredComposer } =
  await import("../recentDictationRecovery");
const { useTerminalInputStore } = await import("@/store/terminalInputStore");
const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
const { useTypingLocatorStore } = await import("@/store/typingLocatorStore");
const { useFleetArmingStore } = await import("@/store/fleetArmingStore");

const DICTATION: RecentDictation = {
  id: "session-1",
  rawText: "fix the parsr\nthen the lexr",
  correctedText: "Fix the parser.\nThen the lexer.",
  target: { panelId: "panel-old", panelTitle: "Somewhere else" },
  endedAt: 1,
};

const draft = (panelId: string) => useTerminalInputStore.getState().getDraftInput(panelId);
const pill = () => useTypingLocatorStore.getState().message;

describe("recentDictationRecovery", () => {
  beforeEach(() => {
    focus.target = { panelId: "panel-1", panelTitle: "Claude" };
    focus.assistantLast = false;
    help.requestFocus.mockClear();
    panels.byId = { "panel-1": { id: "panel-1", kind: "terminal", location: "grid" } };
    useTerminalInputStore.getState().clearAllDraftInputs();
    useTerminalInputStore.setState({ voiceSubmittingPanels: new Set() });
    useVoiceRecordingStore.setState({ status: "idle", activeTarget: null, pendingTarget: null });
    useTypingLocatorStore.getState().clearLocator();
    useFleetArmingStore.setState({ armedIds: new Set() });
    inputBlock.current = null;
    panels.setPreferredTerminalFocusTarget.mockClear();
    focusPanelInput.mockClear();
    copyWithToast.mockClear();
  });

  it("appends the cleaned text to the focused composer's draft and names where it went", () => {
    useTerminalInputStore.getState().setDraftInput("panel-1", "Context first:");
    const revision = useTerminalInputStore.getState().externalDraftRevision;

    expect(insertRecentDictation(DICTATION)).toBe("panel-1");
    // A mounted editor only picks up an outside write when the revision moves.
    expect(useTerminalInputStore.getState().externalDraftRevision).toBe(revision + 1);
    expect(draft("panel-1")).toBe("Context first: Fix the parser.\nThen the lexer.");
    expect(draft("panel-old")).toBe("");
    expect(pill()).toMatchObject({ kind: "draft-added", target: "Claude" });
  });

  it("adds the original when asked, without a separator after whitespace", () => {
    useTerminalInputStore.getState().setDraftInput("panel-1", "Typed\n");

    insertRecentDictation(DICTATION, "original");
    expect(draft("panel-1")).toBe("Typed\nfix the parsr\nthen the lexr");
  });

  it("refuses with nowhere focused to put it", () => {
    focus.target = null;

    expect(insertRecentDictation(DICTATION)).toBeNull();
    expect(pill()?.kind).toBe("draft-refused");
  });

  it.each([
    [
      "a session is recording there",
      () =>
        useVoiceRecordingStore.setState({
          status: "recording",
          activeTarget: { panelId: "panel-1" },
        }),
    ],
    [
      "a session is finishing there",
      () =>
        useVoiceRecordingStore.setState({
          status: "finishing",
          activeTarget: { panelId: "panel-1" },
        }),
    ],
    [
      "a start is queued for it",
      () => useVoiceRecordingStore.setState({ pendingTarget: { panelId: "panel-1" } }),
    ],
    [
      "it is sending a dictation",
      () => useTerminalInputStore.setState({ voiceSubmittingPanels: new Set(["panel-1"]) }),
    ],
    [
      "it is one of an armed fleet, which mirrors its draft",
      () => useFleetArmingStore.setState({ armedIds: new Set(["panel-1", "panel-2"]) }),
    ],
    [
      "another screen drives the project and replaces its draft",
      () => {
        inputBlock.current = { kind: "driven-elsewhere" };
      },
    ],
    [
      "its input is locked",
      () => {
        panels.byId = {
          "panel-1": { id: "panel-1", kind: "terminal", location: "grid", isInputLocked: true },
        };
      },
    ],
  ])("leaves the draft alone while %s", (_label, arrange) => {
    useTerminalInputStore.getState().setDraftInput("panel-1", "mid-flow");
    arrange();

    expect(insertRecentDictation(DICTATION)).toBeNull();
    expect(draft("panel-1")).toBe("mid-flow");
    expect(pill()?.kind).toBe("draft-refused");
  });

  it("still adds to a composer while another panel is being dictated into", () => {
    useVoiceRecordingStore.setState({ status: "recording", activeTarget: { panelId: "panel-2" } });

    expect(insertRecentDictation(DICTATION)).toBe("panel-1");
    expect(draft("panel-1")).toBe(DICTATION.correctedText);
  });

  it("aims at the assistant when it was the last place the user worked", () => {
    // The palette or menu holds the keyboard now, so only the tracker knows.
    focus.assistantLast = true;

    expect(insertRecentDictation(DICTATION)).toBe("assistant-1");
    expect(draft("assistant-1")).toBe(DICTATION.correctedText);
    expect(draft("panel-1")).toBe("");
  });

  it("focuses the assistant its own way, not through the grid's focus registry", () => {
    focusRecoveredComposer("assistant-1");

    expect(help.requestFocus).toHaveBeenCalledTimes(1);
    expect(focusPanelInput).not.toHaveBeenCalled();
  });

  it("hands the keyboard to the input bar, even when the terminal had it last", () => {
    focusRecoveredComposer("panel-1");

    expect(panels.setPreferredTerminalFocusTarget).toHaveBeenCalledWith("hybridInput");
    expect(focusPanelInput).toHaveBeenCalledWith("panel-1");
    expect(panels.setPreferredTerminalFocusTarget.mock.invocationCallOrder[0]).toBeLessThan(
      focusPanelInput.mock.invocationCallOrder[0]!
    );
  });

  it("copies either version through the shared menu-row copy", () => {
    copyRecentDictation(DICTATION);
    copyRecentDictation(DICTATION, "original");

    expect(copyWithToast.mock.calls).toEqual([
      ["Dictation", DICTATION.correctedText],
      ["Dictation", DICTATION.rawText],
    ]);
  });
});
