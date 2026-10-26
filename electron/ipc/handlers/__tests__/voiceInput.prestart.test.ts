import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

vi.mock("../../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

type ServiceEvent = {
  type: string;
  sessionId?: string;
  text?: string;
  error?: { code: string; severity: string };
};

const shared = vi.hoisted(() => ({
  /** Ordered record of calls reaching the service: "start" and "chunk:<first byte>". */
  calls: [] as string[],
  stops: 0,
  eventCallback: null as ((e: ServiceEvent) => void) | null,
  startResult: { ok: true } as { ok: boolean; error?: string },
  /** When set, svc.start() returns this instead of resolving immediately. */
  startPromise: null as null | Promise<{ ok: boolean; error?: string }>,
  startError: null as null | Error,
  assembleKeyterms: null as null | (() => Promise<string[]>),
  /** The signal the correction service was last handed. */
  sessionSignal: null as AbortSignal | null,
  /** The session the fake provider was last started for; its events carry it. */
  providerSessionId: null as string | null,
  /** The project of the view sending the start. */
  viewProjectId: null as string | null,
  /** When set, stopGracefully() returns this instead of resolving immediately. */
  drainPromise: null as null | Promise<void>,
  /** Stored voice settings on top of the enabled, keyed defaults. */
  voiceInput: {} as Record<string, unknown>,
  /** Each project's dictation vocabulary, by id. */
  vocabularies: {} as Record<string, string[]>,
  /** What the correction service was last asked to prefer. */
  correctionDictionary: null as string[] | null,
}));

vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../window/webContentsRegistry.js")>()),
  getProjectForWebContents: vi.fn(() => shared.viewProjectId),
}));

vi.mock("../../../services/VoiceTranscriptionService.js", () => ({
  VoiceTranscriptionService: function VoiceTranscriptionService(this: Record<string, unknown>) {
    this.onEvent = function (cb: (e: ServiceEvent) => void) {
      const forward = (e: ServiceEvent) =>
        cb({ ...e, sessionId: shared.providerSessionId ?? undefined });
      shared.eventCallback = forward;
      return () => {
        if (shared.eventCallback === forward) shared.eventCallback = null;
      };
    };
    this.start = function (_settings: unknown, sessionId: string) {
      shared.providerSessionId = sessionId;
      shared.calls.push("start");
      if (shared.startError) return Promise.reject(shared.startError);
      return shared.startPromise ?? Promise.resolve(shared.startResult);
    };
    this.sendAudioChunk = function (chunk: ArrayBuffer) {
      shared.calls.push(`chunk:${new Uint8Array(chunk)[0]}`);
    };
    this.stopGracefully = function () {
      shared.calls.push("stopGracefully");
      return shared.drainPromise ?? Promise.resolve();
    };
    this.stop = function () {
      shared.stops++;
    };
    this.destroy = function () {};
    this.commitParagraphBoundary = function () {};
  },
}));

vi.mock("../../../services/VoiceCorrectionService.js", () => ({
  VoiceCorrectionService: function VoiceCorrectionService(this: Record<string, unknown>) {
    this.setSessionSignal = function (signal: AbortSignal | null) {
      shared.sessionSignal = signal;
    };
    this.correct = async function (
      request: { rawText: string },
      settings: { customDictionary: string[] }
    ) {
      shared.correctionDictionary = settings.customDictionary;
      return { action: "no_change", confirmedText: request.rawText };
    };
  },
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProject: vi.fn(() => null),
    getCurrentProjectId: vi.fn(() => null),
    getProjectById: vi.fn((id: string) => (id === "proj-a" ? { id, name: "Alpha" } : null)),
  },
}));

vi.mock("../../../services/projectVoiceDictionary.js", () => ({
  readProjectVoiceDictionary: vi.fn(async (id: string) => {
    const terms = shared.vocabularies[id];
    if (!terms) throw new Error("Project not found");
    return terms.map((term) => ({ term, heardAs: [], source: "manual", addedAt: 0 }));
  }),
}));

vi.mock("../../../services/voiceContextKeyterms.js", () => ({
  assembleKeyterms: vi.fn(() =>
    shared.assembleKeyterms ? shared.assembleKeyterms() : Promise.resolve([])
  ),
  formatKeytermPrompt: vi.fn(() => ""),
}));

vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn((key: string) =>
      key === "voiceInput"
        ? { enabled: true, openaiApiKey: "sk-test", ...shared.voiceInput }
        : undefined
    ),
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
  },
}));

import { registerVoiceInputHandlers } from "../voiceInput.js";
import { assembleKeyterms } from "../../../services/voiceContextKeyterms.js";
import { projectStore } from "../../../services/ProjectStore.js";
import {
  AUDIO_BUFFER_MAX_BYTES,
  AUDIO_BUFFER_MAX_CHUNKS,
  AUDIO_BUFFER_OVERFLOW_CODE,
} from "../../../services/voice/TranscriptionProvider.js";

type StartResult = { ok: boolean; error?: string };

const sender = vi.hoisted(() => ({
  destroyed: false,
  onDestroyed: null as null | (() => void),
}));

// A fresh renderer per test, as in production: a destroyed WebContents is never
// reused, and the shared destroyed-watcher remembers the ones it saw go.
// Events go to the view that started the session; it records into the active log.
const sink = { current: [] as Array<{ channel: string; payload: unknown }> };
let nextSenderId = 1;
function makeSender() {
  return {
    id: nextSenderId++,
    once: vi.fn((_event: string, fn: () => void) => {
      sender.onDestroyed = fn;
    }),
    removeListener: vi.fn(),
    isDestroyed: () => sender.destroyed,
    send: vi.fn((channel: string, payload: unknown) => {
      sink.current.push({ channel, payload });
    }),
  };
}

const fakeEvent = { sender: makeSender() };

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`No handler registered for channel: ${channel}`);
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

// Each start() mints a fresh session id, as the renderer does, and audio and
// stops default to the latest one.
let nextSessionNumber = 1;
let currentSessionId = "";

function sendChunk(id: number, bytes = 4800, sessionId = currentSessionId) {
  const call = ipcMainMock.on.mock.calls.find(([c]) => c === "voice-input:audio-chunk");
  if (!call) throw new Error("audio-chunk listener not registered");
  const chunk = new Uint8Array(bytes);
  chunk[0] = id;
  (call[1] as (e: unknown, s: unknown, c: ArrayBuffer) => void)({}, sessionId, chunk.buffer);
}

type StartOutcome = { status: "started" | "superseded" | "failed"; error?: string };

// Mapped onto the old result shape so these cases read the same as before.
function start(): Promise<StartResult> {
  currentSessionId = `session-${nextSessionNumber++}`;
  return (
    getHandler("voice-input:start")(fakeEvent, currentSessionId) as Promise<StartOutcome>
  ).then(
    (outcome) =>
      outcome.status === "started"
        ? { ok: true }
        : {
            ok: false,
            error: outcome.status === "failed" ? outcome.error : "Voice session superseded",
          },
    (error: Error) => ({ ok: false, error: error.message })
  );
}

function stop(sessionId = currentSessionId) {
  return getHandler("voice-input:stop")(fakeEvent, sessionId);
}

function deferKeyterms() {
  let resolve!: (terms: string[]) => void;
  const promise = new Promise<string[]>((r) => {
    resolve = r;
  });
  shared.assembleKeyterms = () => promise;
  return resolve;
}

describe("voiceInput — audio sent before the provider starts", () => {
  let sent: Array<{ channel: string; payload: unknown }>;
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    shared.calls = [];
    shared.stops = 0;
    shared.eventCallback = null;
    shared.startResult = { ok: true };
    shared.startPromise = null;
    shared.startError = null;
    shared.assembleKeyterms = null;
    shared.sessionSignal = null;
    shared.providerSessionId = null;
    shared.drainPromise = null;
    sender.destroyed = false;
    sender.onDestroyed = null;
    fakeEvent.sender = makeSender();
    sent = [];
    sink.current = sent;
    const win = {
      webContents: {
        send: vi.fn((channel: string, payload: unknown) => sent.push({ channel, payload })),
      },
      isDestroyed: vi.fn(() => false),
    };
    cleanup = registerVoiceInputHandlers({
      mainWindow: win as unknown as Electron.BrowserWindow,
    } as Parameters<typeof registerVoiceInputHandlers>[0]);
  });

  afterEach(() => {
    cleanup?.();
  });

  const overflowErrors = () =>
    sent.filter(
      (m) =>
        m.channel === "voice-input:error" &&
        (m.payload as { error: { code: string } }).error.code === AUDIO_BUFFER_OVERFLOW_CODE
    );

  it("hands audio sent during service load and keyterm assembly to the provider in order, once", async () => {
    const resolveKeyterms = deferKeyterms();
    const pending = start();
    // Before the service import resolves.
    sendChunk(1);
    sendChunk(2);
    await vi.waitFor(() => expect(shared.eventCallback).not.toBeNull());
    // During keyterm assembly.
    sendChunk(3);
    expect(shared.calls).toEqual([]);

    resolveKeyterms([]);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(shared.calls).toEqual(["start", "chunk:1", "chunk:2", "chunk:3"]);

    // After the handoff, audio streams straight through.
    sendChunk(4);
    expect(shared.calls).toEqual(["start", "chunk:1", "chunk:2", "chunk:3", "chunk:4"]);
  });

  it("drains held audio when a stop lands before the provider starts", async () => {
    let resolveStart!: (r: StartResult) => void;
    shared.startPromise = new Promise((r) => {
      resolveStart = r;
    });
    let finishDrain!: () => void;
    shared.drainPromise = new Promise((r) => {
      finishDrain = r;
    });
    const resolveKeyterms = deferKeyterms();
    const pending = start();
    sendChunk(1);
    sendChunk(2);
    const stopping = stop();
    await vi.waitFor(() => expect(shared.eventCallback).not.toBeNull());
    expect(shared.calls).toEqual([]);

    resolveKeyterms([]);
    // The stop reaches the provider while it is still connecting, already
    // holding the audio, so its stop-before-ready path can transcribe it.
    await vi.waitFor(() => expect(shared.calls).toContain("stopGracefully"));
    expect(shared.calls).toEqual(["start", "chunk:1", "chunk:2", "stopGracefully"]);

    // The provider connects and transcribes while the stop drains it.
    resolveStart({ ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
    shared.eventCallback!({ type: "complete", text: "Yes, carry on" });
    finishDrain();
    await stopping;
    expect(sent).toContainEqual({
      channel: "voice-input:transcription-complete",
      payload: { sessionId: currentSessionId, text: "Yes, carry on", willCorrect: false },
    });

    // The next session must not replay the stopped session's audio.
    shared.calls = [];
    const next = start();
    sendChunk(3);
    await expect(next).resolves.toEqual({ ok: true });
    expect(shared.calls).toEqual(["start", "chunk:3"]);
  });

  it("cancels a start without opening a provider when a stop lands before any audio", async () => {
    const resolveKeyterms = deferKeyterms();
    const pending = start();
    await stop();
    resolveKeyterms([]);
    await expect(pending).resolves.toEqual({ ok: false, error: "Voice session superseded" });
    expect(shared.calls).not.toContain("start");
  });

  it("leaves a newer start alone when it supersedes a start a stop is draining", async () => {
    const resolveFirst = deferKeyterms();
    const first = start();
    sendChunk(1);
    const stopping = stop();
    await vi.waitFor(() => expect(shared.eventCallback).not.toBeNull());

    shared.assembleKeyterms = null;
    const second = start();
    sendChunk(2);
    resolveFirst([]);

    await expect(first).resolves.toEqual({ ok: false, error: "Voice session superseded" });
    await expect(second).resolves.toEqual({ ok: true });
    await stopping;
    expect(shared.calls).toEqual(["start", "chunk:2"]);
  });

  it("gives a superseding start only its own audio", async () => {
    const resolveFirst = deferKeyterms();
    const first = start();
    sendChunk(1);
    await vi.waitFor(() => expect(shared.eventCallback).not.toBeNull());

    shared.assembleKeyterms = null;
    const second = start();
    sendChunk(2);
    resolveFirst([]);

    await expect(first).resolves.toEqual({ ok: false, error: "Voice session superseded" });
    await expect(second).resolves.toEqual({ ok: true });
    expect(shared.calls).toEqual(["start", "chunk:2"]);
  });

  it("flushes held audio before the provider finishes starting", async () => {
    let resolveStart!: (r: { ok: boolean }) => void;
    shared.startPromise = new Promise((r) => {
      resolveStart = r;
    });
    const pending = start();
    sendChunk(1);
    sendChunk(2);
    await vi.waitFor(() => expect(shared.calls).toContain("start"));

    // The provider is still connecting, but already holds the audio — and new
    // audio follows it directly rather than being buffered a second time.
    expect(shared.calls).toEqual(["start", "chunk:1", "chunk:2"]);
    sendChunk(3);
    expect(shared.calls).toEqual(["start", "chunk:1", "chunk:2", "chunk:3"]);

    resolveStart({ ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
    expect(shared.calls).toEqual(["start", "chunk:1", "chunk:2", "chunk:3"]);
  });

  it("does not hold audio past a rejected provider start", async () => {
    shared.startError = new Error("boom");
    const pending = start();
    sendChunk(1);
    await expect(pending).resolves.toEqual({ ok: false, error: "boom" });

    // The failed session's late audio is neither held nor replayed into the next.
    shared.startError = null;
    sendChunk(2);
    await start();
    expect(shared.calls).toEqual(["start", "chunk:1", "start"]);
  });

  it("discards held audio when the renderer is destroyed during keyterm assembly", async () => {
    const resolveKeyterms = deferKeyterms();
    const pending = start();
    sendChunk(1);
    await vi.waitFor(() => expect(sender.onDestroyed).not.toBeNull());

    sender.destroyed = true;
    sender.onDestroyed!();
    resolveKeyterms([]);

    await expect(pending).resolves.toEqual({ ok: false, error: "Voice session superseded" });
    expect(shared.calls).toEqual([]);
  });

  it("does not start a session for a renderer destroyed during service load", async () => {
    const pending = start();
    sendChunk(1);
    sender.destroyed = true;

    await expect(pending).resolves.toEqual({ ok: false, error: "Voice session superseded" });
    expect(shared.calls).toEqual([]);
  });

  it("stops holding audio after a failed start", async () => {
    shared.startResult = { ok: false, error: "OpenAI API key not configured" };
    const pending = start();
    sendChunk(1);
    await expect(pending).resolves.toEqual({ ok: false, error: "OpenAI API key not configured" });

    // The session failed, so its audio goes nowhere.
    sendChunk(2);
    expect(shared.calls).toEqual(["start", "chunk:1"]);
  });

  it("leaves the service alone when a renderer whose start failed is destroyed", async () => {
    shared.startResult = { ok: false, error: "OpenAI API key not configured" };
    await expect(start()).resolves.toEqual({ ok: false, error: "OpenAI API key not configured" });
    expect(sender.onDestroyed).not.toBeNull();

    sender.destroyed = true;
    sender.onDestroyed!();

    expect(shared.stops).toBe(0);
  });

  it("leaves a newer session's signal alone when an older pending start fails", async () => {
    let failFirst!: (result: StartResult) => void;
    shared.startPromise = new Promise<StartResult>((r) => {
      failFirst = r;
    });
    const first = start();
    await vi.waitFor(() => expect(shared.calls).toEqual(["start"]));
    const firstSignal = shared.sessionSignal!;

    // Another view starts while the first is still connecting.
    fakeEvent.sender = makeSender();
    shared.startPromise = null;
    await expect(start()).resolves.toEqual({ ok: true });
    const secondSignal = shared.sessionSignal!;
    expect(secondSignal).not.toBe(firstSignal);

    // The second start's svc.start() tore down the first provider, which settles
    // its pending start as stopped.
    failFirst({ ok: false, error: "Voice session stopped" });
    await expect(first).resolves.toEqual({ ok: false, error: "Voice session stopped" });

    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(false);
    expect(shared.sessionSignal).toBe(secondSignal);
  });

  it("holds 15 seconds of startup audio without dropping any", async () => {
    const resolveKeyterms = deferKeyterms();
    const pending = start();
    // 150 chunks of 100ms at 24kHz mono PCM16: speech held through a slow connect.
    for (let i = 0; i < 150; i++) sendChunk(i % 256, 4800);

    resolveKeyterms([]);
    await pending;
    expect(shared.calls.filter((c) => c.startsWith("chunk:"))).toHaveLength(150);
    expect(overflowErrors()).toHaveLength(0);
  });

  it("drops the newest audio past the chunk cap and reports it once", async () => {
    const resolveKeyterms = deferKeyterms();
    const pending = start();
    for (let i = 0; i < AUDIO_BUFFER_MAX_CHUNKS + 5; i++) sendChunk(i % 256, 1000);

    expect(overflowErrors()).toHaveLength(1);
    expect(overflowErrors()[0]!.payload).toMatchObject({
      sessionId: currentSessionId,
      error: { severity: "transient" },
    });

    resolveKeyterms([]);
    await pending;
    const chunks = shared.calls.filter((c) => c.startsWith("chunk:"));
    expect(chunks).toHaveLength(AUDIO_BUFFER_MAX_CHUNKS);
    expect(chunks[0]).toBe("chunk:0");
    expect(chunks.at(-1)).toBe(`chunk:${AUDIO_BUFFER_MAX_CHUNKS - 1}`);
  });

  it("enforces the byte cap, including for a single oversized chunk", async () => {
    const resolveKeyterms = deferKeyterms();
    const pending = start();
    sendChunk(1, AUDIO_BUFFER_MAX_BYTES + 1);
    sendChunk(2, 1000);
    expect(overflowErrors()).toHaveLength(1);

    resolveKeyterms([]);
    await pending;
    // Once the cap is hit, the rest of the pre-start window is dropped — never a
    // later chunk spliced in after a gap.
    expect(shared.calls).toEqual(["start"]);
  });

  it("counts bytes across chunks toward the cap", async () => {
    const resolveKeyterms = deferKeyterms();
    const pending = start();
    const size = 40_000;
    // 18 × 40KB fits under 720KB; the 19th would exceed it, and so would the 20th.
    for (let i = 1; i <= 20; i++) sendChunk(i, size);
    expect(overflowErrors()).toHaveLength(1);

    resolveKeyterms([]);
    await pending;
    expect(shared.calls).toEqual([
      "start",
      ...Array.from({ length: 18 }, (_, i) => `chunk:${i + 1}`),
    ]);
  });

  it("reports overflow again in a later session", async () => {
    let resolveKeyterms = deferKeyterms();
    let pending = start();
    sendChunk(1, AUDIO_BUFFER_MAX_BYTES + 1);
    resolveKeyterms([]);
    await pending;
    await stop();

    resolveKeyterms = deferKeyterms();
    pending = start();
    sendChunk(2, AUDIO_BUFFER_MAX_BYTES + 1);
    resolveKeyterms([]);
    await pending;
    expect(overflowErrors()).toHaveLength(2);
  });

  it("does not report a provider-side overflow again in the same session", async () => {
    const resolveKeyterms = deferKeyterms();
    const pending = start();
    for (let i = 0; i <= AUDIO_BUFFER_MAX_CHUNKS; i++) sendChunk(1, 10);
    resolveKeyterms([]);
    await pending;
    expect(overflowErrors()).toHaveLength(1);

    shared.eventCallback!({
      type: "error",
      error: { severity: "transient", code: AUDIO_BUFFER_OVERFLOW_CODE },
    });
    expect(overflowErrors()).toHaveLength(1);
  });

  it("forwards a provider-side overflow when the pre-start buffer did not overflow", async () => {
    await start();
    shared.eventCallback!({
      type: "error",
      error: { severity: "transient", code: AUDIO_BUFFER_OVERFLOW_CODE },
    });
    shared.eventCallback!({
      type: "error",
      error: { severity: "transient", code: AUDIO_BUFFER_OVERFLOW_CODE },
    });
    expect(overflowErrors()).toHaveLength(1);
  });

  it("forwards audio directly once the session is running, and none after it stops", async () => {
    await start();
    shared.calls = [];
    sendChunk(9);
    expect(shared.calls).toEqual(["chunk:9"]);

    await stop();
    sendChunk(10);
    expect(shared.calls.filter((c) => c.startsWith("chunk:"))).toEqual(["chunk:9"]);
  });
});

describe("voiceInput — keyterm target", () => {
  let cleanup: () => void;
  const ptyClient = {
    hasTerminal: vi.fn((id: string) => id === "t-1"),
    getTerminalProjectId: vi.fn((id: string) => (id === "t-1" ? "proj-a" : null)),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    shared.calls = [];
    shared.assembleKeyterms = null;
    shared.eventCallback = null;
    shared.viewProjectId = "proj-a";
    shared.voiceInput = {};
    shared.vocabularies = { "proj-a": ["PtyClient"], "proj-b": ["BravoTerm"] };
    shared.correctionDictionary = null;
    sender.destroyed = false;
    fakeEvent.sender = makeSender();
    const win = { webContents: { send: vi.fn() }, isDestroyed: vi.fn(() => false) };
    cleanup = registerVoiceInputHandlers({
      mainWindow: win as unknown as Electron.BrowserWindow,
      ptyClient,
    } as unknown as Parameters<typeof registerVoiceInputHandlers>[0]);
  });

  afterEach(() => {
    cleanup?.();
  });

  // Mints a session id as start() does and maps the outcome the same way, but
  // a start main refuses still rejects.
  const startWith = (options: unknown): Promise<StartResult> => {
    currentSessionId = `session-${nextSessionNumber++}`;
    return (
      getHandler("voice-input:start")(fakeEvent, currentSessionId, options) as Promise<StartOutcome>
    ).then((outcome) =>
      outcome.status === "started"
        ? { ok: true }
        : {
            ok: false,
            error: outcome.status === "failed" ? outcome.error : "Voice session superseded",
          }
    );
  };
  const assemblyOpts = () => vi.mocked(assembleKeyterms).mock.calls[0]?.[0];

  it("reads keyterms from the terminal being dictated into, under its project's name", async () => {
    await expect(startWith({ terminalId: "t-1" })).resolves.toEqual({ ok: true });
    expect(assemblyOpts()).toMatchObject({ terminalId: "t-1", projectName: "Alpha" });
  });

  it("sends no automatic hints for a terminal main doesn't track", async () => {
    await expect(startWith({ terminalId: "t-gone" })).resolves.toEqual({ ok: true });
    expect(assembleKeyterms).toHaveBeenCalledTimes(1);
    expect(assemblyOpts()?.terminalId).toBeUndefined();
    expect(assemblyOpts()?.projectName).toBeUndefined();
  });

  it("sends none for a terminal another project owns than the view asking", async () => {
    shared.viewProjectId = "proj-b";
    await expect(startWith({ terminalId: "t-1" })).resolves.toEqual({ ok: true });
    expect(assembleKeyterms).toHaveBeenCalledTimes(1);
    expect(assemblyOpts()?.terminalId).toBeUndefined();
    expect(assemblyOpts()?.projectName).toBeUndefined();
  });

  it("starts without a target, with no automatic hints, not even the current project", async () => {
    vi.mocked(projectStore.getCurrentProject).mockReturnValueOnce({
      id: "proj-g",
      name: "Global",
      path: "/global",
    } as ReturnType<typeof projectStore.getCurrentProject>);
    await expect(startWith(undefined)).resolves.toEqual({ ok: true });
    expect(assemblyOpts()?.terminalId).toBeUndefined();
    expect(assemblyOpts()?.projectName).toBeUndefined();
  });

  const projectTerms = () => Promise.resolve(assemblyOpts()?.projectDictionary);

  it("sends the vocabulary of the project that owns the target terminal", async () => {
    await expect(startWith({ terminalId: "t-1" })).resolves.toEqual({ ok: true });
    expect(await projectTerms()).toEqual(["PtyClient"]);
  });

  it("sends no project's vocabulary for a terminal another project owns than the view", async () => {
    shared.viewProjectId = "proj-b";
    await expect(startWith({ terminalId: "t-1" })).resolves.toEqual({ ok: true });
    expect(await projectTerms()).toEqual([]);
  });

  it("uses the view's project for a panel main doesn't track as a terminal", async () => {
    shared.viewProjectId = "proj-b";
    await expect(startWith({ terminalId: "browser-1" })).resolves.toEqual({ ok: true });
    expect(await projectTerms()).toEqual(["BravoTerm"]);
  });

  it("starts with the global dictionary alone when the vocabulary can't be read", async () => {
    shared.viewProjectId = "proj-gone";
    shared.voiceInput = {
      dictionary: [{ term: "GlobalTerm", heardAs: [], source: "manual", addedAt: 0 }],
    };
    await expect(startWith(undefined)).resolves.toEqual({ ok: true });
    expect(await projectTerms()).toEqual([]);
    expect(assemblyOpts()?.customDictionary).toEqual(["GlobalTerm"]);
  });

  it("corrects with the target project's terms ahead of the global dictionary", async () => {
    shared.voiceInput = {
      correctionEnabled: true,
      dictionary: [
        { term: "Global", heardAs: [], source: "manual", addedAt: 0 },
        { term: "ptyclient", heardAs: [], source: "manual", addedAt: 0 },
      ],
    };
    await getHandler("voice-input:correct")(fakeEvent, { rawText: "fix it", terminalId: "t-1" });
    expect(shared.correctionDictionary).toEqual(["PtyClient", "Global"]);

    shared.viewProjectId = "proj-b";
    await getHandler("voice-input:correct")(fakeEvent, { rawText: "fix it", terminalId: "t-1" });
    expect(shared.correctionDictionary).toEqual(["Global", "ptyclient"]);
  });

  it("rejects a malformed start without superseding the one in flight", async () => {
    const resolveKeyterms = deferKeyterms();
    const first = startWith({ terminalId: "t-1" });
    sendChunk(1);
    await vi.waitFor(() => expect(shared.eventCallback).not.toBeNull());

    await expect(startWith({ terminalId: 42 })).rejects.toThrow();
    resolveKeyterms([]);
    await expect(first).resolves.toEqual({ ok: true });
    expect(shared.calls).toEqual(["start", "chunk:1"]);
  });
});
