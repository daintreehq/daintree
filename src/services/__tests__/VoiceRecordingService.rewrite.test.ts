import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drives the real voice and draft stores through a rewrite session (#14635):
// the spoken instruction never reaches the draft, and the model's result lands
// on the captured selection only.

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

const notify = vi.hoisted(() =>
  vi.fn<(payload: { title: string; action?: { onClick: () => void } }) => void>()
);
vi.mock("@/lib/notify", () => ({ notify }));

const composer = vi.hoisted(() => ({ source: null as unknown }));
vi.mock("@/services/voiceRewriteSelection", () => ({
  findRewriteComposer: () => composer.source,
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: vi.fn(),
    getEffectiveCombos: vi.fn(() => []),
    matchesEvent: vi.fn(),
  },
}));

type DeltaPayload = { sessionId?: string; text: string; itemId?: string };
type CompletePayload = {
  sessionId?: string;
  text: string;
  willCorrect: boolean;
  itemId?: string;
  send?: boolean;
};
type RewriteOutcome =
  | { status: "replace"; text: string }
  | { status: "no_change" | "rejected" | "unavailable" | "failed" };

const callbacks: {
  delta: ((payload: DeltaPayload) => void) | null;
  complete: ((payload: CompletePayload) => void) | null;
  boundary: ((payload: { rawText: string | null }) => void) | null;
} = { delta: null, complete: null, boundary: null };

const rewrite =
  vi.fn<(request: { selectedText: string; instruction: string }) => Promise<RewriteOutcome>>();
const correct = vi.fn();
const cancel = vi.fn<(sessionId: string) => Promise<void>>();

const windowListeners: Record<string, Array<(...args: unknown[]) => void>> = {};

function stubElectron(openaiApiKey = "sk-key", recordingMode?: string) {
  for (const event of Object.keys(windowListeners)) delete windowListeners[event];
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
      onSessionEnded: vi.fn(() => () => {}),
      onLiveSession: vi.fn(() => () => {}),
      onStopRequested: vi.fn(() => () => {}),
      onRevealRequested: vi.fn(() => () => {}),
      getLiveSession: vi.fn().mockResolvedValue({ revision: 0, session: null }),
      getSettings: vi.fn().mockResolvedValue({
        enabled: true,
        openaiApiKey,
        correctionEnabled: true,
        ...(recordingMode ? { recordingMode } : {}),
      }),
      stop: vi.fn().mockResolvedValue(undefined),
      cancel,
      correct,
      rewrite,
    },
    systemSleep: {
      onSuspend: vi.fn(() => () => {}),
      onWake: vi.fn(() => () => {}),
    },
  };
  vi.stubGlobal("window", {
    electron,
    addEventListener: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      windowListeners[event] ??= [];
      windowListeners[event].push(cb);
    }),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A captured selection, lost on demand the way an edit inside it would lose it. */
function fakeSelection(text: string) {
  let lost = false;
  const listeners: Array<() => void> = [];
  return {
    text,
    range: vi.fn(() => (lost ? null : { from: 4, to: 4 + text.length })),
    onLost: vi.fn((listener: () => void) => {
      if (lost) listener();
      else listeners.push(listener);
    }),
    apply: vi.fn(() => !lost),
    release: vi.fn(() => {
      lost = true;
    }),
    edit: () => {
      lost = true;
      for (const listener of listeners.splice(0)) listener();
    },
  };
}

async function setup(openaiApiKey?: string, recordingMode?: string) {
  stubElectron(openaiApiKey, recordingMode);
  const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
  const { useTerminalInputStore } = await import("@/store/terminalInputStore");
  const { voiceRecordingService } = await import("../VoiceRecordingService");
  voiceRecordingService.initialize();
  await voiceRecordingService.refreshConfiguration();

  let itemSeq = 0;
  const say = (text: string) => {
    const itemId = `item-${++itemSeq}`;
    callbacks.delta!({ text, itemId });
    callbacks.complete!({ text, willCorrect: false, itemId });
  };
  const recordInstruction = (selection: ReturnType<typeof fakeSelection>) => {
    useVoiceRecordingStore.getState().beginSession({
      panelId: "panel-1",
      rewrite: { selection, instruction: [], cancelled: false },
    });
  };
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    service: voiceRecordingService,
    voiceStore: useVoiceRecordingStore,
    draft: () => useTerminalInputStore.getState().getDraftInput("panel-1"),
    inputStore: useTerminalInputStore,
    say,
    recordInstruction,
    flush,
  };
}

describe("VoiceRecordingService — rewrite selection by voice (#14635)", () => {
  beforeEach(() => {
    vi.resetModules();
    callbacks.delta = null;
    callbacks.complete = null;
    callbacks.boundary = null;
    rewrite.mockReset();
    correct.mockReset();
    cancel.mockReset().mockResolvedValue(undefined);
    notify.mockReset();
    composer.source = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("says so, without recording, when nothing is selected", async () => {
    const { service, voiceStore } = await setup();
    const start = vi.spyOn(service, "start").mockResolvedValue();
    composer.source = { terminalId: "panel-1", hasFocus: () => true, captureSelection: () => null };
    Reflect.set(service, "getComposerTarget", () => ({ panelId: "panel-1" }));

    await service.rewriteSelection();

    expect(start).not.toHaveBeenCalled();
    expect(voiceStore.getState().status).toBe("idle");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Nothing to rewrite" }));
  });

  it("refuses up front, without capturing, when there is no OpenAI key", async () => {
    const { service } = await setup("");
    const start = vi.spyOn(service, "start").mockResolvedValue();
    const captureSelection = vi.fn(() => fakeSelection("text"));
    composer.source = { terminalId: "panel-1", hasFocus: () => true, captureSelection };
    Reflect.set(service, "getComposerTarget", () => ({ panelId: "panel-1" }));

    await service.rewriteSelection();

    expect(start).not.toHaveBeenCalled();
    expect(captureSelection).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Rewrite unavailable", action: expect.anything() })
    );
  });

  it("arms a rewrite session for the composer's selection", async () => {
    const { service, voiceStore } = await setup();
    const start = vi.spyOn(service, "start").mockResolvedValue();
    const selection = fakeSelection("make me shorter");
    composer.source = {
      terminalId: "panel-1",
      hasFocus: () => true,
      captureSelection: () => selection,
    };
    Reflect.set(service, "getComposerTarget", () => ({ panelId: "panel-1" }));

    await service.rewriteSelection();

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        panelId: "panel-1",
        rewrite: expect.objectContaining({ selection }),
      })
    );
    expect(voiceStore.getState().activeTarget?.rewrite?.selection).toBe(selection);
  });

  it("resumes a released push-to-talk rewrite instead of dropping its queued instruction", async () => {
    const { service } = await setup();
    const start = vi.spyOn(service, "start").mockResolvedValue();
    const captureSelection = vi.fn();
    composer.source = { terminalId: "panel-1", hasFocus: () => true, captureSelection };
    const selection = fakeSelection("make me shorter");
    const released = {
      requestId: Reflect.get(service, "startRequestId"),
      target: { panelId: "panel-1", rewrite: { selection, instruction: [], cancelled: false } },
      capture: { frozen: true, timeline: { unmark: vi.fn() } },
      stopAfterStart: true,
      stopReason: "key_release",
    };
    Reflect.set(service, "startup", released);

    await service.rewriteSelection();

    expect(released.stopAfterStart).toBe(false);
    expect(released.capture.frozen).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(captureSelection).not.toHaveBeenCalled();
    Reflect.set(service, "startup", null);
  });

  it("gives the selection back when the rewrite is cancelled before its session begins", async () => {
    const { service, voiceStore } = await setup();
    const selection = fakeSelection("make me shorter");

    voiceStore.getState().setArming({
      panelId: "panel-1",
      rewrite: { selection, instruction: [], cancelled: false },
    });
    expect(service.handleEscape("panel-1")).toBe(true);

    expect(selection.release).toHaveBeenCalled();
    expect(voiceStore.getState().status).toBe("idle");
  });

  it("gives the selection back when another start supersedes a rewrite still arming", async () => {
    const { service, voiceStore } = await setup();
    vi.spyOn(service, "start").mockResolvedValue();
    const selection = fakeSelection("make me shorter");
    voiceStore.getState().setArming({
      panelId: "panel-1",
      rewrite: { selection, instruction: [], cancelled: false },
    });

    await service.toggle({ panelId: "panel-2" });

    expect(selection.release).toHaveBeenCalled();
    expect(voiceStore.getState().pendingTarget?.panelId).toBe("panel-2");
  });

  it("keeps the selection when the same rewrite restarts on another microphone", async () => {
    const { service, voiceStore, say, recordInstruction, flush } = await setup();
    const selection = fakeSelection("make me shorter");
    rewrite.mockResolvedValueOnce({ status: "replace", text: "Shorter." });
    recordInstruction(selection);
    say("make it");
    const target = voiceStore.getState().activeTarget!;
    // The restart's own start, attached and waiting on this stop.
    Reflect.set(service, "startup", {
      requestId: Reflect.get(service, "startRequestId"),
      target,
      capture: {},
      stopAfterStart: false,
    });

    await service.stop(undefined, {
      preserveLiveText: true,
      preservePendingStart: true,
      skipCorrection: true,
    });
    Reflect.set(service, "startup", null);

    expect(selection.release).not.toHaveBeenCalled();
    expect(rewrite).not.toHaveBeenCalled();

    // The restart begins its session on the very same target.
    voiceStore.getState().beginSession(target);
    say("shorter");
    await service.stop();
    await flush();

    expect(rewrite).toHaveBeenCalledWith({
      selectedText: "make me shorter",
      instruction: "make it shorter",
    });
    expect(selection.apply).toHaveBeenCalledWith("Shorter.");
  });

  it("keeps the instruction out of the draft and lands the rewrite on the selection", async () => {
    const { service, draft, inputStore, say, recordInstruction, flush } = await setup();
    inputStore.getState().setDraftInput("panel-1", "Hi. make me shorter please");
    const selection = fakeSelection("make me shorter please");
    const pending = deferred<RewriteOutcome>();
    rewrite.mockReturnValueOnce(pending.promise);

    recordInstruction(selection);
    say("make it");
    callbacks.boundary!({ rawText: null });
    say("much shorter");
    callbacks.delta!({ text: "please", itemId: "trailing" });
    await service.stop();

    expect(draft()).toBe("Hi. make me shorter please");
    expect(correct).not.toHaveBeenCalled();
    expect(rewrite).toHaveBeenCalledWith({
      selectedText: "make me shorter please",
      instruction: "make it much shorter please",
    });
    expect(service.hasPendingCorrection("panel-1")).toBe(true);

    pending.resolve({ status: "replace", text: "Shorter." });
    await flush();

    expect(selection.apply).toHaveBeenCalledWith("Shorter.");
    expect(service.hasPendingCorrection("panel-1")).toBe(false);
  });

  it("keeps a spoken send in the instruction: a rewrite never sends", async () => {
    const { service, voiceStore, draft, inputStore, recordInstruction, flush } = await setup();
    inputStore.getState().setDraftInput("panel-1", "Hi. make me shorter please");
    const selection = fakeSelection("make me shorter please");
    rewrite.mockResolvedValueOnce({ status: "replace", text: "Shorter." });
    const spokenSend = vi.fn();
    service.onSpokenSend("panel-1", undefined, spokenSend);
    const stop = vi.spyOn(service, "stop");

    recordInstruction(selection);
    voiceStore.getState().setStatus("recording");
    callbacks.complete!({
      text: "make it shorter and send it",
      willCorrect: false,
      itemId: "item-1",
      send: true,
    });

    expect(spokenSend).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(voiceStore.getState().status).toBe("recording");

    await service.stop();
    await flush();

    expect(spokenSend).not.toHaveBeenCalled();
    expect(draft()).toBe("Hi. make me shorter please");
    expect(rewrite).toHaveBeenCalledWith({
      selectedText: "make me shorter please",
      instruction: "make it shorter and send it",
    });
    expect(selection.apply).toHaveBeenCalledWith("Shorter.");
  });

  it("drops the rewrite when an edit reaches the selection first, so a waiting send goes at once", async () => {
    const { service, say, recordInstruction, flush } = await setup();
    const selection = fakeSelection("make me shorter");
    const pending = deferred<RewriteOutcome>();
    rewrite.mockReturnValueOnce(pending.promise);

    recordInstruction(selection);
    say("shorter");
    await service.stop();
    const waiting = service.waitForPendingCorrections("panel-1", 5_000);

    selection.edit();
    await expect(waiting).resolves.toBe(true);

    pending.resolve({ status: "replace", text: "Shorter." });
    await flush();
    expect(selection.apply).not.toHaveBeenCalled();
  });

  it("never lands once a send discarded it", async () => {
    const { service, say, recordInstruction, flush } = await setup();
    const selection = fakeSelection("make me shorter");
    const pending = deferred<RewriteOutcome>();
    rewrite.mockReturnValueOnce(pending.promise);

    recordInstruction(selection);
    say("shorter");
    await service.stop();
    service.discardPendingCorrections("panel-1");

    pending.resolve({ status: "replace", text: "Shorter." });
    await flush();
    expect(selection.apply).not.toHaveBeenCalled();
    expect(selection.release).toHaveBeenCalled();
  });

  it("sends nothing when Escape cancels the instruction", async () => {
    const { service, voiceStore, say, recordInstruction, flush } = await setup();
    const selection = fakeSelection("make me shorter");

    recordInstruction(selection);
    voiceStore.getState().setStatus("recording");
    say("shorter");
    expect(service.handleEscape("panel-1")).toBe(true);
    await flush();
    await flush();

    expect(rewrite).not.toHaveBeenCalled();
    expect(selection.release).toHaveBeenCalled();
  });

  it("cancels the instruction without draining it and leaves the selection as it was", async () => {
    const { service, voiceStore, draft, inputStore, recordInstruction, flush } = await setup();
    inputStore.getState().setDraftInput("panel-1", "Hi. make me shorter");
    const selection = fakeSelection("make me shorter");
    const complete = (text: string, itemId: string) =>
      callbacks.complete!({ sessionId: "session-1", text, willCorrect: false, itemId });

    recordInstruction(selection);
    voiceStore.getState().setStatus("recording");
    Reflect.set(service, "sessionId", "session-1");
    complete("shorter", "item-1");
    callbacks.delta!({ sessionId: "session-1", text: "and punch", itemId: "item-2" });

    expect(service.handleEscape("panel-1")).toBe(true);
    // What the session still had in flight has nowhere to land.
    complete("and punchier", "item-2");
    await flush();

    expect(cancel).toHaveBeenCalledWith("session-1");
    expect(window.electron.voiceInput.stop).not.toHaveBeenCalled();
    expect(rewrite).not.toHaveBeenCalled();
    expect(selection.apply).not.toHaveBeenCalled();
    expect(selection.release).toHaveBeenCalledTimes(1);
    expect(draft()).toBe("Hi. make me shorter");
    expect(voiceStore.getState().status).toBe("idle");
    expect(voiceStore.getState().announcement?.text).toBe("Rewrite cancelled.");
  });

  it("says nothing was heard instead of sending an empty instruction", async () => {
    const { service, recordInstruction } = await setup();
    const selection = fakeSelection("make me shorter");

    recordInstruction(selection);
    await service.stop();

    expect(rewrite).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Selection unchanged" }));
  });

  it("explains a rejected rewrite and offers a retry for a failed one", async () => {
    const { service, say, recordInstruction, flush } = await setup();

    const rejected = fakeSelection("run `npm test`");
    rewrite.mockResolvedValueOnce({ status: "rejected" });
    recordInstruction(rejected);
    say("shorter");
    await service.stop();
    await flush();
    expect(rejected.apply).not.toHaveBeenCalled();
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Selection unchanged" })
    );

    const failed = fakeSelection("make me shorter");
    rewrite.mockResolvedValueOnce({ status: "failed" });
    recordInstruction(failed);
    say("shorter");
    await service.stop();
    await flush();
    const toast = notify.mock.lastCall![0];
    expect(toast.title).toBe("Rewrite failed");

    rewrite.mockResolvedValueOnce({ status: "replace", text: "Shorter." });
    toast.action!.onClick();
    await flush();
    expect(rewrite).toHaveBeenLastCalledWith({
      selectedText: "make me shorter",
      instruction: "shorter",
    });
    expect(failed.apply).toHaveBeenCalledWith("Shorter.");
  });

  // The rewrite key's press follows the recording mode like the dictation key (#14626).
  async function setupRewritePress(recordingMode: string) {
    const t = await setup(undefined, recordingMode);
    const { keybindingService } = await import("@/services/KeybindingService");
    vi.mocked(keybindingService.getEffectiveCombos).mockImplementation((actionId: string) =>
      actionId === "voiceInput.rewriteSelection" ? ["Cmd+Shift+Alt+."] : []
    );
    vi.mocked(keybindingService.matchesEvent).mockImplementation(
      (e: KeyboardEvent, combo: string) => combo === "Cmd+Shift+Alt+." && e.code === "Period"
    );
    vi.spyOn(t.service, "start").mockResolvedValue();
    const stop = vi.spyOn(t.service, "stop").mockResolvedValue();
    const selection = fakeSelection("make me shorter");
    composer.source = {
      terminalId: "panel-1",
      hasFocus: () => true,
      captureSelection: () => selection,
    };
    Reflect.set(t.service, "getComposerTarget", () => ({ panelId: "panel-1" }));

    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const fire = (event: string, payload: unknown) => {
      for (const listener of windowListeners[event] ?? []) listener(payload);
    };
    return {
      ...t,
      stop,
      advance: (ms: number) => {
        now += ms;
      },
      // The keydown, then the action it dispatches, whose session then begins.
      press: async () => {
        fire("keydown", { code: "Period", key: ".", repeat: false, metaKey: true, timeStamp: now });
        await t.service.rewriteSelection();
        t.recordInstruction(selection);
      },
      release: () => fire("keyup", { code: "Period" }),
    };
  }

  it("stops the rewrite on the release of its key in push-to-talk mode", async () => {
    const t = await setupRewritePress("push-to-talk");
    await t.press();
    t.release();
    expect(t.stop).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("keeps a tapped rewrite recording in tap-or-hold mode", async () => {
    const t = await setupRewritePress("tap-or-hold");
    await t.press();
    t.release();
    expect(t.stop).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("stops a held rewrite that heard speech on the release of its key", async () => {
    const t = await setupRewritePress("tap-or-hold");
    await t.press();
    const speech = { samples: 1_600, rms: 0.1, peak: 0.3, zeroFraction: 0 };
    t.service["noteHeldPressAudio"](speech);
    t.service["noteHeldPressAudio"](speech);
    t.advance(1_000);
    t.release();
    expect(t.stop).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
