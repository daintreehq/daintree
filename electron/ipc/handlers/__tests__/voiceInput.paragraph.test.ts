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
};

const shared = vi.hoisted(() => ({
  transcriptionEventCallback: null as ((e: MockTranscriptionEvent) => void) | null,
  /** Deferred drain promise — resolve externally to control stopGracefully() timing. */
  drainResolve: null as (() => void) | null,
  /** When true, stopGracefully uses a deferred promise instead of resolving immediately. */
  useDeferredDrain: false,
  correctionCalls: [] as Array<{ request: unknown; settings: unknown }>,
  /** Settings objects passed to svc.start(), in call order. */
  startCalls: [] as unknown[],
  /** Optional override for assembleKeyterms — lets a test defer/control timing. */
  assembleKeyterms: null as null | (() => Promise<string[]>),
}));

vi.mock("../../../services/VoiceTranscriptionService.js", () => ({
  VoiceTranscriptionService: function VoiceTranscriptionService(this: Record<string, unknown>) {
    this.onEvent = function (cb: (e: MockTranscriptionEvent) => void) {
      shared.transcriptionEventCallback = cb;
      return () => {};
    };
    this.start = function (settings: unknown) {
      shared.startCalls.push(settings);
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
    this.commitParagraphBoundary = function () {};
  },
}));

vi.mock("../../../services/VoiceCorrectionService.js", () => ({
  VoiceCorrectionService: function VoiceCorrectionService(this: Record<string, unknown>) {
    this.correct = function (request: unknown, settings: unknown) {
      shared.correctionCalls.push({ request, settings });
      return Promise.resolve({
        action: "replace",
        correctedText: "hello world",
        confidence: "high",
        confirmedText: "hello world",
      });
    };
    this.detectFileLinkTokens = function () {
      return Promise.resolve([]);
    };
    this.setSessionSignal = function () {};
  },
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProject: vi.fn(() => null),
    getCurrentProjectId: vi.fn(() => null),
  },
}));

vi.mock("../../../services/voiceContextKeyterms.js", () => ({
  assembleKeyterms: vi.fn(() =>
    shared.assembleKeyterms ? shared.assembleKeyterms() : Promise.resolve([])
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
          correctionModel: "gpt-5.6-luna",
          customDictionary: [],
          correctionCustomInstructions: "",
          language: "en",
          transcriptionModel: "gpt-realtime-whisper",
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
  },
}));

// ── Module import (once) ───────────────────────────────────────────────────
import { registerVoiceInputHandlers, getVoiceSettings, validateOpenAIKey } from "../voiceInput.js";
import { ValidationError } from "../../validationError.js";

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

describe("voiceInput — IPC handler surface", () => {
  let win: ReturnType<typeof buildMainWindow>;
  let cleanup: () => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    shared.transcriptionEventCallback = null;
    shared.drainResolve = null;
    shared.useDeferredDrain = false;
    shared.correctionCalls = [];
    shared.startCalls = [];
    shared.assembleKeyterms = null;

    win = buildMainWindow();
    cleanup = registerVoiceInputHandlers({
      mainWindow: win as unknown as Electron.BrowserWindow,
    } as Parameters<typeof registerVoiceInputHandlers>[0]);

    const handleStart = getHandler("voice-input:start");
    await (handleStart as (e: unknown) => Promise<unknown>)(fakeEvent);
  });

  afterEach(() => {
    cleanup?.();
  });

  it("forwards transcription complete events to the renderer", () => {
    emitTranscriptionEvent({ type: "complete", text: "Hello world" });

    const completeMsg = win.__sent.find((m) => m.channel === "voice-input:transcription-complete");
    expect(completeMsg).toBeDefined();
    expect(completeMsg?.payload).toEqual({ text: "Hello world", willCorrect: false });
  });

  it("does not start the provider when a stop lands during keyterm assembly", async () => {
    // The beforeEach already opened a session; tear it down so this test owns
    // a clean start whose assembly window we can control.
    const handleStop = getHandler("voice-input:stop");
    await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent);
    shared.startCalls = [];

    // Begin a new session whose keyterm assembly hangs until we resolve it.
    let resolveAssembly!: (terms: string[]) => void;
    const assemblyPromise = new Promise<string[]>((resolve) => {
      resolveAssembly = resolve;
    });
    shared.assembleKeyterms = () => assemblyPromise;
    const handleStart = getHandler("voice-input:start");
    const startPromise = (handleStart as (e: unknown) => Promise<unknown>)(fakeEvent) as Promise<{
      ok: boolean;
      error?: string;
    }>;

    // Stop arrives mid-assembly, then assembly finishes.
    await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent);
    resolveAssembly(["Daintree"]);
    const result = await startPromise;

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Voice session superseded");
    // The superseded start must never reach svc.start().
    expect(shared.startCalls).toHaveLength(0);
  });

  it("passes the assembled keyterms to svc.start()", async () => {
    const handleStop = getHandler("voice-input:stop");
    await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent);
    shared.startCalls = [];

    shared.assembleKeyterms = () => Promise.resolve(["Daintree", "xterm"]);
    const handleStart = getHandler("voice-input:start");
    await (handleStart as (e: unknown) => Promise<unknown>)(fakeEvent);

    expect(shared.startCalls).toHaveLength(1);
    expect((shared.startCalls[0] as { keyterms?: string[] }).keyterms).toEqual([
      "Daintree",
      "xterm",
    ]);
  });

  it("paragraph_boundary forwards a payload with only rawText", () => {
    emitTranscriptionEvent({ type: "paragraph_boundary" });

    const boundaryMsg = win.__sent.find((m) => m.channel === "voice-input:paragraph-boundary");
    expect(boundaryMsg).toBeDefined();
    expect(boundaryMsg?.payload).toEqual({ rawText: null });
  });

  it("stop returns { rawText: null }", async () => {
    const handleStop = getHandler("voice-input:stop");
    const result = (await (handleStop as (e: unknown) => Promise<unknown>)(fakeEvent)) as {
      rawText: string | null;
    };
    expect(result).toEqual({ rawText: null });
  });

  it("flushParagraph returns { rawText: null }", () => {
    const handleFlush = getHandler("voice-input:flush-paragraph");
    const result = handleFlush(fakeEvent) as { rawText: string | null };
    expect(result).toEqual({ rawText: null });
  });

  it("correct validates payloads and returns the corrected text", async () => {
    const handleCorrect = getHandler("voice-input:correct");

    const result = await (handleCorrect as (e: unknown, request: unknown) => Promise<unknown>)(
      fakeEvent,
      { rawText: "helo world", recentContext: ["previous sentence"] }
    );

    expect(result).toEqual({ action: "replace", correctedText: "hello world" });
    expect(shared.correctionCalls).toHaveLength(1);
    expect(shared.correctionCalls[0]?.request).toMatchObject({
      rawText: "helo world",
      recentContext: ["previous sentence"],
      reason: "stop",
    });
    expect(shared.correctionCalls[0]?.settings).toMatchObject({
      model: "gpt-5.6-luna",
      apiKey: "sk-test",
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
    for (const status of ["connecting", "recording", "finishing", "idle", "error"] as const) {
      emitTranscriptionEvent({ type: "status", status });
    }

    const statusMsgs = win.__sent.filter((m) => m.channel === "voice-input:status");
    const statuses = statusMsgs.map((m) => m.payload as string);
    expect(statuses).toEqual(["connecting", "recording", "finishing", "idle", "error"]);
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
    await (handleStart as (e: unknown) => Promise<unknown>)(fakeEvent);
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
        payload: { text: "first sentence", willCorrect: false },
      },
      {
        channel: "voice-input:paragraph-boundary",
        payload: { rawText: null, correctionId: null },
      },
      {
        channel: "voice-input:transcription-complete",
        payload: { text: "second sentence", willCorrect: false },
      },
    ]);
  });

  it("strips a trailing 'new paragraph' command and emits only the prefix as one complete", () => {
    // applyDictationCommands turns "hello new paragraph" into "hello\n\n";
    // the handler's split + filter(Boolean) drops the trailing empty part,
    // so a single complete fires with no paragraph-boundary.
    emitTranscriptionEvent({ type: "complete", text: "hello new paragraph" });

    const completes = win.__sent.filter((m) => m.channel === "voice-input:transcription-complete");
    const boundaries = win.__sent.filter((m) => m.channel === "voice-input:paragraph-boundary");
    expect(completes).toHaveLength(1);
    expect(completes[0]?.payload).toEqual({ text: "hello", willCorrect: false });
    expect(boundaries).toHaveLength(0);
  });

  it("emits nothing when the utterance is just a paragraph command", () => {
    emitTranscriptionEvent({ type: "complete", text: "new paragraph" });

    const completes = win.__sent.filter((m) => m.channel === "voice-input:transcription-complete");
    const boundaries = win.__sent.filter((m) => m.channel === "voice-input:paragraph-boundary");
    expect(completes).toHaveLength(0);
    expect(boundaries).toHaveLength(0);
  });

  it("rewrites a trailing 'period' command into '.' on the emitted text", () => {
    emitTranscriptionEvent({ type: "complete", text: "hello period" });

    const complete = win.__sent.find((m) => m.channel === "voice-input:transcription-complete");
    expect(complete?.payload).toEqual({ text: "hello.", willCorrect: false });
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
      text: "hello new paragraph world",
      willCorrect: false,
    });
    expect(boundaries).toHaveLength(0);
  });
});

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
      correctionModel: "gpt-5.6-luna",
      customDictionary: [],
      correctionCustomInstructions: "",
      language: "en",
      transcriptionModel: "gpt-realtime-whisper",
      paragraphingStrategy: "manual",
      resolveFileLinks: true,
    });

    win = buildMainWindow();
    cleanup = registerVoiceInputHandlers({
      mainWindow: win as unknown as Electron.BrowserWindow,
    } as Parameters<typeof registerVoiceInputHandlers>[0]);

    const handleStart = getHandler("voice-input:start");
    await (handleStart as (e: unknown) => Promise<unknown>)(fakeEvent);
  });

  afterEach(() => {
    cleanup?.();
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

  function providerSettings(provider: "openai" | "deepgram") {
    return {
      enabled: true,
      openaiApiKey: provider === "openai" ? "sk-test" : "",
      deepgramApiKey: provider === "deepgram" ? "dg-test" : "",
      language: "en",
      customDictionary: [],
      transcriptionProvider: provider,
      transcriptionModel: "gpt-realtime-whisper",
      correctionEnabled: false,
      correctionModel: "gpt-5.6-luna",
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
  let startFn: (e: unknown) => Promise<unknown>;
  let stopFn: (e: unknown) => Promise<unknown>;
  let setSettingsFn: (e: unknown, patch: unknown) => Promise<unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();
    shared.transcriptionEventCallback = null;
    shared.startCalls = [];
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
  });

  it("injects assembled keyterms into the Deepgram session settings", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValue(providerSettings("deepgram"));
    shared.assembleKeyterms = () => Promise.resolve(["alpha", "beta"]);

    await startFn(fakeEvent);

    expect(shared.startCalls).toHaveLength(1);
    expect(shared.startCalls[0]).toMatchObject({
      transcriptionProvider: "deepgram",
      keyterms: ["alpha", "beta"],
    });
  });

  it("injects assembled keyterms into a non-Deepgram session (OpenAI prompt path)", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValue(providerSettings("openai"));
    const { assembleKeyterms } = await import("../../../services/voiceContextKeyterms.js");
    shared.assembleKeyterms = () => Promise.resolve(["alpha", "beta"]);

    await startFn(fakeEvent);

    // OpenAI consumes keyterms via transcription.prompt, so assembly runs for it too.
    expect(assembleKeyterms).toHaveBeenCalled();
    expect(shared.startCalls).toHaveLength(1);
    expect(shared.startCalls[0]).toMatchObject({
      transcriptionProvider: "openai",
      keyterms: ["alpha", "beta"],
    });
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
    const aPromise = startFn(fakeEvent);

    // Start B (OpenAI) — supersedes A and starts immediately.
    vi.mocked(store.get).mockReturnValue(providerSettings("openai"));
    await startFn(fakeEvent);

    // A's assembly now resolves — but A must detect it was superseded and bail.
    gate.resolve(["alpha"]);
    await expect(aPromise).resolves.toEqual({ ok: false, error: "Voice session superseded" });

    // Only B reached svc.start; A never did (no second session).
    expect(shared.startCalls).toHaveLength(1);
    expect(shared.startCalls[0]).toMatchObject({ transcriptionProvider: "openai" });
  });

  it("bails a Deepgram start whose assembly throws after a stop", async () => {
    const { store } = await import("../../../store.js");
    const gate = deferred<string[]>();
    shared.assembleKeyterms = () => gate.promise;

    vi.mocked(store.get).mockReturnValue(providerSettings("deepgram"));
    const aPromise = startFn(fakeEvent);

    // Stop supersedes the in-flight assembly.
    await stopFn(fakeEvent);

    // Assembly then fails — the catch path must still honor the supersede.
    gate.reject(new Error("assembly boom"));
    await expect(aPromise).resolves.toEqual({ ok: false, error: "Voice session superseded" });
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
      customDictionary: [],
      transcriptionModel: "gpt-realtime-whisper",
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

  it("does not write to disk when no legacy fields are present", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      openaiApiKey: "sk-present",
    });

    getVoiceSettings();

    expect(vi.mocked(store.set)).not.toHaveBeenCalled();
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

  it("returns recordingMode='toggle' when the field is missing from the store", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      openaiApiKey: "sk-present",
      // recordingMode intentionally absent.
    });

    const settings = getVoiceSettings();

    expect(settings.recordingMode).toBe("toggle");
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

  it("normalizes malformed recordingMode values to 'toggle' without writing to disk", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      openaiApiKey: "sk-present",
      recordingMode: "hold" as unknown,
    });

    const settings = getVoiceSettings();

    expect(settings.recordingMode).toBe("toggle");
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

  it("normalizes a stale correctionModel to gpt-5.6-luna and persists the cleanup", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      openaiApiKey: "sk-present",
      correctionModel: "gpt-5-mini",
    });

    const settings = getVoiceSettings();

    expect(settings.correctionModel).toBe("gpt-5.6-luna");
    // The read-time safety net writes the cleaned value through once so the
    // stale model does not survive on disk (issue #11365).
    expect(vi.mocked(store.set)).toHaveBeenCalledOnce();
    const persisted = (
      vi.mocked(store.set).mock.calls[0] as unknown as [string, Record<string, unknown>]
    )[1];
    expect(persisted.correctionModel).toBe("gpt-5.6-luna");
    // Normalization must write the full merged object, not a defaults-only one —
    // sibling settings must survive the cleanup write.
    expect(persisted.enabled).toBe(true);
    expect(persisted.openaiApiKey).toBe("sk-present");
  });

  it("normalizes the retired gpt-5-nano correction model to gpt-5.6-luna on read", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      openaiApiKey: "sk-present",
      correctionModel: "gpt-5-nano",
    });

    const settings = getVoiceSettings();

    // Model-agnostic normalization: nano is not special-cased any more than mini.
    expect(settings.correctionModel).toBe("gpt-5.6-luna");
    expect(vi.mocked(store.set)).toHaveBeenCalledOnce();
  });

  it("does not write back when correctionModel is already gpt-5.6-luna", async () => {
    const { store } = await import("../../../store.js");
    vi.mocked(store.get).mockReturnValueOnce({
      enabled: true,
      openaiApiKey: "sk-present",
      correctionModel: "gpt-5.6-luna",
    });

    const settings = getVoiceSettings();

    expect(settings.correctionModel).toBe("gpt-5.6-luna");
    expect(vi.mocked(store.set)).not.toHaveBeenCalled();
  });
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

  it("returns valid for 429 with unknown code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "Too many requests", code: "unknown_429_code" } }),
        { status: 429, headers: { "content-type": "application/json" } }
      )
    );

    const result = await validateOpenAIKey("sk-whatever");
    expect(result).toEqual({ valid: true });
  });

  it("returns valid for 429 with HTML body (proxy gateway)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<html>429 Too Many Requests</html>", {
        status: 429,
        headers: { "content-type": "text/html" },
      })
    );

    const result = await validateOpenAIKey("sk-proxy");
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
