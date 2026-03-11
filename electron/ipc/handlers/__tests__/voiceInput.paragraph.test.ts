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
}));

// ── Shared state container for mocks ───────────────────────────────────────
// Using a mutable shared ref so module resets don't break the reference.
type MockTranscriptionEvent = { type: string; text?: string; status?: string; message?: string };

const shared = vi.hoisted(() => ({
  transcriptionEventCallback: null as ((e: MockTranscriptionEvent) => void) | null,
  correctionResult: "Corrected paragraph.",
  correctionCalls: [] as Array<{
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
          ? { minConfidence: 0, wordCount: 0, uncertainWords: [] }
          : { minConfidence: 1.0, wordCount: 0, uncertainWords: [] },
      };
    };
  },
}));

vi.mock("../../../services/VoiceCorrectionService.js", () => ({
  VoiceCorrectionService: function VoiceCorrectionService(this: Record<string, unknown>) {
    this.correct = function (request: Record<string, unknown>, settings: Record<string, unknown>) {
      shared.correctionCalls.push({ request, settings });
      return Promise.resolve({
        action: "replace",
        correctedText: shared.correctionResult,
        confidence: "high",
        confirmedText: shared.correctionResult,
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
// Import after mocks are registered. No vi.resetModules() — handleStart
// resets paragraphBuffer itself, so module-level state is sufficient.
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe("voiceInput — paragraph buffering", () => {
  let win: ReturnType<typeof buildMainWindow>;
  let cleanup: () => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    shared.transcriptionEventCallback = null;
    shared.correctionCalls = [];
    shared.correctionResult = "Corrected paragraph.";
    shared.inFlightText = "";
    shared.drainResolve = null;
    shared.useDeferredDrain = false;

    win = buildMainWindow();
    cleanup = registerVoiceInputHandlers({
      mainWindow: win as unknown as Electron.BrowserWindow,
    } as Parameters<typeof registerVoiceInputHandlers>[0]);

    // Start a session so the paragraph buffer is initialized.
    const handleStart = getHandler("voice-input:start");
    await (handleStart as (e: unknown) => Promise<unknown>)(fakeEvent);
  });

  afterEach(() => {
    cleanup?.();
  });

  it("flushParagraph returns null when no utterances have been received", () => {
    const handleFlush = getHandler("voice-input:flush-paragraph");
    const result = handleFlush(fakeEvent) as { rawText: string | null };
    expect(result.rawText).toBeNull();
  });

  it("complete events accumulate utterances without triggering per-utterance correction", () => {
    emitTranscriptionEvent({ type: "complete", text: "Hello world" });
    emitTranscriptionEvent({ type: "complete", text: "How are you" });

    // Correction should NOT have been triggered yet
    expect(shared.correctionCalls).toHaveLength(0);

    // TRANSCRIPTION_COMPLETE events sent to renderer with willCorrect: false
    const completeMsgs = win.__sent.filter(
      (m) => m.channel === "voice-input:transcription-complete"
    );
    expect(completeMsgs).toHaveLength(2);
    for (const msg of completeMsgs) {
      expect((msg.payload as { willCorrect: boolean }).willCorrect).toBe(false);
    }
  });

  it("does not queue correction during ongoing dictation", () => {
    emitTranscriptionEvent({ type: "complete", text: "First sentence" });
    emitTranscriptionEvent({ type: "complete", text: "Second sentence" });
    emitTranscriptionEvent({ type: "complete", text: "Third sentence" });

    const queuedMsg = win.__sent.find((m) => m.channel === "voice-input:correction-queued");
    expect(queuedMsg).toBeUndefined();
  });

  it("flushParagraph records a paragraph break but does not trigger correction", async () => {
    emitTranscriptionEvent({ type: "complete", text: "react is great" });
    emitTranscriptionEvent({ type: "complete", text: "use it everywhere" });

    const handleFlush = getHandler("voice-input:flush-paragraph");
    const result = handleFlush(fakeEvent) as {
      rawText: string | null;
      correctionId: string | null;
    };
    expect(result.rawText).toBeNull();
    expect(result.correctionId).toBeNull();
    expect(shared.correctionCalls).toHaveLength(0);
  });

  it("flushParagraph does not return a correctionId", () => {
    emitTranscriptionEvent({ type: "complete", text: "react is great" });

    const handleFlush = getHandler("voice-input:flush-paragraph");
    const result = handleFlush(fakeEvent) as {
      rawText: string | null;
      correctionId: string | null;
    };
    expect(result.rawText).toBeNull();
    expect(result.correctionId).toBeNull();
  });

  it("stop sends CORRECTION_REPLACE with correctionId and corrected text", async () => {
    shared.correctionResult = "React is great.";
    emitTranscriptionEvent({ type: "complete", text: "react is great" });

    const handleStop = getHandler("voice-input:stop");
    const result = (await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent)) as {
      rawText: string | null;
      correctionId: string | null;
    };

    await vi.waitFor(() => {
      const msg = win.__sent.find((m) => m.channel === "voice-input:correction-replace");
      expect(msg).toBeDefined();
      expect((msg?.payload as { correctionId: string }).correctionId).toBe(result.correctionId);
      expect((msg?.payload as { correctedText: string }).correctedText).toBe("React is great.");
    });
  });

  it("stop flushes the remaining paragraph buffer and returns rawText and correctionId", async () => {
    emitTranscriptionEvent({ type: "complete", text: "final sentence" });

    const handleStop = getHandler("voice-input:stop");
    const result = (await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent)) as {
      rawText: string | null;
      correctionId: string | null;
    };

    expect(result.rawText).toBe("final sentence");
    expect(result.correctionId).toBeTypeOf("string");
    expect(result.correctionId).not.toBeNull();
  });

  it("stop returns null rawText and null correctionId when buffer is already empty", async () => {
    const handleStop = getHandler("voice-input:stop");
    const result = (await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent)) as {
      rawText: string | null;
      correctionId: string | null;
    };

    expect(result.rawText).toBeNull();
    expect(result.correctionId).toBeNull();
  });

  it("stop fires correction for the flushed paragraph", async () => {
    emitTranscriptionEvent({ type: "complete", text: "dictated at stop" });

    const handleStop = getHandler("voice-input:stop");
    await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent);

    await vi.waitFor(() => {
      expect(shared.correctionCalls).toHaveLength(1);
      expect(shared.correctionCalls[0].request.rawText).toBe("dictated at stop");
      expect(shared.correctionCalls[0].request.reason).toBe("stop");
    });
  });

  it("whitespace-only utterances are not added to the session transcript", () => {
    emitTranscriptionEvent({ type: "complete", text: "   " });

    const handleStop = getHandler("voice-input:stop");
    const result = handleStop(fakeEvent) as Promise<{ rawText: string | null }>;
    return expect(result).resolves.toEqual({ rawText: null, correctionId: null });
  });

  it("paragraph buffer resets when a new session starts", async () => {
    emitTranscriptionEvent({ type: "complete", text: "session one" });

    // Start a new session — should reset the buffer
    const handleStart = getHandler("voice-input:start");
    await (handleStart as (e: unknown) => Promise<unknown>)(fakeEvent);

    const handleFlush = getHandler("voice-input:flush-paragraph");
    const result = handleFlush(fakeEvent) as { rawText: string | null };
    expect(result.rawText).toBeNull();
  });

  it("paragraph_boundary event inserts structure but does not queue correction", async () => {
    emitTranscriptionEvent({ type: "complete", text: "first utterance" });
    emitTranscriptionEvent({ type: "complete", text: "second utterance" });

    emitTranscriptionEvent({ type: "paragraph_boundary" });

    const boundaryMsg = win.__sent.find((m) => m.channel === "voice-input:paragraph-boundary");
    expect(boundaryMsg).toBeDefined();
    const payload = boundaryMsg?.payload as { rawText: string | null; correctionId: string | null };
    expect(payload.rawText).toBeNull();
    expect(payload.correctionId).toBeNull();

    const queuedMsg = win.__sent.find((m) => m.channel === "voice-input:correction-queued");
    expect(queuedMsg).toBeUndefined();
  });

  it("paragraph_boundary contributes a newline to the final stop correction", async () => {
    emitTranscriptionEvent({ type: "complete", text: "auto paragraph text" });
    emitTranscriptionEvent({ type: "complete", text: "second paragraph" });
    emitTranscriptionEvent({ type: "paragraph_boundary" });
    emitTranscriptionEvent({ type: "complete", text: "third paragraph" });

    const handleStop = getHandler("voice-input:stop");
    await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent);

    await vi.waitFor(() => {
      expect(shared.correctionCalls).toHaveLength(1);
      expect(shared.correctionCalls[0].request.rawText).toBe(
        "auto paragraph text second paragraph\nthird paragraph"
      );
      expect(shared.correctionCalls[0].request.reason).toBe("stop");
    });
  });

  it("paragraph_boundary event with empty buffer sends null rawText and null correctionId", () => {
    // No complete events before boundary — buffer is empty
    emitTranscriptionEvent({ type: "paragraph_boundary" });

    const boundaryMsg = win.__sent.find((m) => m.channel === "voice-input:paragraph-boundary");
    // flushParagraphBuffer returns { rawText: null, correctionId: null } for an empty buffer
    expect(boundaryMsg).toBeDefined();
    const payload = boundaryMsg?.payload as { rawText: string | null; correctionId: string | null };
    expect(payload.rawText).toBeNull();
    expect(payload.correctionId).toBeNull();
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

    emitTranscriptionEvent({ type: "complete", text: "test utterance" });

    const handleStop = getHandler("voice-input:stop");
    await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent);

    await vi.waitFor(() => {
      expect(shared.correctionCalls).toHaveLength(1);
      expect(shared.correctionCalls[0].settings.projectName).toBe("My Project");
      expect(shared.correctionCalls[0].settings.projectPath).toBe("/Users/foo/my-project");
    });
  });

  it("status events including finishing are forwarded to the renderer unchanged", () => {
    for (const status of ["connecting", "recording", "finishing", "idle", "error"] as const) {
      emitTranscriptionEvent({ type: "status", status });
    }

    const statusMsgs = win.__sent.filter((m) => m.channel === "voice-input:status");
    const statuses = statusMsgs.map((m) => m.payload as string);

    expect(statuses).toContain("finishing");
    expect(statuses).toEqual(["connecting", "recording", "finishing", "idle", "error"]);
  });

  it("stop returns null correctionId and does not fire correction when disabled", async () => {
    // Override the store mock to return correction-disabled settings for this test.
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
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
    });

    emitTranscriptionEvent({ type: "complete", text: "no correction please" });

    const handleStop = getHandler("voice-input:stop");
    const result = (await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent)) as {
      rawText: string | null;
      correctionId: string | null;
    };

    expect(result.rawText).toBe("no correction please");
    expect(result.correctionId).toBeNull();
    expect(shared.correctionCalls).toHaveLength(0);
    const correctionMsg = win.__sent.find((m) => m.channel === "voice-input:correction-replace");
    expect(correctionMsg).toBeUndefined();
  });

  it("flushParagraph captures in-flight utterance text for the final stop correction", async () => {
    emitTranscriptionEvent({ type: "complete", text: "First sentence" });
    shared.inFlightText = "in flight words";

    const handleFlush = getHandler("voice-input:flush-paragraph");
    const result = handleFlush(fakeEvent) as {
      rawText: string | null;
      correctionId: string | null;
    };
    expect(result.rawText).toBeNull();
    expect(result.correctionId).toBeNull();

    shared.inFlightText = "";
    const handleStop = getHandler("voice-input:stop");
    await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent);

    await vi.waitFor(() => {
      expect(shared.correctionCalls[0].request.rawText).toBe("First sentence in flight words");
    });
  });

  it("flushParagraph with only in-flight text defers it until stop", async () => {
    shared.inFlightText = "only delta text";

    const handleFlush = getHandler("voice-input:flush-paragraph");
    const result = handleFlush(fakeEvent) as {
      rawText: string | null;
      correctionId: string | null;
    };

    expect(result.rawText).toBeNull();
    expect(result.correctionId).toBeNull();
    shared.inFlightText = "";

    const handleStop = getHandler("voice-input:stop");
    await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent);

    await vi.waitFor(() => {
      expect(shared.correctionCalls[0].request.rawText).toBe("only delta text");
    });
  });

  it("flushParagraph with empty in-flight text still returns null when no completed utterances", () => {
    shared.inFlightText = "";

    const handleFlush = getHandler("voice-input:flush-paragraph");
    const result = handleFlush(fakeEvent) as {
      rawText: string | null;
      correctionId: string | null;
    };

    expect(result.rawText).toBeNull();
  });

  it("in-flight text is included in correction when stop follows Enter", async () => {
    emitTranscriptionEvent({ type: "complete", text: "first part" });
    shared.inFlightText = "second part";

    const handleFlush = getHandler("voice-input:flush-paragraph");
    handleFlush(fakeEvent);
    shared.inFlightText = "";
    const handleStop = getHandler("voice-input:stop");
    await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent);

    await vi.waitFor(() => {
      expect(shared.correctionCalls).toHaveLength(1);
      expect(shared.correctionCalls[0].request.rawText).toBe("first part second part");
    });
  });

  it("complete event arriving during stopGracefully drain is included in the final stop correction", async () => {
    shared.useDeferredDrain = true;

    emitTranscriptionEvent({ type: "complete", text: "before drain" });

    const handleStop = getHandler("voice-input:stop");
    const stopPromise = (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent);

    // While stopGracefully is pending (draining), a late complete event fires
    emitTranscriptionEvent({ type: "complete", text: "late utterance" });

    // Now resolve the drain
    shared.drainResolve!();

    const result = (await stopPromise) as { rawText: string | null; correctionId: string | null };

    expect(result.rawText).toBe("before drain late utterance");
    expect(result.correctionId).toBeTypeOf("string");
  });

  it("stop correctionId matches the subsequent correction-replace IPC message", async () => {
    shared.correctionResult = "Corrected final sentence.";
    emitTranscriptionEvent({ type: "complete", text: "final sentence" });

    const handleStop = getHandler("voice-input:stop");
    const result = (await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent)) as {
      rawText: string | null;
      correctionId: string | null;
    };

    expect(result.correctionId).toBeTypeOf("string");
    expect(result.correctionId).not.toBeNull();

    // Wait for the async correction to send CORRECTION_REPLACE to the renderer
    await vi.waitFor(() => {
      const correctionMsg = win.__sent.find((m) => m.channel === "voice-input:correction-replace");
      expect(correctionMsg).toBeDefined();
      expect((correctionMsg?.payload as { correctionId: string }).correctionId).toBe(
        result.correctionId
      );
      expect((correctionMsg?.payload as { correctedText: string }).correctedText).toBe(
        "Corrected final sentence."
      );
    });
  });
});
