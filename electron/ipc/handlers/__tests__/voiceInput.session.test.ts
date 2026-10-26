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

type ServiceEvent = { type: string; sessionId?: string; [key: string]: unknown };

const shared = vi.hoisted(() => ({
  /** Ordered record of what reached the service. */
  calls: [] as string[],
  listeners: new Set<(e: ServiceEvent) => void>(),
  /** The session the fake provider was last started for; its events carry it. */
  providerSessionId: null as string | null,
  startResult: { ok: true } as { ok: boolean; error?: string },
  /** When set, stopGracefully() waits on this instead of resolving at once. */
  drain: null as null | Promise<void>,
  assembleKeyterms: null as null | (() => Promise<string[]>),
  /** Project registered per sender id, as the view registry would answer. */
  projects: new Map<number, string>(),
}));

vi.mock("../../../services/VoiceTranscriptionService.js", () => ({
  VoiceTranscriptionService: function VoiceTranscriptionService(this: Record<string, unknown>) {
    this.onEvent = function (cb: (e: ServiceEvent) => void) {
      shared.listeners.add(cb);
      return () => shared.listeners.delete(cb);
    };
    this.start = function (_settings: unknown, sessionId: string) {
      shared.providerSessionId = sessionId;
      shared.calls.push(`start:${sessionId}`);
      return Promise.resolve(shared.startResult);
    };
    this.sendAudioChunk = function (chunk: ArrayBuffer) {
      shared.calls.push(`chunk:${new Uint8Array(chunk)[0]}`);
    };
    this.stopGracefully = function () {
      shared.calls.push("drain");
      return shared.drain ?? Promise.resolve();
    };
    this.stop = function () {
      shared.calls.push("hard-stop");
    };
    this.destroy = function () {};
    this.commitParagraphBoundary = function () {
      shared.calls.push("commit");
    };
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
    getProjectById: vi.fn(() => null),
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

vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../window/webContentsRegistry.js")>();
  return {
    ...actual,
    getProjectForWebContents: vi.fn((id: number) => shared.projects.get(id) ?? null),
  };
});

import { registerVoiceInputHandlers, getLiveVoiceSession } from "../voiceInput.js";
import { CHANNELS } from "../../channels.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { AUDIO_BUFFER_MAX_CHUNKS } from "../../../services/voice/TranscriptionProvider.js";

type Sent = { channel: string; payload: unknown };

const mainWindowDestroyed = { value: false };

// A fresh WebContents per view, as in production: the shared destroyed-watcher
// remembers every one it has seen go.
let nextSenderId = 100;
function makeSender() {
  const destroyedListeners = new Set<() => void>();
  const sender = {
    id: nextSenderId++,
    destroyed: false,
    sent: [] as Sent[],
    once: vi.fn((_event: string, fn: () => void) => {
      destroyedListeners.add(fn);
    }),
    removeListener: vi.fn((_event: string, fn: () => void) => {
      destroyedListeners.delete(fn);
    }),
    isDestroyed: () => sender.destroyed,
    send: vi.fn((channel: string, payload: unknown) => {
      sender.sent.push({ channel, payload });
    }),
    destroy() {
      sender.destroyed = true;
      for (const fn of [...destroyedListeners]) {
        destroyedListeners.delete(fn);
        fn();
      }
    },
  };
  return sender;
}
type FakeSender = ReturnType<typeof makeSender>;

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`No handler registered for channel: ${channel}`);
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

function start(sender: FakeSender, sessionId: string) {
  return getHandler(CHANNELS.VOICE_INPUT_START)({ sender }, sessionId);
}

function stop(sender: FakeSender, sessionId: string) {
  return getHandler(CHANNELS.VOICE_INPUT_STOP)({ sender }, sessionId);
}

function flush(sender: FakeSender, sessionId: string) {
  return getHandler(CHANNELS.VOICE_INPUT_FLUSH_PARAGRAPH)({ sender }, sessionId);
}

function sendChunk(sessionId: string, id: number, bytes = 4800) {
  const call = ipcMainMock.on.mock.calls.find(([c]) => c === CHANNELS.VOICE_INPUT_AUDIO_CHUNK);
  if (!call) throw new Error("audio-chunk listener not registered");
  const chunk = new Uint8Array(bytes);
  chunk[0] = id;
  (call[1] as (e: unknown, s: unknown, c: ArrayBuffer) => void)({}, sessionId, chunk.buffer);
}

/** An event from the current provider, tagged as the real service tags it. */
function emit(event: ServiceEvent, sessionId = shared.providerSessionId ?? undefined) {
  for (const listener of [...shared.listeners]) listener({ ...event, sessionId });
}

function deferKeyterms() {
  let resolve!: (terms: string[]) => void;
  const promise = new Promise<string[]>((r) => {
    resolve = r;
  });
  shared.assembleKeyterms = () => promise;
  return (terms: string[] = []) => resolve(terms);
}

function deferDrain() {
  let resolve!: () => void;
  shared.drain = new Promise<void>((r) => {
    resolve = r;
  });
  return () => resolve();
}

// What the view received, minus its session-ended notice.
const received = (sender: FakeSender) =>
  sender.sent.filter((m) => m.channel !== CHANNELS.VOICE_INPUT_SESSION_ENDED);

const ended = (sender: FakeSender) =>
  sender.sent.filter((m) => m.channel === CHANNELS.VOICE_INPUT_SESSION_ENDED).map((m) => m.payload);

describe("voiceInput — session identity", () => {
  let appSent: Sent[];
  let cleanup: () => void;
  let ownerA: FakeSender;
  let ownerB: FakeSender;

  beforeEach(() => {
    vi.clearAllMocks();
    shared.calls = [];
    shared.listeners.clear();
    shared.providerSessionId = null;
    shared.startResult = { ok: true };
    shared.drain = null;
    shared.assembleKeyterms = null;
    shared.projects.clear();
    ownerA = makeSender();
    ownerB = makeSender();
    appSent = [];
    mainWindowDestroyed.value = false;
    const win = {
      webContents: {
        send: vi.fn((channel: string, payload: unknown) => appSent.push({ channel, payload })),
      },
      isDestroyed: vi.fn(() => mainWindowDestroyed.value),
    };
    cleanup = registerVoiceInputHandlers({
      mainWindow: win as unknown as Electron.BrowserWindow,
    } as Parameters<typeof registerVoiceInputHandlers>[0]);
  });

  afterEach(() => {
    cleanup?.();
  });

  it("records the view and project that own the live session", async () => {
    shared.projects.set(ownerA.id, "project-a");
    await start(ownerA, "a");

    expect(getLiveVoiceSession()).toEqual({
      sessionId: "a",
      webContentsId: ownerA.id,
      projectId: "project-a",
    });
  });

  it("sends events to the view that started the session, never the first window's", async () => {
    await start(ownerB, "b");
    emit({ type: "status", status: "recording" });
    emit({ type: "delta", text: "hello" });

    expect(received(ownerB).map((m) => m.payload)).toEqual([
      { sessionId: "b", status: "recording" },
      { sessionId: "b", text: "hello" },
    ]);
    expect(received(ownerA)).toEqual([]);
    expect(appSent).toEqual([]);
  });

  it("keeps delivering to the starting view after the main window is destroyed", async () => {
    await start(ownerB, "b");
    mainWindowDestroyed.value = true;
    emit({ type: "delta", text: "still arriving" });

    expect(received(ownerB).map((m) => m.payload)).toContainEqual({
      sessionId: "b",
      text: "still arriving",
    });
  });

  it("starts file links and context from the starting view's project, not the current one", async () => {
    shared.projects.set(ownerB.id, "project-b");
    await start(ownerB, "b");

    expect(projectStore.getProjectById).toHaveBeenCalledWith("project-b");
    expect(projectStore.getCurrentProject).not.toHaveBeenCalled();
  });

  it("ignores audio carrying an id that isn't the live session's", async () => {
    const resolveKeyterms = deferKeyterms();
    const pending = start(ownerA, "a");
    // While starting, another session's audio must not take buffer space.
    for (let i = 0; i < AUDIO_BUFFER_MAX_CHUNKS + 5; i++) sendChunk("b", 9);
    sendChunk("a", 1);
    resolveKeyterms();
    await pending;

    sendChunk("b", 2);
    sendChunk("a", 3);

    expect(shared.calls).toEqual(["start:a", "chunk:1", "chunk:3"]);
    expect(received(ownerA).some((m) => m.channel === CHANNELS.VOICE_INPUT_ERROR)).toBe(false);
  });

  it("ignores a stop carrying an id that isn't the live session's", async () => {
    const resolveKeyterms = deferKeyterms();
    const pending = start(ownerA, "a");
    // Neither a pending start nor a running session is cancelled by it.
    await expect(stop(ownerB, "b")).resolves.toEqual({ rawText: null });
    resolveKeyterms();
    await expect(pending).resolves.toEqual({ status: "started" });
    await expect(stop(ownerB, "b")).resolves.toEqual({ rawText: null });

    expect(shared.calls).toEqual(["start:a"]);
    expect(getLiveVoiceSession()?.sessionId).toBe("a");
    expect(ended(ownerA)).toEqual([]);
    emit({ type: "delta", text: "still here" });
    expect(received(ownerA).map((m) => m.payload)).toContainEqual({
      sessionId: "a",
      text: "still here",
    });
  });

  it("ignores a flush carrying an id that isn't the live session's", async () => {
    await start(ownerA, "a");

    await flush(ownerB, "b");
    expect(shared.calls).not.toContain("commit");

    await flush(ownerA, "a");
    expect(shared.calls.filter((c) => c === "commit")).toHaveLength(1);
  });

  it("does not flush a session that hasn't reached its provider", async () => {
    const resolveKeyterms = deferKeyterms();
    const pending = start(ownerA, "a");
    // The service is loaded and listening, but its provider isn't this session's yet.
    await vi.waitFor(() => expect(shared.listeners.size).toBe(1));
    await flush(ownerA, "a");
    resolveKeyterms();
    await pending;

    expect(shared.calls).toEqual(["start:a"]);
  });

  it("tags every forwarded event with its session id", async () => {
    await start(ownerA, "a");
    emit({ type: "status", status: "recording" });
    emit({ type: "error", error: { severity: "transient", code: "rate_limit", message: "slow" } });

    expect(received(ownerA)).toEqual([
      { channel: CHANNELS.VOICE_INPUT_STATUS, payload: { sessionId: "a", status: "recording" } },
      {
        channel: CHANNELS.VOICE_INPUT_ERROR,
        payload: {
          sessionId: "a",
          error: { severity: "transient", code: "rate_limit", message: "slow" },
        },
      },
    ]);
  });

  it("drops events tagged with another session", async () => {
    await start(ownerA, "a");
    emit({ type: "delta", text: "ghost" }, "older-session");

    expect(received(ownerA)).toEqual([]);
  });

  it("ends a running session as stopped once its drain finishes, forwarding the drain's text", async () => {
    await start(ownerA, "a");
    const finishDrain = deferDrain();
    const stopping = stop(ownerA, "a");
    emit({ type: "complete", text: "last words" });
    expect(ended(ownerA)).toEqual([]);

    finishDrain();
    await expect(stopping).resolves.toEqual({ rawText: null });

    expect(received(ownerA).map((m) => m.payload)).toContainEqual({
      sessionId: "a",
      text: "last words",
      willCorrect: false,
    });
    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "stopped" }]);
    expect(getLiveVoiceSession()).toBeNull();
  });

  it("drains once when the same stop arrives twice", async () => {
    await start(ownerA, "a");
    const finishDrain = deferDrain();
    const first = stop(ownerA, "a");
    const second = stop(ownerA, "a");
    finishDrain();
    await Promise.all([first, second]);

    expect(shared.calls.filter((c) => c === "drain")).toHaveLength(1);
    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "stopped" }]);
  });

  it("ends a session stopped before its provider started as cancelled", async () => {
    const resolveKeyterms = deferKeyterms();
    const pending = start(ownerA, "a");
    await stop(ownerA, "a");
    resolveKeyterms();

    await expect(pending).resolves.toEqual({ status: "superseded" });
    expect(shared.calls).toEqual([]);
    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "cancelled" }]);
  });

  it("ends the previous session as superseded and retires its provider", async () => {
    await start(ownerA, "a");
    await start(ownerB, "b");

    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "superseded" }]);
    expect(ended(ownerB)).toEqual([]);
    expect(shared.calls).toEqual(["start:a", "hard-stop", "start:b"]);
    expect(getLiveVoiceSession()?.sessionId).toBe("b");
  });

  it("ends a session as failed when its provider can't start", async () => {
    shared.startResult = { ok: false, error: "OpenAI API key not configured" };

    await expect(start(ownerA, "a")).resolves.toEqual({
      status: "failed",
      error: "OpenAI API key not configured",
    });
    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "failed" }]);
    expect(getLiveVoiceSession()).toBeNull();
  });

  it("ends a running session as failed, once, when its provider dies", async () => {
    await start(ownerA, "a");
    emit({ type: "status", status: "error" });
    emit({ type: "status", status: "idle" });

    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "failed" }]);
    // The terminal status itself still reaches the renderer; nothing after it does.
    expect(received(ownerA).map((m) => m.payload)).toEqual([{ sessionId: "a", status: "error" }]);
    // A stop for it is now for a session that isn't live.
    await stop(ownerA, "a");
    expect(shared.calls).not.toContain("drain");
  });

  it("ends a session as cancelled when its view goes away, stopping its provider", async () => {
    await start(ownerA, "a");
    ownerA.destroy();

    expect(shared.calls).toContain("hard-stop");
    expect(getLiveVoiceSession()).toBeNull();
    // The view is gone, so there is nobody to tell.
    expect(ended(ownerA)).toEqual([]);
  });

  it("leaves a newer session alone when a failed start's view goes away (#14602)", async () => {
    shared.startResult = { ok: false, error: "Connection timed out" };
    await expect(start(ownerA, "a")).resolves.toMatchObject({ status: "failed" });

    shared.startResult = { ok: true };
    await start(ownerB, "b");
    shared.calls = [];
    ownerA.destroy();

    expect(shared.calls).toEqual([]);
    expect(getLiveVoiceSession()?.sessionId).toBe("b");
  });

  it("keeps a newer session's subscription when an older stop's drain finishes after it", async () => {
    await start(ownerA, "a");
    const finishDrain = deferDrain();
    const stopping = stop(ownerA, "a");
    await start(ownerB, "b");
    finishDrain();
    await stopping;

    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "superseded" }]);
    emit({ type: "delta", text: "for b" });
    expect(received(ownerB).map((m) => m.payload)).toContainEqual({
      sessionId: "b",
      text: "for b",
    });
    expect(getLiveVoiceSession()?.sessionId).toBe("b");
  });

  it("refuses a start reusing the live session's id without superseding it", async () => {
    await start(ownerA, "a");

    await expect(start(ownerB, "a")).rejects.toThrow("Voice session already started");
    expect(getLiveVoiceSession()).toMatchObject({ sessionId: "a", webContentsId: ownerA.id });
    expect(ended(ownerA)).toEqual([]);
  });

  it("rejects a start without a session id", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(start(ownerA, "")).rejects.toThrow();
      expect(getLiveVoiceSession()).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });
});
