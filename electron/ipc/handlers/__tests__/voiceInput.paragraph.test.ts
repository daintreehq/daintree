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
const shared = vi.hoisted(() => ({
  transcriptionEventCallback: null as ((e: { type: string; text?: string }) => void) | null,
  correctionResult: "Corrected paragraph.",
  correctionCalls: [] as Array<{ text: string; settings: Record<string, unknown> }>,
}));

vi.mock("../../../services/VoiceTranscriptionService.js", () => ({
  VoiceTranscriptionService: function VoiceTranscriptionService(this: Record<string, unknown>) {
    this.onEvent = function (cb: (e: { type: string; text?: string }) => void) {
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

function emitTranscriptionEvent(event: { type: string; text?: string }) {
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

  it("flushParagraph sends CORRECTION_REPLACE with corrected text", async () => {
    shared.correctionResult = "React is great. Use it everywhere.";
    emitTranscriptionEvent({ type: "complete", text: "react is great" });

    const handleFlush = getHandler("voice-input:flush-paragraph");
    handleFlush(fakeEvent);

    await vi.waitFor(() => {
      const msg = win.__sent.find((m) => m.channel === "voice-input:correction-replace");
      expect(msg).toBeDefined();
      expect(msg?.payload).toEqual({
        rawText: "react is great",
        correctedText: "React is great. Use it everywhere.",
      });
    });
  });

  it("stop flushes the remaining paragraph buffer and returns rawText", async () => {
    emitTranscriptionEvent({ type: "complete", text: "final sentence" });

    const handleStop = getHandler("voice-input:stop");
    const result = (await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent)) as {
      rawText: string | null;
    };

    expect(result.rawText).toBe("final sentence");
  });

  it("stop returns null rawText when buffer is already empty", async () => {
    const handleStop = getHandler("voice-input:stop");
    const result = (await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent)) as {
      rawText: string | null;
    };

    expect(result.rawText).toBeNull();
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
});
