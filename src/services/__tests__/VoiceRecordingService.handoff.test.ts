import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drives the real voice store through the service and its IPC callbacks to
// prove a new start never collides with a session that's still finishing
// (#14604): the finishing session's tail stays in its own panel, and speech
// from the moment of the new press is kept.

const runtime = vi.hoisted(() => ({
  drafts: {} as Record<string, string>,
  panelState: {
    panelsById: {} as Record<
      string,
      { id: string; title: string; location: string; launchAgentId?: string }
    >,
    panelIds: [] as string[],
    focusedId: null as string | null,
    activateTerminal: vi.fn(),
  },
  windowListeners: {} as Record<string, Array<(event: unknown) => void>>,
  panelListeners: [] as Array<(state: unknown) => void>,
}));

// Its DOM reads need a real document; the suite that runs it for real is
// voiceComposerFocus.test.tsx.
const focusDictationComposer = vi.hoisted(() => vi.fn());
const revealDictationComposer = vi.hoisted(() => vi.fn());
vi.mock("@/services/voiceComposerFocus", () => ({
  focusDictationComposer,
  revealDictationComposer,
}));

vi.mock("@/store/terminalInputStore", () => {
  const fns = {
    getDraftInput: vi.fn((panelId: string) => runtime.drafts[panelId] ?? ""),
    setDraftInput: vi.fn((panelId: string, value: string) => {
      runtime.drafts[panelId] = value;
    }),
    bumpExternalDraftRevision: vi.fn(),
  };
  const getState = () => ({ ...fns, hybridInputEnabled: true });
  return {
    useTerminalInputStore: Object.assign(getState, { getState, subscribe: () => () => {} }),
  };
});

vi.mock("@/store/fleetArmingStore", () => {
  const getState = () => ({ armedIds: new Set<string>() });
  return { useFleetArmingStore: Object.assign(getState, { getState }) };
});

vi.mock("@/store/panelStore", () => {
  const getState = () => runtime.panelState;
  const subscribe = vi.fn((listener: (state: unknown) => void) => {
    runtime.panelListeners.push(listener);
    return () => {};
  });
  return { usePanelStore: Object.assign(getState, { getState, subscribe }) };
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

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: vi.fn(() => "Cmd+."),
    getEffectiveCombos: vi.fn((actionId: string) =>
      actionId === "voiceInput.toggle" ? ["Cmd+."] : []
    ),
    matchesEvent: vi.fn(() => true),
  },
}));

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type DeltaPayload = { text: string; itemId?: string };
type CompletePayload = {
  text: string;
  willCorrect: boolean;
  itemId?: string;
  transcriptId?: string;
};
type FileTokenPayload = {
  sessionId: string;
  transcriptId: string;
  references: Array<{ description: string; path: string | null }>;
};

interface WorkletNodeStub {
  port: {
    onmessage: ((event: { data: ArrayBuffer | { type: string } }) => void) | null;
    postMessage: (message: { type: string }) => void;
  };
  connect: () => void;
  disconnect: () => void;
}

function stubEnvironment(recordingMode: "toggle" | "push-to-talk") {
  const callbacks: {
    delta: ((payload: DeltaPayload) => void) | null;
    complete: ((payload: CompletePayload) => void) | null;
    status: ((status: string) => void) | null;
    boundary: ((payload: { rawText: string | null }) => void) | null;
    fileToken: ((payload: FileTokenPayload) => void) | null;
  } = { delta: null, complete: null, status: null, boundary: null, fileToken: null };
  const drains: Deferred[] = [];
  const workletNodes: WorkletNodeStub[] = [];
  const sentChunks: ArrayBuffer[] = [];
  const tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const contexts: Array<{ close: ReturnType<typeof vi.fn> }> = [];

  const voiceInput = {
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
    onStatus: vi.fn((cb: (payload: { sessionId: string; status: string }) => void) => {
      callbacks.status = (status) => cb({ sessionId: "", status });
      return () => {};
    }),
    onSessionEnded: vi.fn(() => () => {}),
    onLiveSession: vi.fn(() => () => {}),
    onStopRequested: vi.fn(() => () => {}),
    onRevealRequested: vi.fn(() => () => {}),
    getLiveSession: vi.fn().mockResolvedValue({ revision: 0, session: null }),
    getSettings: vi.fn().mockResolvedValue({
      enabled: true,
      openaiApiKey: "sk-key",
      correctionEnabled: false,
      recordingMode,
    }),
    checkMicPermission: vi.fn().mockResolvedValue("granted"),
    requestMicPermission: vi.fn().mockResolvedValue(true),
    openMicSettings: vi.fn().mockResolvedValue(undefined),
    sendAudioChunk: vi.fn((_sessionId: string, chunk: ArrayBuffer) => {
      sentChunks.push(chunk);
    }),
    start: vi.fn().mockResolvedValue({ status: "started" }),
    // Each remote stop drains until the test releases it.
    stop: vi.fn(() => {
      const drain = deferred();
      drains.push(drain);
      return drain.promise;
    }),
  };

  runtime.windowListeners = {};
  vi.stubGlobal("window", {
    electron: {
      voiceInput,
      systemSleep: { onSuspend: vi.fn(() => () => {}), onWake: vi.fn(() => () => {}) },
    },
    addEventListener: vi.fn((event: string, cb: (event: unknown) => void) => {
      (runtime.windowListeners[event] ??= []).push(cb);
    }),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1)
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => {
        const track = { stop: vi.fn() };
        tracks.push(track);
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      }),
      enumerateDevices: vi.fn(async () => []),
    },
  });
  vi.stubGlobal("AudioContext", function () {
    const context = {
      state: "running",
      destination: {},
      sampleRate: 24000,
      resume: vi.fn().mockResolvedValue(undefined),
      suspend: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
      createOscillator: vi.fn(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      })),
      createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
      audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    };
    contexts.push(context);
    return context;
  });
  vi.stubGlobal("AudioWorkletNode", function () {
    const node: WorkletNodeStub = {
      port: {
        onmessage: null,
        // The real worklet answers a flush with "flushed" once its partial
        // chunk is posted.
        postMessage: vi.fn((message: { type: string }) => {
          if (message.type !== "flush") return;
          queueMicrotask(() => node.port.onmessage?.({ data: { type: "flushed" } }));
        }),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    workletNodes.push(node);
    return node;
  });

  return { voiceInput, callbacks, drains, workletNodes, sentChunks, tracks, contexts };
}

let chunkSeq = 0;

// A chunk loud enough to count as live speech, with its own sample value so a
// sequence of them compares by content, not just by length.
function speech(): ArrayBuffer {
  return new Int16Array(2400).fill(6000 + ++chunkSeq).buffer;
}

let liveService: { destroy: () => void } | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function setup(recordingMode: "toggle" | "push-to-talk" = "toggle") {
  const env = stubEnvironment(recordingMode);
  const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
  const { voiceRecordingService } = await import("../VoiceRecordingService");
  liveService = voiceRecordingService;
  voiceRecordingService.initialize();
  await settle();
  const store = () => useVoiceRecordingStore.getState();
  const delta = (text: string, itemId?: string) => env.callbacks.delta!({ text, itemId });
  const complete = (text: string, itemId?: string, transcriptId?: string) =>
    env.callbacks.complete!({ text, willCorrect: false, itemId, transcriptId });
  // Resolves once the capture with this index is attached and taking audio.
  const attached = (captureIndex: number) =>
    vi.waitFor(() => expect(env.workletNodes[captureIndex]?.port.onmessage).toBeTypeOf("function"));
  const press = (code = "Period") => {
    for (const listener of runtime.windowListeners["keydown"] ?? []) {
      listener({ code, key: ".", repeat: false, metaKey: true });
    }
  };
  const release = (code = "Period") => {
    for (const listener of runtime.windowListeners["keyup"] ?? []) listener({ code });
  };
  const escape = () => voiceRecordingService.handleEscape();
  // Records each new capture's audio and returns the chunks it was fed.
  const speak = (captureIndex: number, count = 2) => {
    const chunks = Array.from({ length: count }, speech);
    for (const chunk of chunks) env.workletNodes[captureIndex]!.port.onmessage!({ data: chunk });
    return chunks;
  };
  const blur = () => {
    for (const listener of runtime.windowListeners["blur"] ?? []) listener({});
  };
  return {
    ...env,
    voiceRecordingService,
    store,
    delta,
    complete,
    attached,
    press,
    release,
    escape,
    blur,
    speak,
  };
}

const PANEL_A = { panelId: "panel-a", panelTitle: "Panel A" };
const PANEL_B = { panelId: "panel-b", panelTitle: "Panel B" };

describe("VoiceRecordingService — starting while a session finishes (#14604)", () => {
  beforeEach(() => {
    vi.resetModules();
    runtime.drafts = {};
    runtime.panelState.panelsById = {
      "panel-a": { id: "panel-a", title: "Panel A", location: "grid", launchAgentId: "claude" },
      "panel-b": { id: "panel-b", title: "Panel B", location: "grid", launchAgentId: "claude" },
    };
    runtime.panelState.panelIds = ["panel-a", "panel-b"];
    runtime.panelState.focusedId = "panel-a";
    runtime.panelListeners = [];
    runtime.panelState.activateTerminal.mockReset();
    focusDictationComposer.mockClear();
  });

  afterEach(() => {
    liveService?.destroy();
    liveService = null;
    vi.unstubAllGlobals();
  });

  it("commits the old session's tail into its own panel when retargeting mid-session", async () => {
    const { voiceRecordingService, store, delta, complete, drains, callbacks } = await setup();

    await voiceRecordingService.toggle(PANEL_A);
    callbacks.status!("recording");
    delta("half a sent");

    const retarget = voiceRecordingService.toggle(PANEL_B);
    await vi.waitFor(() => expect(drains).toHaveLength(1));

    expect(store().activeTarget?.panelId).toBe("panel-a");
    expect(store().pendingTarget?.panelId).toBe("panel-b");

    delta("ence");
    complete("Half a sentence.");
    callbacks.boundary!({ rawText: null });
    expect(runtime.drafts["panel-a"]).toBe("Half a sentence.\n");
    expect(runtime.drafts["panel-b"] ?? "").toBe("");

    drains[0]!.resolve();
    await retarget;

    expect(store().activeTarget?.panelId).toBe("panel-b");
    expect(store().pendingTarget).toBeNull();
    delta("next");
    complete("Next.");
    expect(runtime.drafts["panel-a"]).toBe("Half a sentence.\n");
    expect(runtime.drafts["panel-b"]).toBe("Next.");
  });

  it("flushes the old session's unfinished live text into its own panel on retarget", async () => {
    const { voiceRecordingService, delta, drains, callbacks } = await setup();

    await voiceRecordingService.toggle(PANEL_A);
    callbacks.status!("recording");
    delta("still talking");

    const retarget = voiceRecordingService.toggle(PANEL_B);
    await vi.waitFor(() => expect(drains).toHaveLength(1));
    drains[0]!.resolve();
    await retarget;

    expect(runtime.drafts["panel-a"]).toBe("still talking");
    expect(runtime.drafts["panel-b"] ?? "").toBe("");
  });

  // The keyboard goes to the composer at the press (#14770). Words arriving,
  // the stop and the session finishing are the user's from there.
  it("asks for the composer once, at the start", async () => {
    const { voiceRecordingService, store, delta, complete, drains, callbacks } = await setup();

    await voiceRecordingService.toggle(PANEL_A);
    expect(focusDictationComposer).toHaveBeenCalledTimes(1);
    expect(focusDictationComposer).toHaveBeenCalledWith("panel-a");

    callbacks.status!("recording");
    delta("hello");
    complete("Hello there.");
    const stopping = voiceRecordingService.toggle(PANEL_A);
    await vi.waitFor(() => expect(drains).toHaveLength(1));
    drains[0]!.resolve();
    await stopping;

    expect(runtime.drafts["panel-a"]).toBe("Hello there.");
    expect(store().activeTarget).toBeNull();
    expect(focusDictationComposer).toHaveBeenCalledTimes(1);
  });

  it("starts a new session when pressed while the last one is finishing", async () => {
    const {
      voiceRecordingService,
      voiceInput,
      store,
      delta,
      complete,
      drains,
      callbacks,
      workletNodes,
      sentChunks,
      attached,
    } = await setup();

    await voiceRecordingService.toggle(PANEL_A);
    callbacks.status!("recording");
    delta("first");

    const stopping = voiceRecordingService.toggle(PANEL_A);
    await vi.waitFor(() => expect(drains).toHaveLength(1));
    expect(store().status).toBe("finishing");

    const restart = voiceRecordingService.toggle(PANEL_A);
    await attached(1);
    expect(store().pendingTarget?.panelId).toBe("panel-a");
    expect(store().status).toBe("finishing");

    const heldSpeech = [speech(), speech()];
    for (const chunk of heldSpeech) workletNodes[1]!.port.onmessage!({ data: chunk });
    expect(sentChunks).not.toContain(heldSpeech[0]);

    complete("First thought.");
    expect(runtime.drafts["panel-a"]).toBe("First thought.");

    drains[0]!.resolve();
    await stopping;
    await restart;

    expect(voiceInput.start).toHaveBeenCalledTimes(2);
    expect(store().activeTarget?.panelId).toBe("panel-a");
    expect(store().pendingTarget).toBeNull();
    expect(sentChunks).toEqual(heldSpeech);

    delta("second");
    complete("Second thought.");
    expect(runtime.drafts["panel-a"]).toBe("First thought. Second thought.");
  });

  it("keeps a push-to-talk hold released while the last session is still finishing", async () => {
    const {
      voiceRecordingService,
      voiceInput,
      store,
      delta,
      complete,
      drains,
      callbacks,
      sentChunks,
      attached,
      press,
      release,
      speak,
    } = await setup("push-to-talk");

    press();
    const firstHold = voiceRecordingService.toggleFocusedPanel();
    expect(store().pendingTarget?.panelId).toBe("panel-a");
    await firstHold;
    callbacks.status!("recording");
    delta("first");
    release();
    await vi.waitFor(() => expect(drains).toHaveLength(1));

    press();
    const secondHold = voiceRecordingService.toggleFocusedPanel();
    expect(store().pendingTarget?.panelId).toBe("panel-a");
    await attached(1);
    const secondUtterance = speak(1);
    release();
    // Nothing said after the release is taken.
    speak(1);

    complete("First.");
    expect(runtime.drafts["panel-a"]).toBe("First.");
    drains[0]!.resolve();

    // The second hold's own stop follows the send, oldest audio first.
    await vi.waitFor(() => expect(drains).toHaveLength(2));
    expect(voiceInput.start).toHaveBeenCalledTimes(2);
    expect(sentChunks).toEqual(secondUtterance);
    expect(voiceInput.stop.mock.invocationCallOrder[1]).toBeGreaterThan(
      voiceInput.sendAudioChunk.mock.invocationCallOrder.at(-1)!
    );
    delta("second");
    complete("Second.");
    drains[1]!.resolve();
    await secondHold;
    expect(store().status).toBe("idle");
    expect(runtime.drafts["panel-a"]).toBe("First. Second.");
    expect(store().activeTarget).toBeNull();
  });

  it("keeps a push-to-talk hold released before its backend has connected", async () => {
    const { voiceRecordingService, voiceInput, store, drains, sentChunks, press, release, speak } =
      await setup("push-to-talk");
    let connect!: (result: { status: string; error?: string }) => void;
    voiceInput.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          connect = resolve;
        })
    );

    press();
    const hold = voiceRecordingService.toggleFocusedPanel();
    await vi.waitFor(() => expect(voiceInput.start).toHaveBeenCalledTimes(1));
    expect(store().status).toBe("connecting");
    const utterance = speak(0);
    release();

    connect({ status: "started" });

    await vi.waitFor(() => expect(drains).toHaveLength(1));
    expect(sentChunks).toEqual(utterance);
    drains[0]!.resolve();
    await hold;
    await vi.waitFor(() => expect(store().status).toBe("idle"));
  });

  it("keeps speech queued behind a drain when the next session is toggled off early", async () => {
    const { voiceRecordingService, voiceInput, drains, callbacks, sentChunks, attached, speak } =
      await setup();

    await voiceRecordingService.toggle(PANEL_A);
    callbacks.status!("recording");
    const stopping = voiceRecordingService.toggle(PANEL_A);
    await vi.waitFor(() => expect(drains).toHaveLength(1));

    const restart = voiceRecordingService.toggle(PANEL_B);
    await attached(1);
    const utterance = speak(1);
    await voiceRecordingService.toggle(PANEL_B);

    drains[0]!.resolve();
    await stopping;

    await vi.waitFor(() => expect(drains).toHaveLength(2));
    expect(voiceInput.start).toHaveBeenCalledTimes(2);
    expect(sentChunks).toEqual(utterance);
    drains[1]!.resolve();
    await restart;
  });

  it("discards a queued start on Escape and lets the finishing session drain", async () => {
    const {
      voiceRecordingService,
      voiceInput,
      store,
      complete,
      drains,
      callbacks,
      sentChunks,
      attached,
      escape,
      speak,
    } = await setup();

    await voiceRecordingService.toggle(PANEL_A);
    callbacks.status!("recording");
    const stopping = voiceRecordingService.toggle(PANEL_A);
    await vi.waitFor(() => expect(drains).toHaveLength(1));

    const restart = voiceRecordingService.toggle(PANEL_B);
    await attached(1);
    speak(1);
    escape();
    expect(store().pendingTarget).toBeNull();
    expect(store().status).toBe("finishing");

    complete("Kept.");
    drains[0]!.resolve();
    await stopping;
    await restart;

    expect(runtime.drafts["panel-a"]).toBe("Kept.");
    expect(voiceInput.start).toHaveBeenCalledTimes(1);
    expect(sentChunks).toEqual([]);
    expect(store().status).toBe("idle");
  });

  it("cancels only the queued start when its panel closes during the drain", async () => {
    const { voiceRecordingService, voiceInput, store, complete, drains, callbacks } = await setup();

    await voiceRecordingService.toggle(PANEL_A);
    callbacks.status!("recording");
    const stopping = voiceRecordingService.toggle(PANEL_A);
    await vi.waitFor(() => expect(drains).toHaveLength(1));
    const restart = voiceRecordingService.toggle(PANEL_B);
    await vi.waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2));

    delete runtime.panelState.panelsById["panel-b"];
    for (const listener of runtime.panelListeners) listener(runtime.panelState);
    expect(store().pendingTarget).toBeNull();
    expect(store().activeTarget?.panelId).toBe("panel-a");
    expect(store().status).toBe("finishing");

    complete("Still mine.");
    drains[0]!.resolve();
    await stopping;
    await restart;

    expect(runtime.drafts["panel-a"]).toBe("Still mine.");
    expect(voiceInput.start).toHaveBeenCalledTimes(1);
    expect(store().status).toBe("idle");
  });

  it("keeps identified items and file tokens in the old panel during a retarget", async () => {
    const { voiceRecordingService, voiceInput, store, delta, complete, drains, callbacks } =
      await setup();

    await voiceRecordingService.toggle(PANEL_A);
    callbacks.status!("recording");
    // References come back under the id main was started with.
    const sessionId = store().panelBuffers["panel-a"]?.dictationSessionId ?? "";
    expect(voiceInput.start).toHaveBeenNthCalledWith(1, sessionId, { terminalId: "panel-a" });
    delta("link to the", "item-1");
    delta("then run", "item-2");

    const retarget = voiceRecordingService.toggle(PANEL_B);
    await vi.waitFor(() => expect(drains).toHaveLength(1));
    runtime.drafts["panel-b"] = "Link to the readme.";

    complete("Link to the readme.", "item-1", "t1");
    expect(store().panelBuffers["panel-a"]?.liveText).toBe("then run");
    callbacks.fileToken!({
      sessionId,
      transcriptId: "t1",
      references: [{ description: "readme", path: "README.md" }],
    });
    complete("Then run it.", "item-2");

    expect(runtime.drafts["panel-a"]).toBe("@README.md. Then run it.");
    expect(runtime.drafts["panel-b"]).toBe("Link to the readme.");

    drains[0]!.resolve();
    await retarget;
    expect(store().activeTarget?.panelId).toBe("panel-b");
    expect(store().panelBuffers["panel-b"]?.liveText).toBe("");
    const nextSessionId = store().panelBuffers["panel-b"]?.dictationSessionId;
    expect(nextSessionId).not.toBe(sessionId);
    expect(voiceInput.start).toHaveBeenNthCalledWith(2, nextSessionId, { terminalId: "panel-b" });
  });

  it("resumes a stopped start when the next hold lands before its audio is sent", async () => {
    const {
      voiceRecordingService,
      voiceInput,
      store,
      drains,
      callbacks,
      sentChunks,
      tracks,
      attached,
      press,
      release,
      speak,
    } = await setup("push-to-talk");

    press();
    await voiceRecordingService.toggleFocusedPanel();
    callbacks.status!("recording");
    release();
    await vi.waitFor(() => expect(drains).toHaveLength(1));

    press();
    const secondHold = voiceRecordingService.toggleFocusedPanel();
    await attached(1);
    const firstWords = speak(1);
    release();
    speak(1);
    // The mic stays open so the next hold can carry on into it.
    expect(tracks[1]!.stop).not.toHaveBeenCalled();

    press();
    await voiceRecordingService.toggleFocusedPanel();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    const moreWords = speak(1);
    release();

    drains[0]!.resolve();
    await vi.waitFor(() => expect(drains).toHaveLength(2));
    expect(voiceInput.start).toHaveBeenCalledTimes(2);
    expect(sentChunks).toEqual([...firstWords, ...moreWords]);
    expect(tracks[1]!.stop).toHaveBeenCalled();
    drains[1]!.resolve();
    await secondHold;
    expect(store().status).toBe("idle");
  });

  it("leaves nothing stuck when a stopped start's backend then fails", async () => {
    const {
      voiceRecordingService,
      voiceInput,
      store,
      drains,
      callbacks,
      sentChunks,
      attached,
      press,
      release,
      speak,
    } = await setup("push-to-talk");

    press();
    await voiceRecordingService.toggleFocusedPanel();
    callbacks.status!("recording");
    release();
    await vi.waitFor(() => expect(drains).toHaveLength(1));

    voiceInput.start.mockResolvedValueOnce({
      status: "failed",
      error: "Voice backend unavailable.",
    });
    press();
    const secondHold = voiceRecordingService.toggleFocusedPanel();
    await attached(1);
    const utterance = speak(1);
    release();

    drains[0]!.resolve();
    await vi.waitFor(() => expect(drains).toHaveLength(2));
    expect(sentChunks).toEqual(utterance);
    drains[1]!.resolve();
    await secondHold;
    expect(store().status).toBe("idle");
    expect(store().pendingTarget).toBeNull();

    press();
    await voiceRecordingService.toggleFocusedPanel();
    expect(voiceInput.start).toHaveBeenCalledTimes(3);
    expect(store().activeTarget?.panelId).toBe("panel-a");
  });

  it("treats a window blur mid-hold like a release that keeps the queued speech", async () => {
    const { voiceRecordingService, voiceInput, drains, sentChunks, press, blur, speak } =
      await setup("push-to-talk");
    let connect!: (result: { status: string; error?: string }) => void;
    voiceInput.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          connect = resolve;
        })
    );

    press();
    const hold = voiceRecordingService.toggleFocusedPanel();
    await vi.waitFor(() => expect(voiceInput.start).toHaveBeenCalledTimes(1));
    const utterance = speak(0);
    blur();
    connect({ status: "started" });

    await vi.waitFor(() => expect(drains).toHaveLength(1));
    expect(sentChunks).toEqual(utterance);
    drains[0]!.resolve();
    await hold;
  });

  it("cancels on Escape a start still opening its mic after the drain it waited on ends", async () => {
    const { voiceRecordingService, voiceInput, store, drains, callbacks, escape } = await setup();

    await voiceRecordingService.toggle(PANEL_A);
    callbacks.status!("recording");
    const stopping = voiceRecordingService.toggle(PANEL_A);
    await vi.waitFor(() => expect(drains).toHaveLength(1));

    let grantMic!: () => void;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          const track = { stop: vi.fn() };
          grantMic = () =>
            resolve({ getTracks: () => [track], getAudioTracks: () => [track] } as never);
        })
    );
    const restart = voiceRecordingService.toggle(PANEL_B);
    await vi.waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2));
    drains[0]!.resolve();
    await stopping;
    expect(store().status).toBe("idle");
    expect(store().pendingTarget?.panelId).toBe("panel-b");

    escape();
    expect(store().pendingTarget).toBeNull();
    grantMic();
    await restart;
    expect(voiceInput.start).toHaveBeenCalledTimes(1);
  });

  it("keeps another panel's queued start when the draining panel closes", async () => {
    const { voiceRecordingService, voiceInput, store, drains, callbacks, attached } = await setup();

    await voiceRecordingService.toggle(PANEL_A);
    callbacks.status!("recording");
    const stopping = voiceRecordingService.toggle(PANEL_A);
    await vi.waitFor(() => expect(drains).toHaveLength(1));
    const restart = voiceRecordingService.toggle(PANEL_B);
    await attached(1);

    delete runtime.panelState.panelsById["panel-a"];
    for (const listener of runtime.panelListeners) listener(runtime.panelState);
    expect(store().pendingTarget?.panelId).toBe("panel-b");

    drains[0]!.resolve();
    await stopping;
    await restart;
    expect(voiceInput.start).toHaveBeenCalledTimes(2);
    expect(store().activeTarget?.panelId).toBe("panel-b");
  });

  it("shows finishing from the moment of the stop, before the mic has torn down", async () => {
    const { voiceRecordingService, voiceInput, store, drains, callbacks, workletNodes, tracks } =
      await setup();

    await voiceRecordingService.toggle(PANEL_A);
    callbacks.status!("recording");
    const node = workletNodes[0]!;
    let flushed!: () => void;
    const flushRequested = vi.fn();
    node.port.postMessage = (message) => {
      if (message.type !== "flush") return;
      flushRequested();
      flushed = () => node.port.onmessage?.({ data: { type: "flushed" } });
    };

    const stopping = voiceRecordingService.toggle(PANEL_A);
    await vi.waitFor(() => expect(flushRequested).toHaveBeenCalled());
    expect(store().status).toBe("finishing");
    callbacks.status!("recording");
    expect(store().status).toBe("finishing");
    expect(tracks[0]!.stop).not.toHaveBeenCalled();
    expect(voiceInput.stop).not.toHaveBeenCalled();

    flushed();
    await vi.waitFor(() => expect(drains).toHaveLength(1));
    expect(tracks[0]!.stop).toHaveBeenCalled();
    drains[0]!.resolve();
    await stopping;
    expect(store().status).toBe("idle");
  });

  it("jumps to the queued panel the toolbar names, not the one still finishing", async () => {
    const { voiceRecordingService, drains, callbacks, attached } = await setup();

    await voiceRecordingService.toggle(PANEL_A);
    callbacks.status!("recording");
    const stopping = voiceRecordingService.toggle(PANEL_A);
    await vi.waitFor(() => expect(drains).toHaveLength(1));
    const restart = voiceRecordingService.toggle(PANEL_B);
    await attached(1);

    await voiceRecordingService.focusActiveTarget();
    expect(runtime.panelState.activateTerminal).toHaveBeenCalledWith("panel-b");

    drains[0]!.resolve();
    await stopping;
    await restart;
  });
});
