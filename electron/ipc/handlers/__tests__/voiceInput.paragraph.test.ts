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
  text?: string;
  status?: string;
  message?: string;
  confidence?: {
    minConfidence: number;
    wordCount: number;
    uncertainWords: string[];
    words: Array<{ word: string; confidence: number }>;
  };
};

const shared = vi.hoisted(() => ({
  transcriptionEventCallback: null as ((e: MockTranscriptionEvent) => void) | null,
  correctionWordResult: "Zustand",
  correctionWordCalls: [] as Array<{
    request: Record<string, unknown>;
    settings: Record<string, unknown>;
  }>,
  /** Simulated in-flight utterance text returned by commitParagraphBoundary(). */
  inFlightText: "" as string,
  /** Deferred drain promise — resolve externally to control stopGracefully() timing. */
  drainResolve: null as (() => void) | null,
  /** When true, stopGracefully uses a deferred promise instead of resolving immediately. */
  useDeferredDrain: false,
}));

vi.mock("../../../services/VoiceTranscriptionService.js", () => ({
  VoiceTranscriptionService: function VoiceTranscriptionService(this: Record<string, unknown>) {
    this.onEvent = function (cb: (e: MockTranscriptionEvent) => void) {
      shared.transcriptionEventCallback = cb;
      return () => {};
    };
    this.start = function () {
      return Promise.resolve({ ok: true });
    };
    this.stopGracefully = function () {
      if (shared.useDeferredDrain) {
        return new Promise<void>((resolve) => {
          shared.drainResolve = resolve;
        });
      }
      return Promise.resolve();
    };
    this.sendAudioChunk = function () {};
    this.destroy = function () {};
    this.commitParagraphBoundary = function () {
      const text = shared.inFlightText ?? "";
      return {
        text,
        confidence: text
          ? { minConfidence: 0, wordCount: 0, uncertainWords: [], words: [] }
          : { minConfidence: 1.0, wordCount: 0, uncertainWords: [], words: [] },
      };
    };
  },
}));

vi.mock("../../../services/VoiceCorrectionService.js", () => ({
  VoiceCorrectionService: function VoiceCorrectionService(this: Record<string, unknown>) {
    this.correctWord = function (
      request: Record<string, unknown>,
      settings: Record<string, unknown>
    ) {
      shared.correctionWordCalls.push({ request, settings });
      return Promise.resolve({
        action: "replace",
        correctedText: shared.correctionWordResult,
        confidence: "high",
        confirmedText: shared.correctionWordResult,
      });
    };
    this.correct = function () {
      return Promise.resolve({
        action: "no_change",
        correctedText: "",
        confidence: "high",
        confirmedText: "",
      });
    };
  },
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProject: vi.fn(() => null),
    getCurrentProjectId: vi.fn(() => null),
  },
}));

vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn((key: string) => {
      if (key === "voiceInput") {
        return {
          enabled: true,
          deepgramApiKey: "dg-test-key",
          correctionApiKey: "sk-test",
          correctionEnabled: true,
          correctionModel: "gpt-5-mini",
          customDictionary: [],
          correctionCustomInstructions: "",
          language: "en",
          transcriptionModel: "nova-3",
          paragraphingStrategy: "spoken-command",
        };
      }
      return undefined;
    }),
    set: vi.fn(),
  },
}));

vi.mock("../../../services/voiceContextKeyterms.js", () => ({
  assembleKeyterms: vi.fn(({ customDictionary }: { customDictionary: string[] }) =>
    Promise.resolve(customDictionary)
  ),
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
    VOICE_INPUT_CORRECTION_QUEUED: "voice-input:correction-queued",
    VOICE_INPUT_CORRECTION_REPLACE: "voice-input:correction-replace",
    VOICE_INPUT_ERROR: "voice-input:error",
    VOICE_INPUT_STATUS: "voice-input:status",
    VOICE_INPUT_CHECK_MIC_PERMISSION: "voice-input:check-mic-permission",
    VOICE_INPUT_REQUEST_MIC_PERMISSION: "voice-input:request-mic-permission",
    VOICE_INPUT_OPEN_MIC_SETTINGS: "voice-input:open-mic-settings",
    VOICE_INPUT_VALIDATE_API_KEY: "voice-input:validate-api-key",
    VOICE_INPUT_VALIDATE_CORRECTION_API_KEY: "voice-input:validate-correction-api-key",
    VOICE_INPUT_FLUSH_PARAGRAPH: "voice-input:flush-paragraph",
    VOICE_INPUT_PARAGRAPH_BOUNDARY: "voice-input:paragraph-boundary",
  },
}));

// ── Module import (once) ───────────────────────────────────────────────────
import { registerVoiceInputHandlers } from "../voiceInput.js";

// ── Helpers ────────────────────────────────────────────────────────────────

type SentMessage = { channel: string; payload: unknown };

function buildMainWindow(): {
  webContents: { send: ReturnType<typeof vi.fn> };
  isDestroyed: ReturnType<typeof vi.fn>;
  __sent: SentMessage[];
} {
  const sentMessages: SentMessage[] = [];
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
  sender: { once: vi.fn(), removeListener: vi.fn(), isDestroyed: () => false },
} as unknown as Electron.IpcMainInvokeEvent;

function emitTranscriptionEvent(event: MockTranscriptionEvent) {
  if (!shared.transcriptionEventCallback) {
    throw new Error("No transcription event callback registered — was handleStart called?");
  }
  shared.transcriptionEventCallback(event);
}

function makeHighConfidenceWords(text: string): Array<{ word: string; confidence: number }> {
  return text.split(/\s+/).map((w) => ({ word: w, confidence: 0.95 }));
}

function makeLowConfidenceWords(
  uncertain: string[],
  context: string[] = []
): Array<{ word: string; confidence: number }> {
  return [
    ...uncertain.map((w) => ({ word: w, confidence: 0.6 })),
    ...context.map((w) => ({ word: w, confidence: 0.95 })),
  ];
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("voiceInput — streaming word-level correction", () => {
  let win: ReturnType<typeof buildMainWindow>;
  let cleanup: () => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    shared.transcriptionEventCallback = null;
    shared.correctionWordCalls = [];
    shared.correctionWordResult = "Zustand";
    shared.inFlightText = "";
    shared.drainResolve = null;
    shared.useDeferredDrain = false;

    win = buildMainWindow();
    cleanup = registerVoiceInputHandlers({
      mainWindow: win as unknown as Electron.BrowserWindow,
    } as Parameters<typeof registerVoiceInputHandlers>[0]);

    // Start a session so the buffer is initialized.
    const handleStart = getHandler("voice-input:start");
    await (handleStart as (e: unknown) => Promise<unknown>)(fakeEvent);
  });

  afterEach(() => {
    cleanup?.();
  });

  it("does not fire correction for high-confidence words", () => {
    emitTranscriptionEvent({
      type: "complete",
      text: "Hello world",
      confidence: {
        minConfidence: 0.95,
        wordCount: 2,
        uncertainWords: [],
        words: makeHighConfidenceWords("Hello world"),
      },
    });

    expect(shared.correctionWordCalls).toHaveLength(0);
    const queuedMsg = win.__sent.find((m) => m.channel === "voice-input:correction-queued");
    expect(queuedMsg).toBeUndefined();
  });

  it("fires micro-correction when low-confidence words have enough right-context", () => {
    // Segment 1: low-confidence words
    emitTranscriptionEvent({
      type: "complete",
      text: "zoo stand",
      confidence: {
        minConfidence: 0.6,
        wordCount: 2,
        uncertainWords: ["zoo", "stand"],
        words: makeLowConfidenceWords(["zoo", "stand"]),
      },
    });

    // No correction yet — need right-context
    expect(shared.correctionWordCalls).toHaveLength(0);

    // Segment 2: provides right-context (3+ high-confidence words)
    emitTranscriptionEvent({
      type: "complete",
      text: "is a great library",
      confidence: {
        minConfidence: 0.95,
        wordCount: 4,
        uncertainWords: [],
        words: makeHighConfidenceWords("is a great library"),
      },
    });

    // Now correction should have been fired
    const queuedMsgs = win.__sent.filter((m) => m.channel === "voice-input:correction-queued");
    expect(queuedMsgs.length).toBeGreaterThanOrEqual(1);
    expect(shared.correctionWordCalls).toHaveLength(1);
    expect(shared.correctionWordCalls[0].request.rawSpan).toBe("zoo stand");
    expect(shared.correctionWordCalls[0].request.uncertainWords).toEqual(["zoo", "stand"]);
  });

  it("stop returns null rawText and null correctionId (no batch correction)", async () => {
    emitTranscriptionEvent({
      type: "complete",
      text: "Hello world",
      confidence: {
        minConfidence: 0.95,
        wordCount: 2,
        uncertainWords: [],
        words: makeHighConfidenceWords("Hello world"),
      },
    });

    const handleStop = getHandler("voice-input:stop");
    const result = (await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent)) as {
      rawText: string | null;
      correctionId: string | null;
    };

    expect(result.rawText).toBeNull();
    expect(result.correctionId).toBeNull();
  });

  it("stop flushes remaining clusters without enough right-context", async () => {
    // Low-confidence segment with no right-context
    emitTranscriptionEvent({
      type: "complete",
      text: "zoo stand",
      confidence: {
        minConfidence: 0.6,
        wordCount: 2,
        uncertainWords: ["zoo", "stand"],
        words: makeLowConfidenceWords(["zoo", "stand"]),
      },
    });

    expect(shared.correctionWordCalls).toHaveLength(0);

    const handleStop = getHandler("voice-input:stop");
    await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent);

    // Stop should flush the pending cluster
    await vi.waitFor(() => {
      expect(shared.correctionWordCalls).toHaveLength(1);
    });
  });

  it("sends CORRECTION_REPLACE after micro-correction resolves", async () => {
    shared.correctionWordResult = "Zustand";

    emitTranscriptionEvent({
      type: "complete",
      text: "zoo stand",
      confidence: {
        minConfidence: 0.6,
        wordCount: 2,
        uncertainWords: ["zoo", "stand"],
        words: makeLowConfidenceWords(["zoo", "stand"]),
      },
    });

    emitTranscriptionEvent({
      type: "complete",
      text: "is a great library",
      confidence: {
        minConfidence: 0.95,
        wordCount: 4,
        uncertainWords: [],
        words: makeHighConfidenceWords("is a great library"),
      },
    });

    await vi.waitFor(() => {
      const replaceMsg = win.__sent.find((m) => m.channel === "voice-input:correction-replace");
      expect(replaceMsg).toBeDefined();
      expect((replaceMsg?.payload as { correctedText: string }).correctedText).toBe("Zustand");
    });
  });

  it("flushParagraph returns null — no batch correction", () => {
    emitTranscriptionEvent({
      type: "complete",
      text: "Hello world",
      confidence: {
        minConfidence: 0.95,
        wordCount: 2,
        uncertainWords: [],
        words: makeHighConfidenceWords("Hello world"),
      },
    });

    const handleFlush = getHandler("voice-input:flush-paragraph");
    const result = handleFlush(fakeEvent) as {
      rawText: string | null;
      correctionId: string | null;
    };
    expect(result.rawText).toBeNull();
    expect(result.correctionId).toBeNull();
  });

  it("paragraph_boundary event does not trigger correction", () => {
    emitTranscriptionEvent({
      type: "complete",
      text: "first utterance",
      confidence: {
        minConfidence: 0.95,
        wordCount: 2,
        uncertainWords: [],
        words: makeHighConfidenceWords("first utterance"),
      },
    });

    emitTranscriptionEvent({ type: "paragraph_boundary" });

    const boundaryMsg = win.__sent.find((m) => m.channel === "voice-input:paragraph-boundary");
    expect(boundaryMsg).toBeDefined();
    const payload = boundaryMsg?.payload as { rawText: string | null; correctionId: string | null };
    expect(payload.rawText).toBeNull();
    expect(payload.correctionId).toBeNull();
  });

  it("status events are forwarded to the renderer unchanged", () => {
    for (const status of ["connecting", "recording", "finishing", "idle", "error"] as const) {
      emitTranscriptionEvent({ type: "status", status });
    }

    const statusMsgs = win.__sent.filter((m) => m.channel === "voice-input:status");
    const statuses = statusMsgs.map((m) => m.payload as string);
    expect(statuses).toEqual(["connecting", "recording", "finishing", "idle", "error"]);
  });

  it("session start resets buffer — no stale clusters from previous session", async () => {
    emitTranscriptionEvent({
      type: "complete",
      text: "zoo stand",
      confidence: {
        minConfidence: 0.6,
        wordCount: 2,
        uncertainWords: ["zoo", "stand"],
        words: makeLowConfidenceWords(["zoo", "stand"]),
      },
    });

    // Start a new session
    const handleStart = getHandler("voice-input:start");
    await (handleStart as (e: unknown) => Promise<unknown>)(fakeEvent);

    // Stop immediately — the stale cluster should NOT be flushed
    const handleStop = getHandler("voice-input:stop");
    await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent);

    expect(shared.correctionWordCalls).toHaveLength(0);
  });

  it("complete event with no confidence words does not trigger correction", () => {
    emitTranscriptionEvent({
      type: "complete",
      text: "Hello world",
    });

    expect(shared.correctionWordCalls).toHaveLength(0);
  });

  it("does not fire correction when correction is disabled", async () => {
    const { store } = await import("../../../store.js");
    const disabledSettings = {
      enabled: true,
      deepgramApiKey: "dg-test-key",
      correctionApiKey: "",
      correctionEnabled: false,
      correctionModel: "gpt-5-mini",
      customDictionary: [],
      correctionCustomInstructions: "",
      language: "en",
      transcriptionModel: "nova-3",
      paragraphingStrategy: "spoken-command",
    };
    // Use mockReturnValueOnce for each call to store.get during this test.
    // getVoiceSettings() is called once per complete event.
    vi.mocked(store.get)
      .mockReturnValueOnce(disabledSettings)
      .mockReturnValueOnce(disabledSettings);

    emitTranscriptionEvent({
      type: "complete",
      text: "zoo stand",
      confidence: {
        minConfidence: 0.6,
        wordCount: 2,
        uncertainWords: ["zoo", "stand"],
        words: makeLowConfidenceWords(["zoo", "stand"]),
      },
    });

    emitTranscriptionEvent({
      type: "complete",
      text: "is a great library",
      confidence: {
        minConfidence: 0.95,
        wordCount: 4,
        uncertainWords: [],
        words: makeHighConfidenceWords("is a great library"),
      },
    });

    expect(shared.correctionWordCalls).toHaveLength(0);
  });

  it("session start with active project captures project info into correction settings", async () => {
    const { projectStore } = await import("../../../services/ProjectStore.js");
    vi.mocked(projectStore.getCurrentProject).mockReturnValueOnce({
      id: "abc123",
      name: "My Project",
      path: "/Users/foo/my-project",
      emoji: "🌲",
      lastOpened: Date.now(),
    });

    // Re-start the session so sessionProjectInfo is re-captured with the mocked project
    const handleStart = getHandler("voice-input:start");
    await (handleStart as (e: unknown) => Promise<unknown>)(fakeEvent);

    // Fire a low-confidence segment + right-context to trigger a micro-correction
    emitTranscriptionEvent({
      type: "complete",
      text: "zoo stand",
      confidence: {
        minConfidence: 0.6,
        wordCount: 2,
        uncertainWords: ["zoo", "stand"],
        words: makeLowConfidenceWords(["zoo", "stand"]),
      },
    });

    emitTranscriptionEvent({
      type: "complete",
      text: "is a great library",
      confidence: {
        minConfidence: 0.95,
        wordCount: 4,
        uncertainWords: [],
        words: makeHighConfidenceWords("is a great library"),
      },
    });

    await vi.waitFor(() => {
      expect(shared.correctionWordCalls).toHaveLength(1);
      expect(shared.correctionWordCalls[0].settings.projectName).toBe("My Project");
      expect(shared.correctionWordCalls[0].settings.projectPath).toBe("/Users/foo/my-project");
    });
  });

  it("groups adjacent low-confidence words into a single micro-correction", () => {
    // Both "zoo" and "stand" are adjacent low-confidence words
    emitTranscriptionEvent({
      type: "complete",
      text: "zoo stand is great",
      confidence: {
        minConfidence: 0.6,
        wordCount: 4,
        uncertainWords: ["zoo", "stand"],
        words: [
          { word: "zoo", confidence: 0.6 },
          { word: "stand", confidence: 0.65 },
          { word: "is", confidence: 0.95 },
          { word: "great", confidence: 0.98 },
        ],
      },
    });

    // Need one more word for right-context
    emitTranscriptionEvent({
      type: "complete",
      text: "library",
      confidence: {
        minConfidence: 0.95,
        wordCount: 1,
        uncertainWords: [],
        words: [{ word: "library", confidence: 0.95 }],
      },
    });

    // Should be exactly 1 correction call for the grouped cluster
    expect(shared.correctionWordCalls).toHaveLength(1);
    expect(shared.correctionWordCalls[0].request.rawSpan).toBe("zoo stand");
  });

  it("includes left and right context in the micro-correction request", () => {
    // First segment: high-confidence context
    emitTranscriptionEvent({
      type: "complete",
      text: "I love",
      confidence: {
        minConfidence: 0.95,
        wordCount: 2,
        uncertainWords: [],
        words: makeHighConfidenceWords("I love"),
      },
    });

    // Second segment: low-confidence word
    emitTranscriptionEvent({
      type: "complete",
      text: "racked",
      confidence: {
        minConfidence: 0.65,
        wordCount: 1,
        uncertainWords: ["racked"],
        words: [{ word: "racked", confidence: 0.65 }],
      },
    });

    // Third segment: right-context
    emitTranscriptionEvent({
      type: "complete",
      text: "is a great framework",
      confidence: {
        minConfidence: 0.95,
        wordCount: 4,
        uncertainWords: [],
        words: makeHighConfidenceWords("is a great framework"),
      },
    });

    expect(shared.correctionWordCalls).toHaveLength(1);
    expect(shared.correctionWordCalls[0].request.leftContext).toBe("I love");
    expect(shared.correctionWordCalls[0].request.rawSpan).toBe("racked");
    expect(shared.correctionWordCalls[0].request.rightContext).toBe("is a great");
  });
});
