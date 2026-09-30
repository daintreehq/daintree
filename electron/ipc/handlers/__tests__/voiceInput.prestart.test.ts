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
}));

type ServiceEvent = { type: string; error?: { code: string; severity: string } };

const shared = vi.hoisted(() => ({
  /** Ordered record of calls reaching the service: "start" and "chunk:<first byte>". */
  calls: [] as string[],
  eventCallback: null as ((e: ServiceEvent) => void) | null,
  startResult: { ok: true } as { ok: boolean; error?: string },
  /** When set, svc.start() returns this instead of resolving immediately. */
  startPromise: null as null | Promise<{ ok: boolean; error?: string }>,
  startError: null as null | Error,
  assembleKeyterms: null as null | (() => Promise<string[]>),
}));

vi.mock("../../../services/VoiceTranscriptionService.js", () => ({
  VoiceTranscriptionService: function VoiceTranscriptionService(this: Record<string, unknown>) {
    this.onEvent = function (cb: (e: ServiceEvent) => void) {
      shared.eventCallback = cb;
      return () => {};
    };
    this.start = function () {
      shared.calls.push("start");
      if (shared.startError) return Promise.reject(shared.startError);
      return shared.startPromise ?? Promise.resolve(shared.startResult);
    };
    this.sendAudioChunk = function (chunk: ArrayBuffer) {
      shared.calls.push(`chunk:${new Uint8Array(chunk)[0]}`);
    };
    this.stopGracefully = function () {
      return Promise.resolve();
    };
    this.stop = function () {};
    this.destroy = function () {};
    this.commitParagraphBoundary = function () {};
  },
}));

vi.mock("../../../services/VoiceCorrectionService.js", () => ({
  VoiceCorrectionService: function VoiceCorrectionService(this: Record<string, unknown>) {
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
    get: vi.fn((key: string) =>
      key === "voiceInput" ? { enabled: true, openaiApiKey: "sk-test" } : undefined
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
  },
}));

import { registerVoiceInputHandlers } from "../voiceInput.js";
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

const fakeEvent = {
  sender: {
    once: vi.fn((_event: string, fn: () => void) => {
      sender.onDestroyed = fn;
    }),
    removeListener: vi.fn(),
    isDestroyed: () => sender.destroyed,
  },
} as unknown as Electron.IpcMainInvokeEvent;

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`No handler registered for channel: ${channel}`);
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

function sendChunk(id: number, bytes = 4800) {
  const call = ipcMainMock.on.mock.calls.find(([c]) => c === "voice-input:audio-chunk");
  if (!call) throw new Error("audio-chunk listener not registered");
  const chunk = new Uint8Array(bytes);
  chunk[0] = id;
  (call[1] as (e: unknown, c: ArrayBuffer) => void)({}, chunk.buffer);
}

function start() {
  return getHandler("voice-input:start")(fakeEvent) as Promise<StartResult>;
}

function stop() {
  return getHandler("voice-input:stop")(fakeEvent);
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
    shared.eventCallback = null;
    shared.startResult = { ok: true };
    shared.startPromise = null;
    shared.startError = null;
    shared.assembleKeyterms = null;
    sender.destroyed = false;
    sender.onDestroyed = null;
    sent = [];
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
        (m.payload as { code: string }).code === AUDIO_BUFFER_OVERFLOW_CODE
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

  it("discards held audio when a stop lands before the provider starts", async () => {
    const resolveKeyterms = deferKeyterms();
    const pending = start();
    sendChunk(1);
    await stop();
    resolveKeyterms([]);
    await expect(pending).resolves.toEqual({ ok: false, error: "Voice session superseded" });

    // The next session must not replay the cancelled session's audio.
    shared.assembleKeyterms = null;
    const next = start();
    sendChunk(2);
    await expect(next).resolves.toEqual({ ok: true });
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
    await expect(pending).rejects.toThrow("boom");

    shared.startError = null;
    sendChunk(2);
    await start();
    expect(shared.calls).toEqual(["start", "chunk:1", "chunk:2", "start"]);
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

    sendChunk(2);
    expect(shared.calls).toEqual(["start", "chunk:1", "chunk:2"]);
  });

  it("drops the newest audio past the chunk cap and reports it once", async () => {
    const resolveKeyterms = deferKeyterms();
    const pending = start();
    for (let i = 0; i < AUDIO_BUFFER_MAX_CHUNKS + 5; i++) sendChunk(i % 256, 1000);

    expect(overflowErrors()).toHaveLength(1);
    expect(overflowErrors()[0]!.payload).toMatchObject({ severity: "transient" });

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
    // 3 × 40KB fits under 150KB; the 4th would exceed it, and so would the 5th.
    for (let i = 1; i <= 5; i++) sendChunk(i, size);
    expect(overflowErrors()).toHaveLength(1);

    resolveKeyterms([]);
    await pending;
    expect(shared.calls).toEqual(["start", "chunk:1", "chunk:2", "chunk:3"]);
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

  it("forwards audio directly when no start is in flight", async () => {
    await start();
    await stop();
    shared.calls = [];
    sendChunk(9);
    expect(shared.calls).toEqual(["chunk:9"]);
  });
});
