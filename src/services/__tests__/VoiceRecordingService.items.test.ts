import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drives the real voice store through the IPC callbacks to prove per-item
// reconciliation (#13109): each identified completion retires only its own
// preview and appends to the current draft, independent of other items.

const draftState = vi.hoisted(() => ({ draft: "" }));

vi.mock("@/store/terminalInputStore", () => {
  const fns = {
    getDraftInput: vi.fn(() => draftState.draft),
    setDraftInput: vi.fn((_panelId: string, value: string) => {
      draftState.draft = value;
    }),
    bumpExternalDraftRevision: vi.fn(),
  };
  const getState = () => fns;
  return { useTerminalInputStore: Object.assign(getState, { getState }) };
});

vi.mock("@/store/panelStore", () => {
  const state = { panelsById: {}, panelIds: [], focusedId: null };
  const getState = () => state;
  return { usePanelStore: Object.assign(getState, { getState, subscribe: vi.fn(() => () => {}) }) };
});

vi.mock("@/store/projectStore", () => {
  const getState = () => ({ currentProject: null, isSwitching: false, switchProject: vi.fn() });
  return { useProjectStore: Object.assign(getState, { getState }) };
});

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ worktrees: new Map() }) }),
}));

vi.mock("@/store/worktreeStore", () => {
  const getState = () => ({ activeWorktreeId: null, selectWorktree: vi.fn() });
  return { useWorktreeSelectionStore: Object.assign(getState, { getState }) };
});

vi.mock("@/store/helpPanelStore", () => {
  const state = { isOpen: false, terminalId: null };
  const getState = () => ({ ...state, setOpen: vi.fn(), requestFocus: vi.fn() });
  return {
    useHelpPanelStore: Object.assign(getState, { getState }),
    selectActiveSlot: (s: typeof state) => s,
  };
});

vi.mock("@/store/macroFocusStore", () => ({ isAssistantFocused: vi.fn(() => false) }));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: vi.fn(),
    getEffectiveCombos: vi.fn(() => []),
    matchesEvent: vi.fn(),
  },
}));

type DeltaPayload = { text: string; itemId?: string };
type CompletePayload = { text: string; willCorrect: boolean; itemId?: string };

const callbacks: {
  delta: ((payload: DeltaPayload) => void) | null;
  complete: ((payload: CompletePayload) => void) | null;
  boundary: ((payload: { rawText: string | null }) => void) | null;
} = { delta: null, complete: null, boundary: null };

function stubElectron() {
  const electron = {
    voiceInput: {
      onTranscriptionDelta: vi.fn((cb: (payload: DeltaPayload) => void) => {
        callbacks.delta = cb;
        return () => {};
      }),
      onTranscriptionComplete: vi.fn((cb: (payload: CompletePayload) => void) => {
        callbacks.complete = cb;
        return () => {};
      }),
      onParagraphBoundary: vi.fn((cb: (payload: { rawText: string | null }) => void) => {
        callbacks.boundary = cb;
        return () => {};
      }),
      onFileTokenResolved: vi.fn(() => () => {}),
      onError: vi.fn(() => () => {}),
      onStatus: vi.fn(() => () => {}),
      getSettings: vi.fn().mockResolvedValue({ enabled: false }),
    },
    systemSleep: {
      onSuspend: vi.fn(() => () => {}),
      onWake: vi.fn(() => () => {}),
    },
  };
  vi.stubGlobal("window", {
    electron,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    requestAnimationFrame: vi.fn(),
    cancelAnimationFrame: vi.fn(),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

const PANEL_ID = "panel-1";

async function setup() {
  stubElectron();
  const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
  const { voiceRecordingService } = await import("../VoiceRecordingService");
  voiceRecordingService.initialize();
  useVoiceRecordingStore.getState().beginSession({ panelId: PANEL_ID });
  const liveText = () => useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.liveText;
  return { liveText };
}

const delta = (text: string, itemId?: string) => callbacks.delta!({ text, itemId });
const complete = (text: string, itemId?: string) =>
  callbacks.complete!({ text, willCorrect: false, itemId });

describe("VoiceRecordingService — identified items (#13109)", () => {
  beforeEach(() => {
    vi.resetModules();
    draftState.draft = "";
    callbacks.delta = null;
    callbacks.complete = null;
    callbacks.boundary = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the next item's early deltas when the previous item completes", async () => {
    const { liveText } = await setup();
    draftState.draft = "existing";

    delta("hello", "item-a");
    delta("next", "item-b");
    expect(liveText()).toBe("hello next");

    complete("Hello.", "item-a");
    expect(draftState.draft).toBe("existing Hello.");
    expect(liveText()).toBe("next");

    delta(" words", "item-b");
    complete("Next words.", "item-b");
    expect(draftState.draft).toBe("existing Hello. Next words.");
    expect(liveText()).toBe("");
  });

  it("appends each completion to the current draft rather than a stale segment offset", async () => {
    await setup();
    draftState.draft = "prefix";

    delta("one", "item-a");
    complete("One.", "item-a");
    // User types between segments; a later item must not slice it away.
    draftState.draft += " typed";
    delta("two", "item-b");
    complete("Two.", "item-b");

    expect(draftState.draft).toBe("prefix One. typed Two.");
  });

  it("keeps later items' previews across a paragraph split inside an earlier item", async () => {
    const { liveText } = await setup();

    delta("first", "item-a");
    delta("later", "item-b");
    complete("First.", "item-a");
    callbacks.boundary!({ rawText: null });
    complete("Second para.", "item-a");

    expect(draftState.draft).toBe("First.\nSecond para.");
    expect(liveText()).toBe("later");
  });

  it("drops an item's preview on an identified empty completion without writing", async () => {
    const { liveText } = await setup();
    draftState.draft = "keep";

    delta("um", "item-a");
    complete("", "item-a");

    expect(draftState.draft).toBe("keep");
    expect(liveText()).toBe("");
  });

  it("still splices unidentified completions at the segment start", async () => {
    const { liveText } = await setup();
    draftState.draft = "existing";

    delta("hel");
    delta("lo");
    complete("Hello.");

    expect(draftState.draft).toBe("existing Hello.");
    expect(liveText()).toBe("");
  });
});
