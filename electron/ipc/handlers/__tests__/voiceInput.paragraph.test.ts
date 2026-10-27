import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── IPC mocks ──────────────────────────────────────────────────────────────
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  systemPreferences: { getMediaAccessStatus: vi.fn(() => "granted") },
  shell: { openExternal: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
}));

// ── Shared state container for mocks ───────────────────────────────────────
type MockTranscriptionEvent = {
  type: string;
  sessionId?: string;
  text?: string;
  itemId?: string;
  replace?: boolean;
  endOfSpeech?: boolean;
  endsAtPause?: boolean;
  incomplete?: boolean;
  uncertain?: Array<{ from: number; to: number }>;
  status?: string;
  message?: string;
  error?: { severity: string; code: string; message: string };
};

const shared = vi.hoisted(() => ({
  transcriptionEventCallback: null as ((e: MockTranscriptionEvent) => void) | null,
  /** Deferred drain promise — resolve externally to control stopGracefully() timing. */
  drainResolve: null as (() => void) | null,
  drainReject: null as ((error: Error) => void) | null,
  /** When true, stopGracefully uses a deferred promise instead of resolving immediately. */
  useDeferredDrain: false,
  correctionCalls: [] as Array<{ request: unknown; settings: unknown }>,
  rewriteCalls: [] as Array<{ request: unknown; settings: unknown }>,
  correctionFailed: false,
  /** Settings objects passed to svc.start(), in call order. */
  startCalls: [] as unknown[],
  /** The start context passed alongside each of them. */
  startContexts: [] as Array<{ keyterms?: Promise<string[]> } | undefined>,
  /** Optional override for assembleTaggedKeyterms — lets a test defer/control timing. */
  assembleKeyterms: null as null | (() => Promise<string[]>),
  /** The session the fake provider was last started for; its events carry it. */
  providerSessionId: null as string | null,
  /** Texts handed to file-link detection, in call order. */
  fileLinkCalls: [] as string[],
  /** The project the fake view belongs to, when a test needs one. */
  viewProjectId: null as string | null,
  /** When set, a correction or rewrite answers only once it settles. */
  cleanupGate: null as null | Promise<void>,
}));

vi.mock("../../../services/VoiceTranscriptionService.js", () => ({
  VoiceTranscriptionService: function VoiceTranscriptionService(this: Record<string, unknown>) {
    this.onEvent = function (cb: (e: MockTranscriptionEvent) => void) {
      shared.transcriptionEventCallback = (e) =>
        cb({ ...e, sessionId: shared.providerSessionId ?? undefined });
      return () => {};
    };
    this.keytermsNeededToConnect = function (settings: { transcriptionProvider?: string }) {
      return (
        settings.transcriptionProvider === "deepgram" || settings.transcriptionProvider === "grok"
      );
    };
    this.start = function (
      settings: unknown,
      sessionId: string,
      context?: { keyterms?: Promise<string[]> }
    ) {
      shared.providerSessionId = sessionId;
      shared.startCalls.push(settings);
      shared.startContexts.push(context);
      return Promise.resolve({ ok: true });
    };
    this.getSessionStats = () => null;
    this.stopGracefully = function () {
      if (shared.useDeferredDrain) {
        return new Promise<void>((resolve, reject) => {
          shared.drainResolve = resolve;
          shared.drainReject = reject;
        });
      }
      return Promise.resolve();
    };
    this.sendAudioChunk = function () {};
    this.stop = function () {};
    this.destroy = function () {};
    this.commitParagraphBoundary = function () {};
  },
}));

vi.mock("../../../services/VoiceCorrectionService.js", () => ({
  VoiceCorrectionService: function VoiceCorrectionService(this: Record<string, unknown>) {
    this.warm = () => Promise.resolve();
    this.preconnect = () => {};
    this.correct = async function (request: unknown, settings: unknown) {
      shared.correctionCalls.push({ request, settings });
      await shared.cleanupGate;
      if (shared.correctionFailed) {
        const { rawText } = request as { rawText: string };
        return Promise.resolve({
          action: "no_change",
          correctedText: rawText,
          confidence: "low",
          confirmedText: rawText,
          failed: true,
        });
      }
      return Promise.resolve({
        action: "replace",
        correctedText: "hello world",
        confidence: "high",
        confirmedText: "hello world",
      });
    };
    this.rewrite = async function (request: unknown, settings: unknown) {
      shared.rewriteCalls.push({ request, settings });
      await shared.cleanupGate;
      return { status: "replace", text: "Shorter." };
    };
    this.detectFileLinkTokens = function (utterance: string) {
      shared.fileLinkCalls.push(utterance);
      return Promise.resolve([]);
    };
  },
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProject: vi.fn(() => null),
    getProjectById: vi.fn(() => null),
    getCurrentProjectId: vi.fn(() => null),
  },
}));

// The live-session report goes to every app view; these tests have none.
vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../window/webContentsRegistry.js")>();
  return {
    ...actual,
    getAllAppWebContents: vi.fn(() => []),
    getProjectForWebContents: vi.fn(() => shared.viewProjectId),
  };
});

// The real module's pure helpers (the names screen) stay; only assembly is faked.
vi.mock("../../../services/voiceContextKeyterms.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/voiceContextKeyterms.js")>()),
  assembleTaggedKeyterms: vi.fn(async () =>
    ((await shared.assembleKeyterms?.()) ?? []).map((term) => ({ term, source: "dictionary" }))
  ),
  formatKeytermPrompt: vi.fn(() => ""),
}));

vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn((key: string) => {
      if (key === "voiceInput") {
        return {
          enabled: true,
          openaiApiKey: "sk-test",
          correctionEnabled: true,
          correctionModel: "gpt-6.1-terra",
          dictionary: [],
          correctionCustomInstructions: "",
          language: "en",
          transcriptionModel: "gpt-live-transcribe",
          paragraphingStrategy: "spoken-command",
          resolveFileLinks: true,
        };
      }
      return undefined;
    }),
    set: vi.fn(),
  },
}));

vi.mock("../../channels.js", () => ({
  CHANNELS: {
    VOICE_INPUT_GET_SETTINGS: "voice-input:get-settings",
    VOICE_INPUT_SET_SETTINGS: "voice-input:set-settings",
    VOICE_INPUT_START: "voice-input:start",
    VOICE_INPUT_STOP: "voice-input:stop",
    VOICE_INPUT_AUDIO_CHUNK: "voice-input:audio-chunk",
    VOICE_INPUT_TRANSCRIPTION_DELTA: "voice-input:transcription-delta",
    VOICE_INPUT_TRANSCRIPTION_COMPLETE: "voice-input:transcription-complete",
    VOICE_INPUT_ERROR: "voice-input:error",
    VOICE_INPUT_STATUS: "voice-input:status",
    VOICE_INPUT_CHECK_MIC_PERMISSION: "voice-input:check-mic-permission",
    VOICE_INPUT_REQUEST_MIC_PERMISSION: "voice-input:request-mic-permission",
    VOICE_INPUT_OPEN_MIC_SETTINGS: "voice-input:open-mic-settings",
    VOICE_INPUT_VALIDATE_API_KEY: "voice-input:validate-api-key",
    VOICE_INPUT_CORRECT: "voice-input:correct",
    VOICE_INPUT_FLUSH_PARAGRAPH: "voice-input:flush-paragraph",
    VOICE_INPUT_PARAGRAPH_BOUNDARY: "voice-input:paragraph-boundary",
    VOICE_INPUT_FILE_TOKEN_RESOLVED: "voice-input:file-token-resolved",
    VOICE_INPUT_SESSION_ENDED: "voice-input:session-ended",
    VOICE_INPUT_STOP_REQUESTED: "voice-input:stop-requested",
  },
}));

// ── Module import (once) ───────────────────────────────────────────────────
import { registerVoiceInputHandlers, getVoiceSettings, validateOpenAIKey } from "../voiceInput.js";
import { isDictationViewHeld } from "../../../services/voice/dictationViewHold.js";
import { ValidationError } from "../../validationError.js";

// ── Helpers ────────────────────────────────────────────────────────────────

type SentMessage = { channel: string; payload: unknown };

// Events go to the view that started the session, so the fake view records into
// whichever window's log the test is currently reading.
let activeSent: SentMessage[] = [];

function buildMainWindow(): {
  webContents: { send: ReturnType<typeof vi.fn> };
  isDestroyed: ReturnType<typeof vi.fn>;
  __sent: SentMessage[];
} {
  const sentMessages: SentMessage[] = [];
  activeSent = sentMessages;
  return {
    webContents: {
      send: vi.fn((channel: string, payload: unknown) => {
        sentMessages.push({ channel, payload });
      }),
    },
    isDestroyed: vi.fn(() => false),
    __sent: sentMessages,
  };
}

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`No handler registered for channel: ${channel}`);
  return call[1] as (...args: unknown[]) => unknown;
}

const fakeEvent = {
  sender: {
    id: 1,
    once: vi.fn(),
    removeListener: vi.fn(),
    isDestroyed: () => false,
    send: vi.fn((channel: string, payload: unknown) => {
      activeSent.push({ channel, payload });
    }),
  },
} as unknown as Electron.IpcMainInvokeEvent;

type SessionHandler = (e: unknown, sessionId: string) => Promise<unknown>;

// Each start mints a fresh session id, as the renderer does; stops and the
// payload expectations use the latest one.
let nextSessionNumber = 1;
let currentSessionId = "";
function nextSessionId(): string {
  currentSessionId = `session-${nextSessionNumber++}`;
  return currentSessionId;
}

function emitTranscriptionEvent(event: MockTranscriptionEvent) {
  if (!shared.transcriptionEventCallback) {
    throw new Error("No transcription event callback registered — was handleStart called?");
  }
  shared.transcriptionEventCallback(event);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("voiceInput — IPC handler surface", () => {
  let win: ReturnType<typeof buildMainWindow>;
  let cleanup: () => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    shared.transcriptionEventCallback = null;
    shared.drainResolve = null;
    shared.useDeferredDrain = false;
    shared.correctionCalls = [];
    shared.correctionFailed = false;
    shared.startCalls = [];
    shared.startContexts = [];
    shared.assembleKeyterms = null;

    win = buildMainWindow();
    cleanup = registerVoiceInputHandlers({
      mainWindow: win as unknown as Electron.BrowserWindow,
    } as Parameters<typeof registerVoiceInputHandlers>[0]);

    const handleStart = getHandler("voice-input:start");
    await (handleStart as SessionHandler)(fakeEvent, nextSessionId());
  });

  afterEach(() => {
    cleanup?.();
    shared.assembleKeyterms = null;
  });

  it("paragraph_boundary forwards a payload with only rawText", () => {
    emitTranscriptionEvent({ type: "paragraph_boundary" });

    const boundaryMsg = win.__sent.find((m) => m.channel === "voice-input:paragraph-boundary");
    expect(boundaryMsg).toBeDefined();
    expect(boundaryMsg?.payload).toEqual({ sessionId: currentSessionId, rawText: null });
  });

  it("correct validates payloads and returns the corrected text", async () => {
    const handleCorrect = getHandler("voice-input:correct");

    const result = await (handleCorrect as (e: unknown, request: unknown) => Promise<unknown>)(
      fakeEvent,
      { rawText: "helo world", recentContext: ["previous sentence"] }
    );

    // The mocked service sent nothing, so main's share is all preparation.
    expect(result).toEqual({
      action: "replace",
      correctedText: "hello world",
      timing: { prepMs: expect.any(Number), requestMs: null },
    });
    expect(shared.correctionCalls).toHaveLength(1);
    expect(shared.correctionCalls[0]?.request).toMatchObject({
      rawText: "helo world",
      recentContext: ["previous sentence"],
      reason: "stop",
    });
    expect(shared.correctionCalls[0]?.settings).toMatchObject({
      model: "gpt-6.1-terra",
      apiKey: "sk-test",
    });
  });

  it("correct keeps the asking view until its answer is back (#14773)", async () => {
    const handleCorrect = getHandler("voice-input:correct") as (
      e: unknown,
      request: unknown
    ) => Promise<unknown>;
    const view = { ...fakeEvent.sender, id: 2 } as unknown as Electron.WebContents;
    let answer!: () => void;
    shared.cleanupGate = new Promise<void>((resolve) => {
      answer = resolve;
    });

    vi.useFakeTimers();
    try {
      const pending = handleCorrect({ sender: view }, { rawText: "helo world" });
      await Promise.resolve();
      expect(isDictationViewHeld(view)).toBe(true);

      answer();
      await pending;
      // Still held while the reply reaches the view and lands in its draft.
      expect(isDictationViewHeld(view)).toBe(true);
      vi.advanceTimersByTime(5_000);
      expect(isDictationViewHeld(view)).toBe(false);
    } finally {
      shared.cleanupGate = null;
      vi.useRealTimers();
    }
  });

  it("correct lets go of the asking view when the handlers go away mid-request", async () => {
    const handleCorrect = getHandler("voice-input:correct") as (
      e: unknown,
      request: unknown
    ) => Promise<unknown>;
    const view = { ...fakeEvent.sender, id: 3 } as unknown as Electron.WebContents;
    let answer!: () => void;
    shared.cleanupGate = new Promise<void>((resolve) => {
      answer = resolve;
    });

    try {
      const pending = handleCorrect({ sender: view }, { rawText: "helo world" });
      await Promise.resolve();
      expect(isDictationViewHeld(view)).toBe(true);

      cleanup();
      cleanup = () => {};
      expect(isDictationViewHeld(view)).toBe(false);

      // An answer arriving after teardown takes no new hold.
      answer();
      await pending;
      expect(isDictationViewHeld(view)).toBe(false);
    } finally {
      shared.cleanupGate = null;
    }
  });

  it("correct tells the renderer when the request failed", async () => {
    shared.correctionFailed = true;
    const handleCorrect = getHandler("voice-input:correct");

    const result = await (handleCorrect as (e: unknown, request: unknown) => Promise<unknown>)(
      fakeEvent,
      { rawText: "helo world" }
    );

    expect(result).toEqual({
      action: "no_change",
      correctedText: "helo world",
      failed: true,
      timing: { prepMs: expect.any(Number), requestMs: null },
    });
  });

  it("correct rejects malformed payloads before invoking correction", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const handleCorrect = getHandler("voice-input:correct");

      await expect(
        (handleCorrect as (e: unknown, request: unknown) => Promise<unknown>)(fakeEvent, {
          recentContext: [],
        })
      ).rejects.toBeInstanceOf(ValidationError);

      expect(shared.correctionCalls).toHaveLength(0);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("status events are forwarded to the renderer unchanged", () => {
    // "error" last: a terminal status ends the session, so nothing after it is forwarded.
    for (const status of [
      "connecting",
      "recording",
      "reconnecting",
      "finishing",
      "error",
    ] as const) {
      emitTranscriptionEvent({ type: "status", status });
    }

    const statusMsgs = win.__sent.filter((m) => m.channel === "voice-input:status");
    expect(statusMsgs.map((m) => m.payload)).toEqual(
      ["connecting", "recording", "reconnecting", "finishing", "error"].map((status) => ({
        sessionId: currentSessionId,
        status,
      }))
    );
  });

  it("does not start the provider when a stop lands during keyterm assembly", async () => {
    // The beforeEach already opened a session; tear it down so this test owns
    // a clean start whose assembly window we can control.
    const handleStop = getHandler("voice-input:stop");
    await (handleStop as SessionHandler)(fakeEvent, currentSessionId);
    shared.startCalls = [];
    shared.startContexts = [];

    // Begin a new session whose keyterm assembly hangs until we resolve it.
    // Only Deepgram waits for assembly before starting its provider.
    const { store } = await import("../../../store.js");
    const { assembleTaggedKeyterms } = await import("../../../services/voiceContextKeyterms.js");
    const readStore = vi.mocked(store.get).getMockImplementation()!;
    vi.mocked(store.get).mockImplementation((key: string) =>
      key === "voiceInput"
        ? {
            ...(readStore(key) as object),
            deepgramApiKey: "dg-test",
            transcriptionProvider: "deepgram",
          }
        : readStore(key)
    );
    try {
      let resolveAssembly!: (terms: string[]) => void;
      const assemblyPromise = new Promise<string[]>((resolve) => {
        resolveAssembly = resolve;
      });
      shared.assembleKeyterms = () => assemblyPromise;
      const assembliesBefore = vi.mocked(assembleTaggedKeyterms).mock.calls.length;
      const handleStart = getHandler("voice-input:start");
      const startPromise = (handleStart as SessionHandler)(fakeEvent, nextSessionId());

      // Stop arrives mid-assembly, then assembly finishes.
      await vi.waitFor(() =>
        expect(vi.mocked(assembleTaggedKeyterms).mock.calls.length).toBeGreaterThan(
          assembliesBefore
        )
      );
      expect(shared.startCalls).toHaveLength(0);
      await (handleStop as SessionHandler)(fakeEvent, currentSessionId);
      resolveAssembly(["Daintree"]);

      await expect(startPromise).resolves.toEqual({ status: "superseded" });
      // The superseded start must never reach svc.start().
      expect(shared.startCalls).toHaveLength(0);
    } finally {
      vi.mocked(store.get).mockImplementation(readStore);
    }
  });
});

describe("voiceInput — spoken-command paragraphing", () => {
  let win: ReturnType<typeof buildMainWindow>;
  let cleanup: () => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    shared.transcriptionEventCallback = null;
    shared.drainResolve = null;
    shared.useDeferredDrain = false;

    win = buildMainWindow();
    cleanup = registerVoiceInputHandlers({
      mainWindow: win as unknown as Electron.BrowserWindow,
    } as Parameters<typeof registerVoiceInputHandlers>[0]);

    const handleStart = getHandler("voice-input:start");
    await (handleStart as SessionHandler)(fakeEvent, nextSessionId());
  });

  afterEach(() => {
    cleanup?.();
  });

  it("splits text containing a literal \\n\\n into separate completes with a paragraph-boundary between", () => {
    // OpenAI may emit a `\n\n` inside a single completed item when the model
    // detects a paragraph break. The handler is expected to split on that
    // boundary and interleave a paragraph-boundary event.
    emitTranscriptionEvent({
      type: "complete",
      text: "first sentence\n\nsecond sentence",
    });

    const splitEvents = win.__sent.filter(
      (m) =>
        m.channel === "voice-input:transcription-complete" ||
        m.channel === "voice-input:paragraph-boundary"
    );
    expect(splitEvents).toEqual([
      {
        channel: "voice-input:transcription-complete",
        payload: { sessionId: currentSessionId, text: "first sentence", willCorrect: false },
      },
      {
        channel: "voice-input:paragraph-boundary",
        payload: { sessionId: currentSessionId, rawText: null, correctionId: null },
      },
      {
        channel: "voice-input:transcription-complete",
        payload: { sessionId: currentSessionId, text: "second sentence", willCorrect: false },
      },
    ]);
  });

  const dictated = () =>
    win.__sent.filter(
      (m) =>
        m.channel === "voice-input:transcription-complete" ||
        m.channel === "voice-input:paragraph-boundary"
    );

  it("emits the prefix then a boundary for a trailing 'new paragraph'", () => {
    emitTranscriptionEvent({ type: "complete", text: "hello new paragraph", endOfSpeech: true });

    expect(dictated()).toEqual([
      {
        channel: "voice-input:transcription-complete",
        payload: { sessionId: currentSessionId, text: "hello", willCorrect: false },
      },
      {
        channel: "voice-input:paragraph-boundary",
        payload: { sessionId: currentSessionId, rawText: null, correctionId: null },
      },
    ]);
  });

  it("emits the prefix then a boundary for a trailing 'new line'", () => {
    emitTranscriptionEvent({ type: "complete", text: "fix the bug new line", endOfSpeech: true });

    expect(dictated()).toEqual([
      {
        channel: "voice-input:transcription-complete",
        payload: { sessionId: currentSessionId, text: "fix the bug", willCorrect: false },
      },
      {
        channel: "voice-input:paragraph-boundary",
        payload: { sessionId: currentSessionId, rawText: null, correctionId: null },
      },
    ]);
  });

  it("emits only a boundary when the utterance is just a paragraph command", () => {
    emitTranscriptionEvent({ type: "complete", text: "New paragraph.", endOfSpeech: true });

    expect(dictated()).toEqual([
      {
        channel: "voice-input:paragraph-boundary",
        payload: { sessionId: currentSessionId, rawText: null, correctionId: null },
      },
    ]);
  });

  it("keeps spoken punctuation words literal", () => {
    emitTranscriptionEvent({ type: "complete", text: "What's the retention period" });

    expect(dictated()).toEqual([
      {
        channel: "voice-input:transcription-complete",
        payload: {
          sessionId: currentSessionId,
          text: "What's the retention period",
          willCorrect: false,
        },
      },
    ]);
  });

  it("forwards deltas as { text, itemId, replace } envelopes", () => {
    emitTranscriptionEvent({ type: "delta", text: "hel", itemId: "item-A" });
    emitTranscriptionEvent({ type: "delta", text: "lo" });
    emitTranscriptionEvent({ type: "delta", text: "Hello", itemId: "span-1", replace: true });

    const deltas = win.__sent.filter((m) => m.channel === "voice-input:transcription-delta");
    expect(deltas.map((m) => m.payload)).toEqual([
      { sessionId: currentSessionId, text: "hel", itemId: "item-A" },
      { sessionId: currentSessionId, text: "lo" },
      { sessionId: currentSessionId, text: "Hello", itemId: "span-1", replace: true },
    ]);
  });

  it("tags every split part of an identified completion with its item id", () => {
    emitTranscriptionEvent({
      type: "complete",
      text: "first sentence\n\nsecond sentence",
      itemId: "item-A",
    });

    const completes = win.__sent.filter((m) => m.channel === "voice-input:transcription-complete");
    expect(completes.map((m) => m.payload)).toEqual([
      { sessionId: currentSessionId, text: "first sentence", willCorrect: false, itemId: "item-A" },
      {
        sessionId: currentSessionId,
        text: "second sentence",
        willCorrect: false,
        itemId: "item-A",
      },
    ]);
  });

  it("sends one empty completion for an identified command-only utterance", () => {
    emitTranscriptionEvent({
      type: "complete",
      text: "new paragraph",
      itemId: "item-A",
      endOfSpeech: true,
    });

    const completes = win.__sent.filter((m) => m.channel === "voice-input:transcription-complete");
    const boundaries = win.__sent.filter((m) => m.channel === "voice-input:paragraph-boundary");
    expect(completes.map((m) => m.payload)).toEqual([
      { sessionId: currentSessionId, text: "", willCorrect: false, itemId: "item-A" },
    ]);
    expect(boundaries).toHaveLength(1);
  });

  it("strips a trailing 'send it' that ends the utterance and flags the send", () => {
    emitTranscriptionEvent({
      type: "complete",
      text: "Fix the login bug, send it.",
      itemId: "item-A",
      endOfSpeech: true,
    });

    expect(dictated()).toEqual([
      {
        channel: "voice-input:transcription-complete",
        payload: {
          sessionId: currentSessionId,
          text: "Fix the login bug",
          willCorrect: false,
          itemId: "item-A",
          send: true,
        },
      },
    ]);
  });

  it("flags the send on a trailing completion after a break command", () => {
    emitTranscriptionEvent({
      type: "complete",
      text: "hello new line send it",
      itemId: "item-A",
      endOfSpeech: true,
    });

    expect(dictated()).toEqual([
      {
        channel: "voice-input:transcription-complete",
        payload: {
          sessionId: currentSessionId,
          text: "hello",
          willCorrect: false,
          itemId: "item-A",
        },
      },
      {
        channel: "voice-input:paragraph-boundary",
        payload: { sessionId: currentSessionId, rawText: null, correctionId: null },
      },
      {
        channel: "voice-input:transcription-complete",
        payload: {
          sessionId: currentSessionId,
          text: "",
          willCorrect: false,
          itemId: "item-A",
          send: true,
        },
      },
    ]);
  });

  it("sends one empty flagged completion for a lone 'send it'", () => {
    emitTranscriptionEvent({
      type: "complete",
      text: "Send it.",
      itemId: "item-A",
      endOfSpeech: true,
    });

    expect(dictated()).toEqual([
      {
        channel: "voice-input:transcription-complete",
        payload: {
          sessionId: currentSessionId,
          text: "",
          willCorrect: false,
          itemId: "item-A",
          send: true,
        },
      },
    ]);
  });

  // Until the utterance says what it was, the item keeps its preview.
  it("holds a trailing 'send it' cut mid-speech, then keeps it literal as the speaker goes on", () => {
    emitTranscriptionEvent({ type: "complete", text: "then send it", itemId: "item-A" });
    expect(dictated()).toEqual([]);

    emitTranscriptionEvent({ type: "complete", text: "and log it", itemId: "item-B" });
    expect(dictated()).toEqual([
      {
        channel: "voice-input:transcription-complete",
        payload: {
          sessionId: currentSessionId,
          text: "then send it",
          willCorrect: false,
          itemId: "item-A",
        },
      },
      {
        channel: "voice-input:transcription-complete",
        payload: {
          sessionId: currentSessionId,
          text: "and log it",
          willCorrect: false,
          itemId: "item-B",
        },
      },
    ]);
  });

  it("holds a 'new line' cut mid-speech until the utterance shows where it falls", () => {
    emitTranscriptionEvent({ type: "complete", text: "fix the bug new line", itemId: "item-A" });
    expect(dictated()).toEqual([]);

    // The closing item has no words of its own, so it retires first.
    emitTranscriptionEvent({ type: "complete", text: "", itemId: "item-B", endOfSpeech: true });
    expect(dictated()).toEqual([
      {
        channel: "voice-input:transcription-complete",
        payload: { sessionId: currentSessionId, text: "", willCorrect: false, itemId: "item-B" },
      },
      {
        channel: "voice-input:transcription-complete",
        payload: {
          sessionId: currentSessionId,
          text: "fix the bug",
          willCorrect: false,
          itemId: "item-A",
        },
      },
      {
        channel: "voice-input:paragraph-boundary",
        payload: { sessionId: currentSessionId, rawText: null, correctionId: null },
      },
    ]);
  });

  it("lands a segment cut mid-speech at once when nothing at its end could be a command", () => {
    emitTranscriptionEvent({ type: "complete", text: "fix the login", itemId: "item-A" });

    expect(dictated()).toEqual([
      {
        channel: "voice-input:transcription-complete",
        payload: {
          sessionId: currentSessionId,
          text: "fix the login",
          willCorrect: false,
          itemId: "item-A",
        },
      },
    ]);
  });

  it("keeps a mid-sentence 'send it' literal", () => {
    emitTranscriptionEvent({
      type: "complete",
      text: "then send it to the API",
      endOfSpeech: true,
    });

    expect(dictated()).toEqual([
      {
        channel: "voice-input:transcription-complete",
        payload: {
          sessionId: currentSessionId,
          text: "then send it to the API",
          willCorrect: false,
        },
      },
    ]);
  });

  it("leaves a trailing 'period' literal on the emitted text", () => {
    emitTranscriptionEvent({ type: "complete", text: "hello period" });

    const complete = win.__sent.find((m) => m.channel === "voice-input:transcription-complete");
    expect(complete?.payload).toEqual({
      sessionId: currentSessionId,
      text: "hello period",
      willCorrect: false,
    });
  });

  it("leaves a mid-sentence 'new paragraph' literal (applyDictationCommands is trailing-only)", () => {
    emitTranscriptionEvent({
      type: "complete",
      text: "hello new paragraph world",
    });

    const completes = win.__sent.filter((m) => m.channel === "voice-input:transcription-complete");
    const boundaries = win.__sent.filter((m) => m.channel === "voice-input:paragraph-boundary");
    expect(completes).toHaveLength(1);
    expect(completes[0]?.payload).toEqual({
      sessionId: currentSessionId,
      text: "hello new paragraph world",
      willCorrect: false,
    });
    expect(boundaries).toHaveLength(0);
  });
});

describe.each(["deepgram", "grok"] as const)("voiceInput — spoken send on %s", (provider) => {
  let win: ReturnType<typeof buildMainWindow>;
  let cleanup: () => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    shared.transcriptionEventCallback = null;
    shared.drainResolve = null;
    shared.drainReject = null;
    shared.useDeferredDrain = false;

    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValue({
      enabled: true,
      openaiApiKey: "",
      deepgramApiKey: provider === "deepgram" ? "dg-test" : "",
      xaiApiKey: provider === "grok" ? "xai-test" : "",
      correctionEnabled: false,
      correctionModel: "gpt-6.1-terra",
      dictionary: [],
      correctionCustomInstructions: "",
      language: "en",
      transcriptionProvider: provider,
      transcriptionModel: "gpt-live-transcribe",
      paragraphingStrategy: "spoken-command",
      resolveFileLinks: true,
    });

    win = buildMainWindow();
    cleanup = registerVoiceInputHandlers({
      mainWindow: win as unknown as Electron.BrowserWindow,
    } as Parameters<typeof registerVoiceInputHandlers>[0]);

    const handleStart = getHandler("voice-input:start");
    await (handleStart as SessionHandler)(fakeEvent, nextSessionId());
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup?.();
    vi.useRealTimers();
  });

  const toRenderer = () =>
    win.__sent
      .filter((m) => m.channel !== "voice-input:session-ended")
      .map((m) => ({ channel: m.channel, payload: m.payload }));

  const sentenceEndingInSend = () =>
    emitTranscriptionEvent({
      type: "complete",
      text: "Fix the login bug, send it.",
      itemId: "item-A",
      endOfSpeech: true,
    });

  const completion = (text: string, extra: Record<string, unknown> = {}) => ({
    channel: "voice-input:transcription-complete",
    payload: { sessionId: currentSessionId, text, willCorrect: false, itemId: "item-A", ...extra },
  });

  it("sends once the speaker has stayed quiet through the settle window", () => {
    sentenceEndingInSend();
    expect(toRenderer()).toEqual([]);

    vi.advanceTimersByTime(699);
    expect(toRenderer()).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(toRenderer()).toEqual([completion("Fix the login bug", { send: true })]);
  });

  it("keeps 'send it' literal when the next words arrive inside the window", () => {
    emitTranscriptionEvent({
      type: "complete",
      text: "then send it",
      itemId: "item-A",
      endOfSpeech: true,
    });
    vi.advanceTimersByTime(300);
    emitTranscriptionEvent({ type: "delta", text: "to the API", itemId: "item-B", replace: true });
    vi.advanceTimersByTime(5000);

    expect(toRenderer()).toEqual([
      completion("then send it"),
      {
        channel: "voice-input:transcription-delta",
        payload: {
          sessionId: currentSessionId,
          text: "to the API",
          itemId: "item-B",
          replace: true,
        },
      },
    ]);
  });

  it("keeps 'send it' literal when another completion arrives inside the window", () => {
    sentenceEndingInSend();
    emitTranscriptionEvent({
      type: "complete",
      text: "to the API.",
      itemId: "item-B",
      endOfSpeech: true,
    });
    vi.advanceTimersByTime(5000);

    expect(toRenderer()).toEqual([
      completion("Fix the login bug, send it."),
      {
        channel: "voice-input:transcription-complete",
        payload: {
          sessionId: currentSessionId,
          text: "to the API.",
          willCorrect: false,
          itemId: "item-B",
        },
      },
    ]);
  });

  it("keeps a held send waiting through a segment that finalised empty", () => {
    sentenceEndingInSend();
    emitTranscriptionEvent({ type: "complete", text: "", itemId: "item-B" });
    vi.advanceTimersByTime(700);

    expect(toRenderer().filter((m) => m.channel === "voice-input:transcription-complete")).toEqual([
      {
        channel: "voice-input:transcription-complete",
        payload: { sessionId: currentSessionId, text: "", willCorrect: false, itemId: "item-B" },
      },
      completion("Fix the login bug", { send: true }),
    ]);
  });

  it("lands a held send's words, stripped and unsent, ahead of a fatal error", () => {
    sentenceEndingInSend();
    emitTranscriptionEvent({
      type: "error",
      error: { severity: "fatal", code: "deepgram_server_error", message: "boom" },
    });
    vi.advanceTimersByTime(5000);

    expect(toRenderer().map((m) => m.channel)).toEqual([
      "voice-input:transcription-complete",
      "voice-input:error",
    ]);
    expect(toRenderer()[0]).toEqual(completion("Fix the login bug"));
  });

  it("waits for a transcript after speech starts, and sends when none comes", () => {
    sentenceEndingInSend();
    vi.advanceTimersByTime(400);
    emitTranscriptionEvent({ type: "speech_started" });

    vi.advanceTimersByTime(1499);
    expect(toRenderer()).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(toRenderer()).toEqual([completion("Fix the login bug", { send: true })]);
  });

  it("keeps 'send it' literal when speech starts and its words follow", () => {
    sentenceEndingInSend();
    vi.advanceTimersByTime(400);
    emitTranscriptionEvent({ type: "speech_started" });
    vi.advanceTimersByTime(1000);
    emitTranscriptionEvent({ type: "delta", text: "to the API", itemId: "item-B", replace: true });
    vi.advanceTimersByTime(5000);

    const completes = toRenderer().filter(
      (m) => m.channel === "voice-input:transcription-complete"
    );
    expect(completes).toEqual([completion("Fix the login bug, send it.")]);
  });

  it("sends when dictation stops inside the window", async () => {
    sentenceEndingInSend();
    vi.advanceTimersByTime(300);

    const handleStop = getHandler("voice-input:stop");
    await (handleStop as SessionHandler)(fakeEvent, currentSessionId);
    vi.advanceTimersByTime(5000);

    expect(toRenderer()).toEqual([completion("Fix the login bug", { send: true })]);
  });

  describe("once dictation stops inside the window", () => {
    function stopDraining() {
      shared.useDeferredDrain = true;
      sentenceEndingInSend();
      vi.advanceTimersByTime(300);
      const handleStop = getHandler("voice-input:stop");
      return (handleStop as SessionHandler)(fakeEvent, currentSessionId);
    }

    it("waits for the drain, not the settle window, to send", async () => {
      const stopping = stopDraining();
      vi.advanceTimersByTime(5000);
      emitTranscriptionEvent({ type: "speech_started" });
      vi.advanceTimersByTime(5000);
      expect(toRenderer()).toEqual([]);

      shared.drainResolve?.();
      await stopping;

      expect(toRenderer()).toEqual([completion("Fix the login bug", { send: true })]);
    });

    it("keeps 'send it' literal when the drain turns up the words the speaker went on with", async () => {
      const stopping = stopDraining();
      emitTranscriptionEvent({
        type: "complete",
        text: "to the API.",
        itemId: "item-B",
        endOfSpeech: true,
      });
      shared.drainResolve?.();
      await stopping;

      expect(toRenderer()).toEqual([
        completion("Fix the login bug, send it."),
        {
          channel: "voice-input:transcription-complete",
          payload: {
            sessionId: currentSessionId,
            text: "to the API.",
            willCorrect: false,
            itemId: "item-B",
          },
        },
      ]);
    });

    it("sends once, ahead of the status, when the provider goes idle at the drain's end", async () => {
      const stopping = stopDraining();
      emitTranscriptionEvent({ type: "status", status: "idle" });
      shared.drainResolve?.();
      await stopping;

      expect(toRenderer()).toEqual([
        completion("Fix the login bug", { send: true }),
        { channel: "voice-input:status", payload: { sessionId: currentSessionId, status: "idle" } },
      ]);
    });

    it("lands the words, stripped and unsent, when the drain fails", async () => {
      const stopping = stopDraining();
      shared.drainReject?.(new Error("drain failed"));
      await expect(stopping).rejects.toThrow("drain failed");

      expect(toRenderer()).toEqual([completion("Fix the login bug")]);
    });

    it("lands the words, stripped and unsent, when the drain reports an error", async () => {
      const stopping = stopDraining();
      const error = { severity: "transient", code: "ws_transport_error", message: "dropped" };
      emitTranscriptionEvent({ type: "error", error });
      shared.drainResolve?.();
      await stopping;

      expect(toRenderer()).toEqual([
        completion("Fix the login bug"),
        { channel: "voice-input:error", payload: { sessionId: currentSessionId, error } },
      ]);
    });

    it("drops the send, and lands nothing after the session ends, when Escape cancels the drain", async () => {
      const stopping = stopDraining();
      const handleCancel = getHandler("voice-input:cancel");
      await (handleCancel as SessionHandler)(fakeEvent, currentSessionId);
      shared.drainResolve?.();
      await stopping;

      expect(toRenderer()).toEqual([]);
    });
  });

  it("sends a held send when another view's dictation key stops it", async () => {
    sentenceEndingInSend();
    vi.advanceTimersByTime(300);
    const otherView = {
      sender: {
        id: 2,
        once: vi.fn(),
        removeListener: vi.fn(),
        isDestroyed: () => false,
        send: vi.fn(),
      },
    } as unknown as Electron.IpcMainInvokeEvent;
    const stopRequested = {
      channel: "voice-input:stop-requested",
      payload: { sessionId: currentSessionId },
    };

    const handleStopLive = getHandler("voice-input:stop-live");
    expect(
      await (handleStopLive as unknown as (event: unknown, request: unknown) => Promise<unknown>)(
        otherView,
        { sessionId: currentSessionId }
      )
    ).toBe(true);
    // The request only asks the owner to stop; the held send is still pending.
    expect(toRenderer()).toEqual([stopRequested]);

    // The owner answers the request with its own stop.
    const handleStop = getHandler("voice-input:stop");
    await (handleStop as SessionHandler)(fakeEvent, currentSessionId);
    vi.advanceTimersByTime(5000);

    expect(toRenderer()).toEqual([stopRequested, completion("Fix the login bug", { send: true })]);
  });

  it("drops a held send, and sends nothing, when Escape cancels inside the window", async () => {
    sentenceEndingInSend();
    vi.advanceTimersByTime(300);
    const cancelledSessionId = currentSessionId;

    const handleCancel = getHandler("voice-input:cancel");
    await (handleCancel as SessionHandler)(fakeEvent, cancelledSessionId);
    vi.advanceTimersByTime(5000);

    expect(toRenderer()).toEqual([]);
    expect(win.__sent.filter((m) => m.channel === "voice-input:session-ended")).toEqual([
      {
        channel: "voice-input:session-ended",
        payload: { sessionId: cancelledSessionId, reason: "cancelled", report: expect.any(Object) },
      },
    ]);
  });

  it("sends a lone 'send it' as one empty completion when dictation stops", async () => {
    emitTranscriptionEvent({
      type: "complete",
      text: "Send it.",
      itemId: "item-A",
      endOfSpeech: true,
    });

    const handleStop = getHandler("voice-input:stop");
    await (handleStop as SessionHandler)(fakeEvent, currentSessionId);

    expect(toRenderer()).toEqual([completion("", { send: true })]);
  });

  it("strips the phrase, ahead of the status, when the provider dies inside the window", () => {
    sentenceEndingInSend();
    emitTranscriptionEvent({ type: "status", status: "error" });
    vi.advanceTimersByTime(5000);

    expect(toRenderer()).toEqual([
      completion("Fix the login bug"),
      {
        channel: "voice-input:status",
        payload: { sessionId: currentSessionId, status: "error" },
      },
    ]);
  });

  it("keeps 'send it' literal, and sends nothing, when the socket drops inside the window", () => {
    sentenceEndingInSend();
    vi.advanceTimersByTime(300);
    emitTranscriptionEvent({ type: "status", status: "reconnecting" });
    vi.advanceTimersByTime(5000);

    expect(toRenderer()).toEqual([
      completion("Fix the login bug, send it."),
      {
        channel: "voice-input:status",
        payload: { sessionId: currentSessionId, status: "reconnecting" },
      },
    ]);
  });

  it("drops a held send when a newer session supersedes it", async () => {
    sentenceEndingInSend();
    const handleStart = getHandler("voice-input:start");
    await (handleStart as SessionHandler)(fakeEvent, nextSessionId());
    vi.advanceTimersByTime(5000);

    expect(win.__sent.filter((m) => m.channel === "voice-input:transcription-complete")).toEqual(
      []
    );
  });

  it("hands its owner the send, to refuse, when another view's start drains it", async () => {
    sentenceEndingInSend();
    const otherView = {
      sender: {
        id: 2,
        once: vi.fn(),
        removeListener: vi.fn(),
        isDestroyed: () => false,
        send: vi.fn(),
      },
    } as unknown as Electron.IpcMainInvokeEvent;
    const heldSessionId = currentSessionId;
    const handleStart = getHandler("voice-input:start");
    await (handleStart as SessionHandler)(otherView, nextSessionId());
    vi.advanceTimersByTime(5000);

    expect(toRenderer()).toEqual([
      {
        channel: "voice-input:status",
        payload: { sessionId: heldSessionId, status: "finishing" },
      },
      {
        channel: "voice-input:transcription-complete",
        payload: {
          sessionId: heldSessionId,
          text: "Fix the login bug",
          willCorrect: false,
          itemId: "item-A",
          send: true,
        },
      },
    ]);
  });

  it("holds a send heard while dictation is already stopping until the drain ends", async () => {
    shared.useDeferredDrain = true;
    const handleStop = getHandler("voice-input:stop");
    const stopping = (handleStop as SessionHandler)(fakeEvent, currentSessionId);
    sentenceEndingInSend();
    vi.advanceTimersByTime(5000);
    expect(toRenderer()).toEqual([]);

    shared.drainResolve?.();
    await stopping;
    expect(toRenderer()).toEqual([completion("Fix the login bug", { send: true })]);
  });

  it("keeps a send heard while stopping literal when the drain's next words follow it", async () => {
    shared.useDeferredDrain = true;
    const handleStop = getHandler("voice-input:stop");
    const stopping = (handleStop as SessionHandler)(fakeEvent, currentSessionId);
    sentenceEndingInSend();
    emitTranscriptionEvent({ type: "delta", text: "to the API", itemId: "item-B", replace: true });
    shared.drainResolve?.();
    await stopping;

    const completes = toRenderer().filter(
      (m) => m.channel === "voice-input:transcription-complete"
    );
    expect(completes).toEqual([completion("Fix the login bug, send it.")]);
  });
});

describe.each(["openai", "deepgram"] as const)(
  "voiceInput — spoken commands split across %s segments",
  (provider) => {
    let win: ReturnType<typeof buildMainWindow>;
    let cleanup: () => void;

    beforeEach(async () => {
      vi.clearAllMocks();
      shared.transcriptionEventCallback = null;
      shared.drainResolve = null;
      shared.useDeferredDrain = false;

      const { store } = await import("../../../store.js");
      vi.mocked(store.get).mockReturnValue({
        enabled: true,
        openaiApiKey: provider === "openai" ? "sk-test" : "",
        deepgramApiKey: provider === "deepgram" ? "dg-test" : "",
        correctionEnabled: false,
        correctionModel: "gpt-6.1-terra",
        dictionary: [],
        correctionCustomInstructions: "",
        language: "en",
        transcriptionProvider: provider,
        transcriptionModel: "gpt-live-transcribe",
        paragraphingStrategy: "spoken-command",
        resolveFileLinks: true,
      });

      win = buildMainWindow();
      cleanup = registerVoiceInputHandlers({
        mainWindow: win as unknown as Electron.BrowserWindow,
      } as Parameters<typeof registerVoiceInputHandlers>[0]);

      const handleStart = getHandler("voice-input:start");
      await (handleStart as SessionHandler)(fakeEvent, nextSessionId());
      vi.useFakeTimers();
    });

    afterEach(() => {
      cleanup?.();
      vi.useRealTimers();
    });

    type Completion = { text: string; itemId?: string; send?: boolean };
    const completes = () =>
      win.__sent
        .filter((m) => m.channel === "voice-input:transcription-complete")
        .map((m) => m.payload as Completion);
    const landed = () =>
      completes()
        .map((c) => c.text)
        .filter(Boolean)
        .join(" ");
    const boundaries = () =>
      win.__sent.filter((m) => m.channel === "voice-input:paragraph-boundary").length;
    const sends = () => completes().filter((c) => c.send).length;
    // Deepgram's short endpoint holds a send a moment longer to confirm the silence.
    const settle = () => vi.advanceTimersByTime(5000);

    it("sends a 'send it' the provider split across two segments", () => {
      emitTranscriptionEvent({ type: "complete", text: "Fix the login bug, send", itemId: "A" });
      emitTranscriptionEvent({ type: "complete", text: "it.", itemId: "B", endOfSpeech: true });
      settle();

      expect(landed()).toBe("Fix the login bug");
      expect(sends()).toBe(1);
      expect(completes().at(-1)?.send).toBe(true);
    });

    // Deepgram closes with a bare end of speech; OpenAI with its last item, empty.
    it("sends a 'send it' whose end of speech arrives as an empty segment", () => {
      emitTranscriptionEvent({
        type: "complete",
        text: "Fix the login bug, send it.",
        itemId: "A",
      });
      emitTranscriptionEvent({
        type: "complete",
        text: "",
        endOfSpeech: true,
        ...(provider === "openai" ? { itemId: "B" } : {}),
      });
      settle();

      const sent = completes().map(({ text, itemId, send }) => ({ text, itemId, send }));
      expect(sent).toEqual([
        ...(provider === "openai" ? [{ text: "", itemId: "B", send: undefined }] : []),
        { text: "Fix the login bug", itemId: "A", send: true },
      ]);
    });

    it("never sends a 'send it' that already landed as words", () => {
      emitTranscriptionEvent({
        type: "complete",
        text: "Fix the login bug, send it",
        itemId: "A",
        endsAtPause: true,
      });
      emitTranscriptionEvent({ type: "complete", text: "", itemId: "B", endOfSpeech: true });
      settle();

      expect(landed()).toBe("Fix the login bug, send it");
      expect(sends()).toBe(0);
    });

    it("reads no command across a segment whose transcript never came", () => {
      emitTranscriptionEvent({
        type: "complete",
        text: "Fix the login bug, send it",
        itemId: "A",
      });
      emitTranscriptionEvent({ type: "complete", text: "", itemId: "B", incomplete: true });
      expect(landed()).toBe("Fix the login bug, send it");

      emitTranscriptionEvent({ type: "complete", text: "", itemId: "C", endOfSpeech: true });
      settle();
      expect(sends()).toBe(0);
    });

    it("reads a send after a dropped socket without the clause before it", () => {
      emitTranscriptionEvent({ type: "complete", text: "Don't change the API", itemId: "A" });
      emitTranscriptionEvent({ type: "status", status: "reconnecting" });
      emitTranscriptionEvent({ type: "complete", text: "send it", itemId: "B", endOfSpeech: true });
      settle();

      expect(sends()).toBe(1);
    });

    it("keeps 'send it' literal when the speaker goes on after the segment it ends", () => {
      emitTranscriptionEvent({ type: "complete", text: "then send it", itemId: "A" });
      emitTranscriptionEvent({
        type: "complete",
        text: "to the API.",
        itemId: "B",
        endOfSpeech: true,
      });
      settle();

      expect(landed()).toBe("then send it to the API.");
      expect(sends()).toBe(0);
    });

    it("reads a 'send it' with the clause an earlier segment opened", () => {
      emitTranscriptionEvent({ type: "complete", text: "Where should the handler", itemId: "A" });
      emitTranscriptionEvent({ type: "complete", text: "send it", itemId: "B", endOfSpeech: true });
      settle();

      expect(landed()).toBe("Where should the handler send it");
      expect(sends()).toBe(0);
    });

    it("keeps a 'new line' literal when a segment cut falls just after it", () => {
      emitTranscriptionEvent({
        type: "complete",
        text: "Make the parser accept a new line",
        itemId: "A",
      });
      emitTranscriptionEvent({
        type: "complete",
        text: "inside quoted strings.",
        itemId: "B",
        endOfSpeech: true,
      });
      settle();

      expect(landed()).toBe("Make the parser accept a new line inside quoted strings.");
      expect(boundaries()).toBe(0);
    });

    it("breaks on a 'new paragraph' that ends what was said, across segments", () => {
      emitTranscriptionEvent({ type: "complete", text: "Fix the bug, new", itemId: "A" });
      emitTranscriptionEvent({
        type: "complete",
        text: "paragraph.",
        itemId: "B",
        endOfSpeech: true,
      });
      settle();

      expect(landed()).toBe("Fix the bug,");
      expect(boundaries()).toBe(1);
    });

    it("retires every segment's preview, even those a command swallowed", () => {
      emitTranscriptionEvent({ type: "complete", text: "Fix the login bug, send", itemId: "A" });
      emitTranscriptionEvent({ type: "complete", text: "it.", itemId: "B", endOfSpeech: true });
      settle();

      expect(completes().map(({ text, itemId }) => ({ text, itemId }))).toEqual([
        { text: "", itemId: "B" },
        { text: "Fix the login bug", itemId: "A" },
      ]);
    });

    it("carries the provider's unsure words into the words that land", () => {
      emitTranscriptionEvent({
        type: "complete",
        text: "Fix the logn bug, send",
        itemId: "A",
        uncertain: [{ from: 8, to: 12 }],
      });
      emitTranscriptionEvent({ type: "complete", text: "it.", itemId: "B", endOfSpeech: true });
      settle();

      expect(completes().find((c) => c.itemId === "A")).toMatchObject({
        text: "Fix the logn bug",
        uncertain: [{ from: 8, to: 12 }],
        send: true,
      });
    });

    it("breaks on a 'new line' the provider closed at a pause, though speech went on", () => {
      emitTranscriptionEvent({
        type: "complete",
        text: "Fix the bug new line",
        itemId: "A",
        endsAtPause: true,
      });
      expect(landed()).toBe("Fix the bug");
      expect(boundaries()).toBe(1);
    });

    it("lands what a stop leaves waiting, reading its break commands and sending nothing", async () => {
      emitTranscriptionEvent({
        type: "complete",
        text: "Fix the bug, send it new line",
        itemId: "A",
      });
      expect(completes()).toEqual([]);

      const handleStop = getHandler("voice-input:stop");
      await (handleStop as SessionHandler)(fakeEvent, currentSessionId);

      expect(landed()).toBe("Fix the bug, send it");
      expect(boundaries()).toBe(1);
      expect(sends()).toBe(0);
    });

    it("sends a 'send it' a stop leaves waiting, split across segments", async () => {
      emitTranscriptionEvent({ type: "complete", text: "Fix the login bug, send", itemId: "A" });
      emitTranscriptionEvent({ type: "complete", text: "it.", itemId: "B" });
      expect(completes()).toEqual([]);

      const handleStop = getHandler("voice-input:stop");
      await (handleStop as SessionHandler)(fakeEvent, currentSessionId);

      expect(landed()).toBe("Fix the login bug");
      expect(sends()).toBe(1);
      expect(completes().at(-1)?.send).toBe(true);
    });

    describe("while the stop drains", () => {
      function stopDraining() {
        shared.useDeferredDrain = true;
        const handleStop = getHandler("voice-input:stop");
        return (handleStop as SessionHandler)(fakeEvent, currentSessionId);
      }

      it("sends a 'send it' the provider closed at a pause", async () => {
        const stopping = stopDraining();
        emitTranscriptionEvent({
          type: "complete",
          text: "Fix the login bug, send it.",
          itemId: "A",
          endsAtPause: true,
        });
        expect(completes()).toEqual([]);
        shared.drainResolve?.();
        await stopping;

        expect(landed()).toBe("Fix the login bug");
        expect(sends()).toBe(1);
        expect(completes().at(-1)?.send).toBe(true);
      });

      it("keeps it literal when the drain's next segment carries on past it", async () => {
        const stopping = stopDraining();
        emitTranscriptionEvent({
          type: "complete",
          text: "then send it",
          itemId: "A",
          endsAtPause: true,
        });
        emitTranscriptionEvent({
          type: "complete",
          text: "to the API.",
          itemId: "B",
          endsAtPause: true,
        });
        shared.drainResolve?.();
        await stopping;

        expect(landed()).toBe("then send it to the API.");
        expect(sends()).toBe(0);
      });

      it("never sends a 'send it' whose clause a pause left open", async () => {
        const stopping = stopDraining();
        emitTranscriptionEvent({
          type: "complete",
          text: "Where should the handler",
          itemId: "A",
          endsAtPause: true,
        });
        emitTranscriptionEvent({ type: "complete", text: "send it", itemId: "B" });
        shared.drainResolve?.();
        await stopping;

        expect(landed()).toBe("Where should the handler send it");
        expect(sends()).toBe(0);
      });

      it("lands held words as said, unsent, when the drain reports an error", async () => {
        const stopping = stopDraining();
        emitTranscriptionEvent({
          type: "complete",
          text: "Fix the login bug, send it",
          itemId: "A",
        });
        expect(completes()).toEqual([]);
        emitTranscriptionEvent({
          type: "error",
          error: { severity: "transient", code: "ws_transport_error", message: "dropped" },
        });
        shared.drainResolve?.();
        await stopping;

        expect(landed()).toBe("Fix the login bug, send it");
        expect(sends()).toBe(0);
        const channels = win.__sent.map((m) => m.channel);
        expect(channels.indexOf("voice-input:transcription-complete")).toBeLessThan(
          channels.indexOf("voice-input:error")
        );
      });

      it("sends a split 'send it' once, ahead of the provider's idle", async () => {
        const stopping = stopDraining();
        emitTranscriptionEvent({ type: "complete", text: "Fix the login bug, send", itemId: "A" });
        emitTranscriptionEvent({ type: "complete", text: "it.", itemId: "B" });
        emitTranscriptionEvent({ type: "status", status: "idle" });
        const beforeIdle = win.__sent.findIndex(
          (m) =>
            m.channel === "voice-input:status" &&
            (m.payload as { status?: string }).status === "idle"
        );
        expect(sends()).toBe(1);
        shared.drainResolve?.();
        await stopping;

        expect(landed()).toBe("Fix the login bug");
        expect(sends()).toBe(1);
        const sentAt = win.__sent.findIndex(
          (m) => (m.payload as { send?: boolean } | undefined)?.send
        );
        expect(sentAt).toBeLessThan(beforeIdle);
      });
    });

    it("keeps a 'send it' that belongs to the sentence as words when a stop ends it", async () => {
      emitTranscriptionEvent({
        type: "complete",
        text: "Where should the handler send it",
        itemId: "A",
      });
      expect(completes()).toEqual([]);

      const handleStop = getHandler("voice-input:stop");
      await (handleStop as SessionHandler)(fakeEvent, currentSessionId);

      expect(landed()).toBe("Where should the handler send it");
      expect(sends()).toBe(0);
    });

    it("keeps held words as said, ahead of the status, when the socket drops", () => {
      emitTranscriptionEvent({ type: "complete", text: "Fix the bug new line", itemId: "A" });
      emitTranscriptionEvent({ type: "status", status: "reconnecting" });

      const channels = win.__sent.map((m) => m.channel);
      expect(channels).toEqual(["voice-input:transcription-complete", "voice-input:status"]);
      expect(landed()).toBe("Fix the bug new line");
      expect(boundaries()).toBe(0);
    });

    it("lands held words ahead of a provider failure", () => {
      emitTranscriptionEvent({ type: "complete", text: "Fix the login bug, send", itemId: "A" });
      emitTranscriptionEvent({
        type: "error",
        error: { severity: "fatal", code: "boom", message: "provider failed" },
      });

      expect(win.__sent.map((m) => m.channel).slice(0, 2)).toEqual([
        "voice-input:transcription-complete",
        "voice-input:error",
      ]);
      expect(landed()).toBe("Fix the login bug, send");
      expect(sends()).toBe(0);
    });

    it("drops held words when Escape cancels", async () => {
      emitTranscriptionEvent({ type: "complete", text: "Fix the bug new line", itemId: "A" });

      const handleCancel = getHandler("voice-input:cancel");
      await (handleCancel as SessionHandler)(fakeEvent, currentSessionId);
      settle();

      expect(completes()).toEqual([]);
    });

    it("counts a bare end of speech as no segment of its own", async () => {
      emitTranscriptionEvent({ type: "complete", text: "Fix it, send it.", itemId: "A" });
      emitTranscriptionEvent({ type: "complete", text: "", endOfSpeech: true });
      emitTranscriptionEvent({ type: "complete", text: "", itemId: "B" });
      settle();

      const handleStop = getHandler("voice-input:stop");
      await (handleStop as SessionHandler)(fakeEvent, currentSessionId);
      const ended = win.__sent.find((m) => m.channel === "voice-input:session-ended");
      expect(ended?.payload).toMatchObject({
        report: { completedSegments: 1, emptyCompletions: 1 },
      });
    });
  }
);

describe("voiceInput — manual paragraphing strategy", () => {
  let win: ReturnType<typeof buildMainWindow>;
  let cleanup: () => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    shared.transcriptionEventCallback = null;
    shared.drainResolve = null;
    shared.useDeferredDrain = false;

    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValue({
      enabled: true,
      openaiApiKey: "sk-test",
      correctionEnabled: true,
      correctionModel: "gpt-6.1-terra",
      dictionary: [],
      correctionCustomInstructions: "",
      language: "en",
      transcriptionModel: "gpt-live-transcribe",
      paragraphingStrategy: "manual",
      resolveFileLinks: true,
    });

    win = buildMainWindow();
    cleanup = registerVoiceInputHandlers({
      mainWindow: win as unknown as Electron.BrowserWindow,
    } as Parameters<typeof registerVoiceInputHandlers>[0]);

    const handleStart = getHandler("voice-input:start");
    await (handleStart as SessionHandler)(fakeEvent, nextSessionId());
  });

  afterEach(() => {
    cleanup?.();
  });

  it("leaves a trailing 'send it' literal and flags no send", () => {
    emitTranscriptionEvent({ type: "complete", text: "fix it send it", endOfSpeech: true });

    const completes = win.__sent.filter((m) => m.channel === "voice-input:transcription-complete");
    expect(completes.map((m) => m.payload)).toEqual([
      { sessionId: currentSessionId, text: "fix it send it", willCorrect: false },
    ]);
  });

  it("leaves spoken commands literal and does not emit paragraph boundaries", () => {
    emitTranscriptionEvent({
      type: "complete",
      text: "hello new paragraph world",
    });

    const completes = win.__sent.filter((m) => m.channel === "voice-input:transcription-complete");
    const boundaries = win.__sent.filter((m) => m.channel === "voice-input:paragraph-boundary");
    expect(completes).toHaveLength(1);
    expect(completes[0]?.payload).toEqual({
      sessionId: currentSessionId,
      text: "hello new paragraph world",
      willCorrect: false,
    });
    expect(boundaries).toHaveLength(0);
  });
});

describe("voiceInput — context keyterms wiring", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function providerSettings(provider: "openai" | "deepgram" | "grok") {
    return {
      enabled: true,
      openaiApiKey: provider === "openai" ? "sk-test" : "",
      deepgramApiKey: provider === "deepgram" ? "dg-test" : "",
      xaiApiKey: provider === "grok" ? "xai-test" : "",
      language: "en",
      dictionary: [],
      transcriptionProvider: provider,
      transcriptionModel: "gpt-live-transcribe",
      correctionEnabled: false,
      correctionModel: "gpt-6.1-terra",
      correctionCustomInstructions: "",
      paragraphingStrategy: "spoken-command",
      resolveFileLinks: true,
      deviceId: "",
      organizationId: "",
      projectId: "",
      recordingMode: "toggle",
    };
  }

  let cleanup: () => void;
  let startFn: SessionHandler;
  let stopFn: SessionHandler;
  let setSettingsFn: (e: unknown, patch: unknown) => Promise<unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();
    shared.transcriptionEventCallback = null;
    shared.startCalls = [];
    shared.startContexts = [];
    shared.assembleKeyterms = null;

    const win = buildMainWindow();
    cleanup = registerVoiceInputHandlers({
      mainWindow: win as unknown as Electron.BrowserWindow,
    } as Parameters<typeof registerVoiceInputHandlers>[0]);

    startFn = getHandler("voice-input:start") as typeof startFn;
    stopFn = getHandler("voice-input:stop") as typeof stopFn;
    setSettingsFn = getHandler("voice-input:set-settings") as typeof setSettingsFn;
  });

  afterEach(() => {
    cleanup?.();
    shared.assembleKeyterms = null;
  });

  it.each(["deepgram", "grok"] as const)(
    "injects assembled keyterms into the %s session settings",
    async (provider) => {
      const { store } = await import("../../../store.js");
      vi.mocked(store.get).mockReturnValue(providerSettings(provider));
      shared.assembleKeyterms = () => Promise.resolve(["alpha", "beta"]);

      await startFn(fakeEvent, nextSessionId());

      expect(shared.startCalls).toHaveLength(1);
      expect(shared.startCalls[0]).toMatchObject({
        transcriptionProvider: provider,
        keyterms: ["alpha", "beta"],
      });
      expect(shared.startContexts[0]).toBeUndefined();
    }
  );

  it("hands a non-Deepgram session its keyterms as a pending start context (OpenAI prompt path)", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValue(providerSettings("openai"));
    const { assembleTaggedKeyterms } = await import("../../../services/voiceContextKeyterms.js");
    shared.assembleKeyterms = () => Promise.resolve(["alpha", "beta"]);

    await startFn(fakeEvent, nextSessionId());

    // OpenAI consumes keyterms via transcription.prompt, so assembly runs for it
    // too, but its socket opens without waiting for them.
    expect(assembleTaggedKeyterms).toHaveBeenCalled();
    expect(shared.startCalls).toHaveLength(1);
    expect(shared.startCalls[0]).toMatchObject({ transcriptionProvider: "openai" });
    expect(shared.startCalls[0]).not.toHaveProperty("keyterms");
    await expect(shared.startContexts[0]?.keyterms).resolves.toEqual(["alpha", "beta"]);
  });

  it("hands keyterm assembly and correction the dictionary's written terms", async () => {
    const { store } = await import("../../../store.js");
    const dictionary = [
      { term: "Daintree", heardAs: ["dane tree"], source: "manual", addedAt: 1 },
      { term: "Zustand", heardAs: [], source: "learned", addedAt: 2 },
    ];
    vi.mocked(store.get).mockReturnValue({
      ...providerSettings("openai"),
      correctionEnabled: true,
      dictionary,
    });
    const { assembleTaggedKeyterms } = await import("../../../services/voiceContextKeyterms.js");

    await startFn(fakeEvent, nextSessionId());
    await (getHandler("voice-input:correct") as (e: unknown, r: unknown) => Promise<unknown>)(
      fakeEvent,
      { rawText: "open dane tree" }
    );

    expect(vi.mocked(assembleTaggedKeyterms).mock.calls.at(-1)?.[0]).toMatchObject({
      customDictionary: ["Daintree", "Zustand"],
    });
    expect(shared.correctionCalls.at(-1)?.settings).toMatchObject({
      customDictionary: ["Daintree", "Zustand"],
      heardAs: [{ heard: "dane tree", term: "Daintree" }],
    });
  });

  it("writes each completed utterance with the heard-as rules the session started with", async () => {
    const { store } = await import("../../../store.js");
    const settings = {
      ...providerSettings("deepgram"),
      dictionary: [{ term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 1 }],
    };
    vi.mocked(store.get).mockReturnValue(settings);
    const { assembleTaggedKeyterms } = await import("../../../services/voiceContextKeyterms.js");

    await startFn(fakeEvent, nextSessionId());
    emitTranscriptionEvent({ type: "complete", text: "add Zoo Stand to @zoo stand" });
    vi.mocked(store.get).mockReturnValue({ ...settings, dictionary: [] });
    emitTranscriptionEvent({ type: "complete", text: "then zoo stand again" });

    const completes = activeSent
      .filter((m) => m.channel === "voice-input:transcription-complete")
      .map((m) => m.payload);
    expect(completes).toEqual([
      {
        sessionId: currentSessionId,
        text: "add Zustand to @zoo stand",
        willCorrect: false,
        heard: "add Zoo Stand to @zoo stand",
      },
      {
        sessionId: currentSessionId,
        text: "then Zustand again",
        willCorrect: false,
        heard: "then zoo stand again",
      },
    ]);
    // A rule never keeps the written term from biasing the transcriber.
    expect(vi.mocked(assembleTaggedKeyterms).mock.calls.at(-1)?.[0]).toMatchObject({
      customDictionary: ["Zustand"],
    });
  });

  it("runs spoken commands before the rules and sends no heard text when nothing changed", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValue({
      ...providerSettings("openai"),
      dictionary: [
        { term: "NewLine", heardAs: ["new line"], source: "manual", addedAt: 1 },
        { term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 2 },
      ],
    });

    await startFn(fakeEvent, nextSessionId());
    emitTranscriptionEvent({ type: "complete", text: "use zoo stand new line", endOfSpeech: true });
    emitTranscriptionEvent({ type: "complete", text: "the new line helper", endOfSpeech: true });
    emitTranscriptionEvent({ type: "complete", text: "nothing to change", endOfSpeech: true });

    expect(
      activeSent
        .filter(
          (m) =>
            m.channel === "voice-input:transcription-complete" ||
            m.channel === "voice-input:paragraph-boundary"
        )
        .map((m) => [m.channel.split(":")[1], (m.payload as { text?: string }).text])
    ).toEqual([
      ["transcription-complete", "use Zustand"],
      ["paragraph-boundary", undefined],
      ["transcription-complete", "the NewLine helper"],
      ["transcription-complete", "nothing to change"],
    ]);
    const last = activeSent
      .filter((m) => m.channel === "voice-input:transcription-complete")
      .at(-1);
    expect(last?.payload).not.toHaveProperty("heard");
  });

  it("takes a trailing 'send it' before the rules, so a rule never eats the send", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValue({
      ...providerSettings("openai"),
      dictionary: [
        { term: "SendIt", heardAs: ["send it"], source: "manual", addedAt: 1 },
        { term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 2 },
      ],
    });

    await startFn(fakeEvent, nextSessionId());
    emitTranscriptionEvent({
      type: "complete",
      text: "use zoo stand, send it.",
      endOfSpeech: true,
    });
    emitTranscriptionEvent({ type: "complete", text: "the send it helper", endOfSpeech: true });

    expect(
      activeSent
        .filter((m) => m.channel === "voice-input:transcription-complete")
        .map((m) => m.payload)
    ).toEqual([
      {
        sessionId: currentSessionId,
        text: "use Zustand",
        willCorrect: false,
        heard: "use zoo stand",
        send: true,
      },
      {
        sessionId: currentSessionId,
        text: "the SendIt helper",
        willCorrect: false,
        heard: "the send it helper",
      },
    ]);
  });

  it("leaves a rewrite instruction's words as spoken", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValue({
      ...providerSettings("openai"),
      dictionary: [{ term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 1 }],
    });
    const handleStart = getHandler("voice-input:start") as (
      e: unknown,
      sessionId: string,
      options: unknown
    ) => Promise<unknown>;

    await handleStart(fakeEvent, nextSessionId(), { terminalId: "t1", intent: "rewrite" });
    emitTranscriptionEvent({ type: "complete", text: "say zoo stand instead", itemId: "i1" });

    expect(
      activeSent
        .filter((m) => m.channel === "voice-input:transcription-complete")
        .map((m) => m.payload)
    ).toEqual([
      {
        sessionId: currentSessionId,
        text: "say zoo stand instead",
        willCorrect: false,
        itemId: "i1",
      },
    ]);
  });

  it("keeps a code fence spanning lines intact and sends no heard text for it", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValue({
      ...providerSettings("openai"),
      dictionary: [{ term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 1 }],
    });

    await startFn(fakeEvent, nextSessionId());
    emitTranscriptionEvent({ type: "complete", text: "```\nzoo stand\n``` then zoo stand" });

    expect(
      activeSent
        .filter((m) => m.channel === "voice-input:transcription-complete")
        .map((m) => m.payload)
    ).toEqual([
      { sessionId: currentSessionId, text: "```", willCorrect: false },
      { sessionId: currentSessionId, text: "zoo stand", willCorrect: false },
      {
        sessionId: currentSessionId,
        text: "``` then Zustand",
        willCorrect: false,
        heard: "``` then zoo stand",
      },
    ]);
  });

  it("looks for file links in the text the draft gets", async () => {
    const { store } = await import("../../../store.js");
    const { projectStore } = await import("../../../services/ProjectStore.js");
    shared.fileLinkCalls = [];
    shared.viewProjectId = "project-1";
    vi.mocked(projectStore.getProjectById).mockReturnValueOnce({
      name: "app",
      path: "/repo/app",
    } as ReturnType<typeof projectStore.getProjectById>);
    vi.mocked(store.get).mockReturnValue({
      ...providerSettings("openai"),
      correctionEnabled: true,
      dictionary: [{ term: "Bar", heardAs: ["foo new line"], source: "manual", addedAt: 1 }],
    });

    try {
      await startFn(fakeEvent, nextSessionId());
      emitTranscriptionEvent({
        type: "complete",
        text: "link to the zoo foo new line",
        endOfSpeech: true,
      });
    } finally {
      shared.viewProjectId = null;
    }

    expect(shared.fileLinkCalls).toEqual(["link to the zoo foo\n"]);
  });

  it("bails a Deepgram start whose assembly throws after a stop", async () => {
    const { store } = await import("../../../store.js");
    const gate = deferred<string[]>();
    shared.assembleKeyterms = () => gate.promise;

    vi.mocked(store.get).mockReturnValue(providerSettings("deepgram"));
    const { assembleTaggedKeyterms } = await import("../../../services/voiceContextKeyterms.js");
    vi.mocked(assembleTaggedKeyterms).mockClear();
    const aPromise = startFn(fakeEvent, nextSessionId());
    await vi.waitFor(() => expect(assembleTaggedKeyterms).toHaveBeenCalled());

    // Stop supersedes the in-flight assembly.
    await stopFn(fakeEvent, currentSessionId);

    // Assembly then fails — the catch path must still honor the supersede.
    gate.reject(new Error("assembly boom"));
    await expect(aPromise).resolves.toEqual({ status: "superseded" });
    expect(shared.startCalls).toHaveLength(0);
  });

  it("does not persist runtime-only keyterms via setSettings", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.set).mockClear();

    await setSettingsFn(fakeEvent, { keyterms: ["secret"], language: "fr" });

    const setCalls = vi.mocked(store.set).mock.calls as unknown as Array<[string, unknown]>;
    expect(setCalls.some(([key]) => key === "voiceInput.keyterms")).toBe(false);
    expect(setCalls.some(([key]) => key === "voiceInput.language")).toBe(true);
  });

  it("bails a start superseded by a later start during assembly", async () => {
    const { store } = await import("../../../store.js");
    const gate = deferred<string[]>();
    // Only the FIRST assembly (start A) parks on the gate; the later start (B)
    // resolves immediately so it can supersede and proceed.
    let assembleCount = 0;
    shared.assembleKeyterms = () => {
      assembleCount += 1;
      return assembleCount === 1 ? gate.promise : Promise.resolve([]);
    };

    // Start A (Deepgram) — parks on assembly.
    vi.mocked(store.get).mockReturnValue(providerSettings("deepgram"));
    const aPromise = startFn(fakeEvent, nextSessionId());
    await vi.waitFor(() => expect(assembleCount).toBe(1));

    // Start B (OpenAI) — supersedes A and starts immediately.
    vi.mocked(store.get).mockReturnValue(providerSettings("openai"));
    await startFn(fakeEvent, nextSessionId());

    // A's assembly now resolves — but A must detect it was superseded and bail.
    gate.resolve(["alpha"]);
    await expect(aPromise).resolves.toEqual({ status: "superseded" });

    // Only B reached svc.start; A never did (no second session).
    expect(shared.startCalls).toHaveLength(1);
    expect(shared.startCalls[0]).toMatchObject({ transcriptionProvider: "openai" });
  });
});

describe("getVoiceSettings migration", () => {
  beforeEach(async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.set).mockReset();
    vi.mocked(store.get).mockReset();
  });

  it("migrates legacy correctionApiKey (sk-*) into openaiApiKey and persists cleanup", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      correctionApiKey: "sk-correction",
      language: "en",
      dictionary: [],
      transcriptionModel: "gpt-live-transcribe",
      correctionEnabled: false,
      correctionModel: "gpt-5-mini",
      correctionCustomInstructions: "",
      paragraphingStrategy: "spoken-command",
    });

    const settings = getVoiceSettings();

    expect(settings.openaiApiKey).toBe("sk-correction");
    expect(vi.mocked(store.set)).toHaveBeenCalledWith(
      "voiceInput",
      expect.objectContaining({ openaiApiKey: "sk-correction" })
    );
    // Persisted object should not retain legacy keys.
    const persisted = (
      vi.mocked(store.set).mock.calls[0] as unknown as [string, Record<string, unknown>]
    )[1];
    expect(persisted).not.toHaveProperty("correctionApiKey");
    expect(persisted).not.toHaveProperty("apiKey");
    // deepgramApiKey and transcriptionProvider are now first-class fields.
    expect(persisted).toHaveProperty("deepgramApiKey", "");
    expect(persisted).toHaveProperty("transcriptionProvider", "openai");
  });

  it("migrates first-generation apiKey (sk-*) into openaiApiKey", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      apiKey: "sk-original",
    });

    const settings = getVoiceSettings();

    expect(settings.openaiApiKey).toBe("sk-original");
    expect(vi.mocked(store.set)).toHaveBeenCalledOnce();
  });

  it("preserves a stored deepgramApiKey as a first-class field", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      deepgramApiKey: "dg-xxx",
    });

    const settings = getVoiceSettings();

    // deepgramApiKey now flows through; it does not bleed into openaiApiKey and
    // is no longer dropped on read.
    expect(settings.deepgramApiKey).toBe("dg-xxx");
    expect(settings.openaiApiKey).toBe("");
    // No legacy keys and a valid (defaulted) provider — nothing to persist.
    expect(vi.mocked(store.set)).not.toHaveBeenCalled();
  });

  it("defaults an unrecognized transcriptionProvider to openai and persists it", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      openaiApiKey: "sk-present",
      transcriptionProvider: "bogus-provider",
    });

    const settings = getVoiceSettings();

    expect(settings.transcriptionProvider).toBe("openai");
    expect(vi.mocked(store.set)).toHaveBeenCalledOnce();
  });

  it("keeps a stored deepgram provider choice without resetting it", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      deepgramApiKey: "dg-xxx",
      transcriptionProvider: "deepgram",
    });

    const settings = getVoiceSettings();

    expect(settings.transcriptionProvider).toBe("deepgram");
    // A valid stored provider with no legacy keys triggers no write.
    expect(vi.mocked(store.set)).not.toHaveBeenCalled();
  });

  it("moves a stored gpt-realtime-whisper forward and persists the upgrade", async () => {
    // migration027 handles stores below schema 27; this read-time net catches a
    // store already marked current but carrying the retired value (downgrade or
    // hand-edit). It must move FORWARD, never back to the old literal.
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      openaiApiKey: "sk-present",
      transcriptionModel: "gpt-realtime-whisper",
    });

    const settings = getVoiceSettings();

    expect(settings.transcriptionModel).toBe("gpt-live-transcribe");
    expect(vi.mocked(store.set)).toHaveBeenCalledWith(
      "voiceInput",
      expect.objectContaining({ transcriptionModel: "gpt-live-transcribe" })
    );
  });

  it("upgrades the model without disturbing a deepgram provider choice", async () => {
    // The provider — not the model — selects the backend. Normalizing the
    // single-valued model must never revert a real user choice (#9175).
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      deepgramApiKey: "dg-xxx",
      transcriptionProvider: "deepgram",
      transcriptionModel: "nova-3",
    });

    const settings = getVoiceSettings();

    expect(settings.transcriptionModel).toBe("gpt-live-transcribe");
    expect(settings.transcriptionProvider).toBe("deepgram");
    expect(settings.deepgramApiKey).toBe("dg-xxx");
    const persisted = (
      vi.mocked(store.set).mock.calls[0] as unknown as [string, Record<string, unknown>]
    )[1];
    expect(persisted).toHaveProperty("transcriptionProvider", "deepgram");
  });

  it("keeps a stored Grok choice and its key, and reads an XAI_API_KEY override without saving it", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get)
      .mockReturnValueOnce({
        enabled: true,
        xaiApiKey: "xai-stored",
        transcriptionProvider: "grok",
        transcriptionModel: "gpt-live-transcribe",
      })
      .mockReturnValueOnce({
        enabled: true,
        xaiApiKey: "xai-stored",
        transcriptionProvider: "grok",
      });

    const stored = getVoiceSettings();
    expect(stored.transcriptionProvider).toBe("grok");
    expect(stored.xaiApiKey).toBe("xai-stored");

    process.env.XAI_API_KEY = " xai-env ";
    try {
      expect(getVoiceSettings().xaiApiKey).toBe("xai-env");
    } finally {
      delete process.env.XAI_API_KEY;
    }
  });

  it("writes back the stored xAI key, never the override, when a read repairs the store", async () => {
    const { store } = await import("../../../store.js");
    const persisted: Array<Record<string, unknown>> = [];
    vi.mocked(store.set).mockImplementation(((_key: string, value: Record<string, unknown>) => {
      persisted.push(structuredClone(value));
    }) as unknown as typeof store.set);
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      xaiApiKey: "xai-stored",
      transcriptionProvider: "grok",
      transcriptionModel: "nova-3",
    });

    process.env.XAI_API_KEY = "xai-env";
    try {
      expect(getVoiceSettings().xaiApiKey).toBe("xai-env");
    } finally {
      delete process.env.XAI_API_KEY;
    }
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ xaiApiKey: "xai-stored", transcriptionProvider: "grok" });
  });

  it("does not rewrite the store when the model is already current", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      openaiApiKey: "sk-present",
      transcriptionModel: "gpt-live-transcribe",
    });

    const settings = getVoiceSettings();

    expect(settings.transcriptionModel).toBe("gpt-live-transcribe");
    expect(vi.mocked(store.set)).not.toHaveBeenCalled();
  });

  it("reads cleanup as on when the store never recorded a choice, and keeps a stored off", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get)
      .mockReturnValueOnce({ enabled: true, openaiApiKey: "sk-present" })
      .mockReturnValueOnce({ enabled: true, openaiApiKey: "sk-present", correctionEnabled: false });

    expect(getVoiceSettings().correctionEnabled).toBe(true);
    expect(getVoiceSettings().correctionEnabled).toBe(false);
  });

  it("does not overwrite an existing openaiApiKey when legacy fields are present", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      openaiApiKey: "sk-new",
      correctionApiKey: "sk-old",
    });

    const settings = getVoiceSettings();

    expect(settings.openaiApiKey).toBe("sk-new");
  });

  it("overrides stored openaiApiKey when WHISPER_API_KEY env var is set", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      openaiApiKey: "sk-stored",
    });

    process.env.WHISPER_API_KEY = "sk-env-override";
    try {
      const settings = getVoiceSettings();
      expect(settings.openaiApiKey).toBe("sk-env-override");
    } finally {
      delete process.env.WHISPER_API_KEY;
    }
  });

  it("env override is NOT persisted to store", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      openaiApiKey: "sk-stored",
    });

    process.env.WHISPER_API_KEY = "sk-env";
    try {
      getVoiceSettings();
      // The store.set call path only fires when legacy fields or stale model exist;
      // the env override itself must never call store.set.
      const setCalls = vi.mocked(store.set).mock.calls as unknown as Array<
        [string, Record<string, unknown>?]
      >;
      const envPersistCall = setCalls.some(([, value]) => value?.openaiApiKey === "sk-env");
      expect(envPersistCall).toBe(false);
    } finally {
      delete process.env.WHISPER_API_KEY;
    }
  });

  it("drops a stale persisted keyterms field on read", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      openaiApiKey: "sk-present",
      keyterms: ["leaked"],
    } as unknown as Record<string, unknown>);

    const settings = getVoiceSettings();

    expect(settings.keyterms).toBeUndefined();
  });

  it("preserves recordingMode='push-to-talk' when stored", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      openaiApiKey: "sk-present",
      recordingMode: "push-to-talk",
    });

    const settings = getVoiceSettings();

    expect(settings.recordingMode).toBe("push-to-talk");
  });

  it("preserves recordingMode='toggle' when stored", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      openaiApiKey: "sk-present",
      recordingMode: "toggle",
    });

    expect(getVoiceSettings().recordingMode).toBe("toggle");
  });

  it("normalizes malformed recordingMode values to 'tap-or-hold' without writing to disk", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      openaiApiKey: "sk-present",
      recordingMode: "hold" as unknown,
    });

    const settings = getVoiceSettings();

    expect(settings.recordingMode).toBe("tap-or-hold");
    // Normalization must not persist back to the store.
    expect(vi.mocked(store.set)).not.toHaveBeenCalled();
  });

  it("skips env override when WHISPER_API_KEY is empty string", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      openaiApiKey: "sk-stored",
    });

    process.env.WHISPER_API_KEY = "";
    try {
      const settings = getVoiceSettings();
      expect(settings.openaiApiKey).toBe("sk-stored");
    } finally {
      delete process.env.WHISPER_API_KEY;
    }
  });

  it.each(["gpt-5-mini", "gpt-5.6-luna", 42])(
    "normalizes a stale correctionModel (%s) to gpt-6.1-terra and persists the cleanup",
    async (stale) => {
      const { store } = await import("../../../store.js");
      vi.mocked(store.get).mockReturnValueOnce({
        enabled: true,
        openaiApiKey: "sk-present",
        correctionModel: stale,
      });

      const settings = getVoiceSettings();

      expect(settings.correctionModel).toBe("gpt-6.1-terra");
      // The read-time safety net writes the cleaned value through once so the
      // stale model does not survive on disk (issue #11365).
      expect(vi.mocked(store.set)).toHaveBeenCalledOnce();
      const persisted = (
        vi.mocked(store.set).mock.calls[0] as unknown as [string, Record<string, unknown>]
      )[1];
      expect(persisted.correctionModel).toBe("gpt-6.1-terra");
      // Normalization must write the full merged object, not a defaults-only one —
      // sibling settings must survive the cleanup write.
      expect(persisted.enabled).toBe(true);
      expect(persisted.openaiApiKey).toBe("sk-present");
    }
  );

  it.each(["gpt-6.1-terra", "gpt-6-luna"])(
    "keeps a chosen cleanup model (%s) without writing back",
    async (chosen) => {
      const { store } = await import("../../../store.js");
      vi.mocked(store.get).mockReturnValueOnce({
        enabled: true,
        openaiApiKey: "sk-present",
        correctionModel: chosen,
      });

      const settings = getVoiceSettings();

      expect(settings.correctionModel).toBe(chosen);
      expect(vi.mocked(store.set)).not.toHaveBeenCalled();
    }
  );
});

describe("validateOpenAIKey", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns invalid for empty key", async () => {
    const result = await validateOpenAIKey("");
    expect(result).toEqual({ valid: false, error: "API key is required" });
  });

  it("returns valid for a 200 OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );

    const result = await validateOpenAIKey("sk-valid");
    expect(result).toEqual({ valid: true });
  });

  it("returns invalid for 401 with JSON body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "Incorrect API key provided", code: null } }),
        { status: 401, headers: { "content-type": "application/json" } }
      )
    );

    const result = await validateOpenAIKey("sk-bad");
    expect(result).toEqual({ valid: false, error: "Incorrect API key provided" });
  });

  it("falls back to default message for 401 with HTML body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<html>Unauthorized</html>", {
        status: 401,
        headers: { "content-type": "text/html" },
      })
    );

    const result = await validateOpenAIKey("sk-bad");
    expect(result).toEqual({ valid: false, error: "Invalid API key" });
  });

  it("returns invalid for 429 insufficient_quota", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: "You exceeded your current quota, please check your plan and billing details.",
            type: "insufficient_quota",
            code: "insufficient_quota",
          },
        }),
        { status: 429, headers: { "content-type": "application/json" } }
      )
    );

    const result = await validateOpenAIKey("sk-no-credits");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("no credits");
  });

  it("returns valid for 429 rate_limit_exceeded", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: "Rate limit reached for requests",
            type: "tokens",
            code: "rate_limit_exceeded",
          },
        }),
        { status: 429, headers: { "content-type": "application/json" } }
      )
    );

    const result = await validateOpenAIKey("sk-ratelimited");
    expect(result).toEqual({ valid: true });
  });

  it("returns invalid for 403 unsupported_country_region_territory", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: "Country, region, or territory not supported",
            type: "request_forbidden",
            code: "unsupported_country_region_territory",
          },
        }),
        { status: 403, headers: { "content-type": "application/json" } }
      )
    );

    const result = await validateOpenAIKey("sk-blocked-region");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("region");
  });

  it("returns invalid for 403 with JSON body and unknown code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "Access denied by policy", code: "policy_violation" } }),
        { status: 403, headers: { "content-type": "application/json" } }
      )
    );

    const result = await validateOpenAIKey("sk-policy");
    expect(result).toEqual({ valid: false, error: "Access denied by policy" });
  });

  it("surfaces server error message for 500", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "The server had an error processing your request" } }),
        { status: 500, headers: { "content-type": "application/json" } }
      )
    );

    const result = await validateOpenAIKey("sk-500");
    expect(result).toEqual({
      valid: false,
      error: "The server had an error processing your request",
    });
  });

  it("falls back to status text for 500 with HTML body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<html>Server Error</html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      })
    );

    const result = await validateOpenAIKey("sk-500-html");
    expect(result).toEqual({ valid: false, error: "API returned status 500" });
  });

  it("returns timeout error on AbortError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      Object.defineProperty(new Error("Timeout"), "name", { value: "AbortError" })
    );

    const result = await validateOpenAIKey("sk-timeout");
    expect(result).toEqual({ valid: false, error: "Connection timed out" });
  });

  it("returns connection error on generic fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ENOTFOUND"));

    const result = await validateOpenAIKey("sk-no-net");
    expect(result).toEqual({ valid: false, error: "Failed to connect to OpenAI" });
  });
});

describe("voiceInput — spoken commands outside English", () => {
  it.each(["auto", "es"])(
    "leaves 'new paragraph' literal when language is %s",
    async (language) => {
      vi.clearAllMocks();
      shared.transcriptionEventCallback = null;
      shared.drainResolve = null;
      shared.useDeferredDrain = false;
      const { store } = await import("../../../store.js");
      vi.mocked(store.get).mockReturnValue({
        enabled: true,
        openaiApiKey: "sk-test",
        correctionEnabled: false,
        correctionModel: "gpt-6.1-terra",
        dictionary: [],
        correctionCustomInstructions: "",
        language,
        transcriptionModel: "gpt-live-transcribe",
        paragraphingStrategy: "spoken-command",
        resolveFileLinks: true,
      });

      const win = buildMainWindow();
      const cleanup = registerVoiceInputHandlers({
        mainWindow: win as unknown as Electron.BrowserWindow,
      } as Parameters<typeof registerVoiceInputHandlers>[0]);
      try {
        await (getHandler("voice-input:start") as SessionHandler)(fakeEvent, nextSessionId());
        emitTranscriptionEvent({ type: "complete", text: "hello new paragraph" });

        const completes = win.__sent.filter(
          (m) => m.channel === "voice-input:transcription-complete"
        );
        expect(completes).toHaveLength(1);
        expect(completes[0]?.payload).toMatchObject({ text: "hello new paragraph" });
      } finally {
        cleanup();
        vi.mocked(store.get).mockReset();
      }
    }
  );
});

describe("voiceInput — rewrite instructions", () => {
  let win: ReturnType<typeof buildMainWindow>;
  let cleanup: () => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    shared.transcriptionEventCallback = null;
    shared.drainResolve = null;
    shared.useDeferredDrain = false;
    shared.rewriteCalls = [];

    win = buildMainWindow();
    cleanup = registerVoiceInputHandlers({
      mainWindow: win as unknown as Electron.BrowserWindow,
    } as Parameters<typeof registerVoiceInputHandlers>[0]);
  });

  afterEach(() => {
    cleanup?.();
  });

  const forwarded = () =>
    win.__sent.filter(
      (m) =>
        m.channel === "voice-input:transcription-complete" ||
        m.channel === "voice-input:paragraph-boundary"
    );

  it("forwards nothing for a bare end of speech, which names no item", async () => {
    const handleStart = getHandler("voice-input:start") as (
      e: unknown,
      sessionId: string,
      options: unknown
    ) => Promise<unknown>;
    await handleStart(fakeEvent, nextSessionId(), { terminalId: "t1", intent: "rewrite" });

    emitTranscriptionEvent({ type: "complete", text: "Make it shorter", itemId: "item-A" });
    emitTranscriptionEvent({ type: "complete", text: "", endOfSpeech: true });

    expect(forwarded().map((m) => (m.payload as { text: string }).text)).toEqual([
      "Make it shorter",
    ]);
  });

  it("forwards an instruction as spoken: no formatting commands, splits or boundaries", async () => {
    const handleStart = getHandler("voice-input:start") as (
      e: unknown,
      sessionId: string,
      options: unknown
    ) => Promise<unknown>;
    await handleStart(fakeEvent, nextSessionId(), { terminalId: "t1", intent: "rewrite" });

    emitTranscriptionEvent({
      type: "complete",
      text: " put each step on a new line ",
      itemId: "i1",
    });
    emitTranscriptionEvent({ type: "paragraph_boundary" });

    expect(forwarded()).toEqual([
      {
        channel: "voice-input:transcription-complete",
        payload: {
          sessionId: currentSessionId,
          text: "put each step on a new line",
          willCorrect: false,
          itemId: "i1",
        },
      },
    ]);
  });

  it("keeps a trailing 'send it' in the instruction and never flags a send", async () => {
    const handleStart = getHandler("voice-input:start") as (
      e: unknown,
      sessionId: string,
      options: unknown
    ) => Promise<unknown>;
    await handleStart(fakeEvent, nextSessionId(), { terminalId: "t1", intent: "rewrite" });

    emitTranscriptionEvent({
      type: "complete",
      text: "make it shorter and send it.",
      itemId: "i1",
      endOfSpeech: true,
    });

    expect(forwarded()).toEqual([
      {
        channel: "voice-input:transcription-complete",
        payload: {
          sessionId: currentSessionId,
          text: "make it shorter and send it.",
          willCorrect: false,
          itemId: "i1",
        },
      },
    ]);
  });

  it("still applies formatting commands to a dictation session", async () => {
    const handleStart = getHandler("voice-input:start") as (
      e: unknown,
      sessionId: string,
      options: unknown
    ) => Promise<unknown>;
    await handleStart(fakeEvent, nextSessionId(), { terminalId: "t1", intent: "dictation" });

    emitTranscriptionEvent({ type: "complete", text: "fix the bug new line", endOfSpeech: true });

    expect(forwarded().map((m) => m.channel)).toEqual([
      "voice-input:transcription-complete",
      "voice-input:paragraph-boundary",
    ]);
  });

  it("rewrite keeps the asking view until its answer is back (#14773)", async () => {
    const handleRewrite = getHandler("voice-input:rewrite") as (
      e: unknown,
      request: unknown
    ) => Promise<unknown>;
    const view = fakeEvent.sender as unknown as Electron.WebContents;
    let answer!: () => void;
    shared.cleanupGate = new Promise<void>((resolve) => {
      answer = resolve;
    });

    vi.useFakeTimers();
    try {
      const pending = handleRewrite(fakeEvent, {
        selectedText: "a long sentence",
        instruction: "make it shorter",
      });
      await Promise.resolve();
      expect(isDictationViewHeld(view)).toBe(true);

      answer();
      await pending;
      expect(isDictationViewHeld(view)).toBe(true);
      vi.advanceTimersByTime(5_000);
      expect(isDictationViewHeld(view)).toBe(false);
    } finally {
      shared.cleanupGate = null;
      vi.useRealTimers();
    }
  });

  it("sends cleanup and spoken rewrite to the model the user chose", async () => {
    const { store } = await import("../../../store.js");
    const stored = vi.mocked(store.get).getMockImplementation()!;
    vi.mocked(store.get).mockImplementation((key: string) =>
      key === "voiceInput"
        ? { ...(stored(key) as Record<string, unknown>), correctionModel: "gpt-6-luna" }
        : stored(key)
    );
    try {
      const handleCorrect = getHandler("voice-input:correct") as (
        e: unknown,
        request: unknown
      ) => Promise<unknown>;
      const handleRewrite = getHandler("voice-input:rewrite") as (
        e: unknown,
        request: unknown
      ) => Promise<unknown>;

      await handleCorrect(fakeEvent, { rawText: "helo world" });
      await handleRewrite(fakeEvent, { selectedText: "a long sentence", instruction: "shorter" });

      expect(shared.correctionCalls.at(-1)?.settings).toMatchObject({ model: "gpt-6-luna" });
      expect(shared.rewriteCalls.at(-1)?.settings).toMatchObject({ model: "gpt-6-luna" });
    } finally {
      vi.mocked(store.get).mockImplementation(stored);
    }
  });

  it("rewrite validates the payload and hands it to the correction model", async () => {
    const handleRewrite = getHandler("voice-input:rewrite") as (
      e: unknown,
      request: unknown
    ) => Promise<unknown>;

    const outcome = await handleRewrite(fakeEvent, {
      selectedText: "a long sentence",
      instruction: "make it shorter",
    });

    expect(outcome).toEqual({ status: "replace", text: "Shorter." });
    expect(shared.rewriteCalls).toHaveLength(1);
    expect(shared.rewriteCalls[0]?.request).toEqual({
      selectedText: "a long sentence",
      instruction: "make it shorter",
    });
    expect(shared.rewriteCalls[0]?.settings).toMatchObject({
      model: "gpt-6.1-terra",
      apiKey: "sk-test",
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        handleRewrite(fakeEvent, { selectedText: "", instruction: "x" })
      ).rejects.toBeInstanceOf(ValidationError);
    } finally {
      consoleError.mockRestore();
    }
    expect(shared.rewriteCalls).toHaveLength(1);
  });
});
