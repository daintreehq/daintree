import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drives the real voice, draft and dictation-range stores through the IPC
// callbacks: every final the service writes is recorded as a range on the
// text it wrote, and the draft itself comes out exactly as before (#14597).

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
type FileTokenPayload = { description: string; replacement: string };

const callbacks: {
  delta: ((payload: DeltaPayload) => void) | null;
  complete: ((payload: CompletePayload) => void) | null;
  boundary: ((payload: { rawText: string | null }) => void) | null;
  fileToken: ((payload: FileTokenPayload) => void) | null;
} = { delta: null, complete: null, boundary: null, fileToken: null };

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
      onFileTokenResolved: vi.fn((cb: (payload: FileTokenPayload) => void) => {
        callbacks.fileToken = cb;
        return () => {};
      }),
      onError: vi.fn(() => () => {}),
      onStatus: vi.fn(() => () => {}),
      getSettings: vi.fn().mockResolvedValue({ enabled: false }),
      stop: vi.fn().mockResolvedValue(undefined),
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

const PANEL = "panel-1";
const PROJECT = "project-1";

async function setup(initialDraft = "") {
  stubElectron();
  const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
  const { useTerminalInputStore } = await import("@/store/terminalInputStore");
  const { useDictationRangeStore, subscribeDictationRangeTracking } =
    await import("@/store/dictationRangeStore");
  const { voiceRecordingService } = await import("../VoiceRecordingService");

  unsubscribe = subscribeDictationRangeTracking();
  voiceRecordingService.initialize();
  const inputs = useTerminalInputStore.getState();
  if (initialDraft) inputs.setDraftInput(PANEL, initialDraft, PROJECT);

  const begin = () =>
    useVoiceRecordingStore.getState().beginSession({ panelId: PANEL, projectId: PROJECT });
  begin();

  const draft = () => useTerminalInputStore.getState().getDraftInput(PANEL, PROJECT);
  const setDraft = (value: string) =>
    useTerminalInputStore.getState().setDraftInput(PANEL, value, PROJECT);
  const records = () => useDictationRangeStore.getState().listDictations(PANEL, PROJECT);
  const textOf = (range: { from: number; to: number }) => draft().slice(range.from, range.to);
  const sessionId = () =>
    useVoiceRecordingStore.getState().panelBuffers[PANEL]?.dictationSessionId ?? null;
  return { service: voiceRecordingService, begin, draft, setDraft, records, textOf, sessionId };
}

let unsubscribe: (() => void) | null = null;

const delta = (text: string, itemId?: string) => callbacks.delta!({ text, itemId });
const complete = (text: string, itemId?: string) =>
  callbacks.complete!({ text, willCorrect: false, itemId });

describe("VoiceRecordingService — dictation ranges (#14597)", () => {
  beforeEach(() => {
    vi.resetModules();
    callbacks.delta = null;
    callbacks.complete = null;
    callbacks.boundary = null;
    callbacks.fileToken = null;
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    vi.unstubAllGlobals();
  });

  it("records each unidentified final on the text it wrote", async () => {
    const { draft, records, textOf, sessionId } = await setup("Existing.");

    delta("hel");
    delta("lo");
    expect(records()).toEqual([]);
    complete("Hello.");
    delta("again");
    complete("Again.");

    expect(draft()).toBe("Existing. Hello. Again.");
    const [record] = records();
    expect(record!.sessionId).toBe(sessionId());
    expect(textOf(record!.range)).toBe(" Hello. Again.");
    expect(record!.utterances.map((u) => textOf(u.range))).toEqual(["Hello.", "Again."]);
    expect(record!.range.edited).toBe(false);
  });

  it("records identified items in the order they land", async () => {
    const { draft, records, textOf } = await setup();

    delta("one", "item-a");
    delta("two", "item-b");
    complete("One.", "item-a");
    complete("Two.", "item-b");

    expect(draft()).toBe("One. Two.");
    expect(records()[0]!.utterances.map((u) => textOf(u.range))).toEqual(["One.", "Two."]);
  });

  it("tells repeated item ids apart across a paragraph break", async () => {
    const { draft, records, textOf } = await setup();

    delta("first", "item-a");
    complete("First.", "item-a");
    callbacks.boundary!({ rawText: null });
    complete("Second para.", "item-a");

    expect(draft()).toBe("First.\nSecond para.");
    const [record] = records();
    expect(textOf(record!.range)).toBe("First.\nSecond para.");
    expect(record!.range.edited).toBe(false);
    const ids = record!.utterances.map((u) => u.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("records nothing for an empty final", async () => {
    const { draft, records } = await setup("keep");

    delta("um", "item-a");
    complete("", "item-a");

    expect(draft()).toBe("keep");
    expect(records()).toEqual([]);
  });

  it("follows typing before and after the dictation, and flags typing inside it", async () => {
    const { draft, setDraft, records, textOf } = await setup();

    complete("Hello there.", "item-a");
    setDraft("Note: " + draft());
    setDraft(draft() + " Thanks.");
    expect(textOf(records()[0]!.range)).toBe("Hello there.");
    expect(records()[0]!.range.edited).toBe(false);

    setDraft(draft().replace("Hello there", "Hello over there"));
    expect(textOf(records()[0]!.range)).toBe("Hello over there.");
    expect(records()[0]!.range.edited).toBe(true);
  });

  it("records the stop flush of unfinished speech", async () => {
    const { service, draft, records, textOf } = await setup("Prefix");

    delta("half a thought");
    await service.stop("Dictation stopped.", { skipRemoteStop: true, preserveLiveText: true });

    expect(draft()).toBe("Prefix half a thought");
    const [record] = records();
    expect(textOf(record!.range)).toBe(" half a thought");
    expect(textOf(record!.utterances[0]!.range)).toBe("half a thought");
  });

  it("keeps a session's ranges after the stop and beside the next session's", async () => {
    const { service, begin, records, textOf, sessionId } = await setup();

    complete("First session.", "item-a");
    const first = sessionId();
    await service.stop("Dictation stopped.", { skipRemoteStop: true });
    begin();
    complete("Second session.", "item-b");

    const list = records();
    expect(list.map((r) => r.sessionId)).toEqual([first, sessionId()]);
    expect(list.map((r) => textOf(r.range))).toEqual(["First session.", " Second session."]);
  });

  it("releases the ranges on send and starts a fresh record for later speech", async () => {
    const { draft, setDraft, records, textOf, sessionId } = await setup();

    complete("Sent part.", "item-a");
    const sentId = records()[0]!.id;
    setDraft("");
    expect(records()).toEqual([]);

    complete("Kept part.", "item-b");
    expect(draft()).toBe("Kept part.");
    const [record] = records();
    expect(record!.id).not.toBe(sentId);
    expect(record!.sessionId).toBe(sessionId());
    expect(textOf(record!.range)).toBe("Kept part.");
  });

  it("flags a dictation a file-link swap rewrote, leaving the swap itself unchanged", async () => {
    const { draft, records } = await setup();

    complete("Open the readme file.", "item-a");
    callbacks.fileToken!({ description: "the readme file", replacement: "@README.md" });

    expect(draft()).toBe("Open @README.md.");
    expect(records()[0]!.utterances[0]!.range.edited).toBe(true);
  });
});
