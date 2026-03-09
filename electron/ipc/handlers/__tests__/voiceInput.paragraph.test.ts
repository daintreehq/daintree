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
  correctionCalls: [] as Array<{ text: string; settings: Record<string, unknown> }>,
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
      return Promise.resolve();
    };
    this.sendAudioChunk = function () {};
    this.destroy = function () {};
  },
}));

vi.mock("../../../services/VoiceCorrectionService.js", () => ({
  VoiceCorrectionService: function VoiceCorrectionService(this: Record<string, unknown>) {
    this.correct = function (text: string, settings: Record<string, unknown>) {
      shared.correctionCalls.push({ text, settings });
      return Promise.resolve(shared.correctionResult);
    };
    this.resetHistory = function () {};
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
          correctionModel: "gpt-5-nano",
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

  it("flushParagraph joins accumulated utterances and clears the buffer", () => {
    emitTranscriptionEvent({ type: "complete", text: "First sentence" });
    emitTranscriptionEvent({ type: "complete", text: "Second sentence" });

    const handleFlush = getHandler("voice-input:flush-paragraph");
    const result = handleFlush(fakeEvent) as { rawText: string | null };
    expect(result.rawText).toBe("First sentence Second sentence");

    // Buffer is now empty — second flush returns null
    const result2 = handleFlush(fakeEvent) as { rawText: string | null };
    expect(result2.rawText).toBeNull();
  });

  it("flushParagraph triggers correction with the joined paragraph text", async () => {
    emitTranscriptionEvent({ type: "complete", text: "react is great" });
    emitTranscriptionEvent({ type: "complete", text: "use it everywhere" });

    const handleFlush = getHandler("voice-input:flush-paragraph");
    handleFlush(fakeEvent);

    await vi.waitFor(() => {
      expect(shared.correctionCalls).toHaveLength(1);
      expect(shared.correctionCalls[0].text).toBe("react is great use it everywhere");
      expect((shared.correctionCalls[0].settings as { model: string }).model).toBe("gpt-5-nano");
    });
  });

  it("flushParagraph returns a non-null correctionId when correction is queued", () => {
    emitTranscriptionEvent({ type: "complete", text: "react is great" });

    const handleFlush = getHandler("voice-input:flush-paragraph");
    const result = handleFlush(fakeEvent) as {
      rawText: string | null;
      correctionId: string | null;
    };
    expect(result.rawText).toBe("react is great");
    expect(result.correctionId).toBeTypeOf("string");
    expect(result.correctionId).not.toBeNull();
  });

  it("flushParagraph sends CORRECTION_REPLACE with correctionId and corrected text", async () => {
    shared.correctionResult = "React is great. Use it everywhere.";
    emitTranscriptionEvent({ type: "complete", text: "react is great" });

    const handleFlush = getHandler("voice-input:flush-paragraph");
    const result = handleFlush(fakeEvent) as {
      rawText: string | null;
      correctionId: string | null;
    };

    await vi.waitFor(() => {
      const msg = win.__sent.find((m) => m.channel === "voice-input:correction-replace");
      expect(msg).toBeDefined();
      expect((msg?.payload as { correctionId: string }).correctionId).toBe(result.correctionId);
      expect((msg?.payload as { correctedText: string }).correctedText).toBe(
        "React is great. Use it everywhere."
      );
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
      expect(shared.correctionCalls[0].text).toBe("dictated at stop");
    });
  });

  it("whitespace-only utterances are not added to the paragraph buffer", () => {
    emitTranscriptionEvent({ type: "complete", text: "   " });

    const handleFlush = getHandler("voice-input:flush-paragraph");
    const result = handleFlush(fakeEvent) as { rawText: string | null };
    expect(result.rawText).toBeNull();
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

  it("paragraph_boundary event flushes buffer and sends PARAGRAPH_BOUNDARY to renderer", async () => {
    // Accumulate two utterances into the paragraph buffer
    emitTranscriptionEvent({ type: "complete", text: "first utterance" });
    emitTranscriptionEvent({ type: "complete", text: "second utterance" });

    // Service emits a paragraph_boundary (as would happen when Deepgram signals a boundary)
    emitTranscriptionEvent({ type: "paragraph_boundary" });

    // Renderer should have received the paragraph boundary channel message
    const boundaryMsg = win.__sent.find((m) => m.channel === "voice-input:paragraph-boundary");
    expect(boundaryMsg).toBeDefined();
    const payload = boundaryMsg?.payload as { rawText: string | null; correctionId: string | null };
    expect(payload.rawText).toBe("first utterance second utterance");
    // correctionId is a UUID string when correction is queued
    expect(payload.correctionId).toBeTypeOf("string");
    expect(payload.correctionId).not.toBeNull();

    // Buffer should be empty after the flush — next stop/flush returns null
    const handleFlush = getHandler("voice-input:flush-paragraph");
    const result = handleFlush(fakeEvent) as {
      rawText: string | null;
      correctionId: string | null;
    };
    expect(result.rawText).toBeNull();
  });

  it("paragraph_boundary event triggers correction for the flushed text", async () => {
    emitTranscriptionEvent({ type: "complete", text: "auto paragraph text" });
    emitTranscriptionEvent({ type: "paragraph_boundary" });

    await vi.waitFor(() => {
      expect(shared.correctionCalls).toHaveLength(1);
      expect(shared.correctionCalls[0].text).toBe("auto paragraph text");
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

    const handleFlush = getHandler("voice-input:flush-paragraph");
    handleFlush(fakeEvent);

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

  it("flushParagraph returns null correctionId and does not fire correction when disabled", async () => {
    // Override the store mock to return correction-disabled settings for this test.
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      deepgramApiKey: "dg-test-key",
      correctionApiKey: "",
      correctionEnabled: false,
      correctionModel: "gpt-5-nano",
      customDictionary: [],
      correctionCustomInstructions: "",
      language: "en",
      transcriptionModel: "nova-3",
      paragraphingStrategy: "spoken-command",
    });

    emitTranscriptionEvent({ type: "complete", text: "no correction please" });

    const handleFlush = getHandler("voice-input:flush-paragraph");
    const result = handleFlush(fakeEvent) as {
      rawText: string | null;
      correctionId: string | null;
    };

    // rawText is still returned so the renderer knows what was flushed
    expect(result.rawText).toBe("no correction please");
    // correctionId is null — no correction was queued
    expect(result.correctionId).toBeNull();
    // No correction call was fired
    expect(shared.correctionCalls).toHaveLength(0);
    // No CORRECTION_REPLACE message was sent to renderer
    const correctionMsg = win.__sent.find((m) => m.channel === "voice-input:correction-replace");
    expect(correctionMsg).toBeUndefined();
  });
});
