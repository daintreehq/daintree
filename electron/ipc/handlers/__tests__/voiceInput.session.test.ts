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
  /** Settles a deferred drain, as the real provider's stop() does. */
  endDrain: null as null | (() => void),
  /** Every signal the correction service was bound to, in order. */
  signals: [] as Array<AbortSignal | null>,
  assembleKeyterms: null as null | (() => Promise<string[]>),
  /** Project registered per sender id, as the view registry would answer. */
  projects: new Map<number, string>(),
  /** Every app view, as getAllAppWebContents would list them. */
  appViews: [] as unknown[],
  /** The window each view lives in, by sender id, and the view each window shows. */
  windowOf: new Map<number, Record<string, unknown>>(),
  shownIn: new Map<Record<string, unknown>, unknown>(),
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
      shared.endDrain?.();
    };
    this.destroy = function () {
      shared.endDrain?.();
    };
    this.commitParagraphBoundary = function () {
      shared.calls.push("commit");
    };
  },
}));

vi.mock("../../../services/VoiceCorrectionService.js", () => ({
  VoiceCorrectionService: function VoiceCorrectionService(this: Record<string, unknown>) {
    this.setSessionSignal = function (signal: AbortSignal | null) {
      shared.signals.push(signal);
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
    getAllAppWebContents: vi.fn(() => shared.appViews),
    getWindowForWebContents: vi.fn((wc: { id: number }) => shared.windowOf.get(wc.id) ?? null),
    getAppWebContents: vi.fn((win: Record<string, unknown>) => shared.shownIn.get(win)),
  };
});

vi.mock("../../../services/menuAccelerators.js", () => ({
  isDictationKey: vi.fn((input: { key: string }) => input.key === "."),
}));

import {
  registerVoiceInputHandlers,
  getLiveVoiceSession,
  claimDictationKey,
} from "../voiceInput.js";
import { CHANNELS } from "../../channels.js";
import { claimPageDictationKey } from "../../../services/voice/pageDictationKey.js";
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

// The view each session id was started from, which streams its audio.
const owners = new Map<string, FakeSender>();

function start(sender: FakeSender, sessionId: string) {
  owners.set(sessionId, sender);
  return getHandler(CHANNELS.VOICE_INPUT_START)({ sender }, sessionId);
}

function stop(sender: FakeSender, sessionId: string) {
  return getHandler(CHANNELS.VOICE_INPUT_STOP)({ sender }, sessionId);
}

function flush(sender: FakeSender, sessionId: string) {
  return getHandler(CHANNELS.VOICE_INPUT_FLUSH_PARAGRAPH)({ sender }, sessionId);
}

function sendChunk(sessionId: string, id: number, from = owners.get(sessionId) ?? makeSender()) {
  const call = ipcMainMock.on.mock.calls.find(([c]) => c === CHANNELS.VOICE_INPUT_AUDIO_CHUNK);
  if (!call) throw new Error("audio-chunk listener not registered");
  const chunk = new Uint8Array(4800);
  chunk[0] = id;
  (call[1] as (e: unknown, s: unknown, c: ArrayBuffer) => void)(
    { sender: from },
    sessionId,
    chunk.buffer
  );
}

/** An event from the current provider, tagged as the real service tags it. */
function emit(event: ServiceEvent, sessionId = shared.providerSessionId ?? undefined) {
  for (const listener of [...shared.listeners]) listener({ ...event, sessionId });
}

// Lets a pending start run through its preparation to wherever it waits.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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
  shared.endDrain = resolve;
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
    shared.endDrain = null;
    shared.signals = [];
    shared.assembleKeyterms = null;
    shared.projects.clear();
    owners.clear();
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

  it("drains another view's session before starting, keeping its text with its owner (#14600)", async () => {
    await start(ownerA, "a");
    const finishDrain = deferDrain();
    const startingB = start(ownerB, "b");
    // B's capture is already streaming; A's hasn't heard it lost the session.
    sendChunk("b", 1);
    sendChunk("a", 9);
    sendChunk("b", 2);
    emit({ type: "complete", text: "last words" });
    await settle();

    expect(shared.calls).toEqual(["start:a", "drain"]);
    expect(ended(ownerA)).toEqual([]);
    expect(getLiveVoiceSession()?.sessionId).toBe("b");

    finishDrain();
    await expect(startingB).resolves.toEqual({ status: "started" });
    sendChunk("a", 8);
    sendChunk("b", 3);

    expect(shared.calls).toEqual(["start:a", "drain", "start:b", "chunk:1", "chunk:2", "chunk:3"]);
    expect(received(ownerA).map((m) => m.payload)).toEqual([
      { sessionId: "a", status: "finishing" },
      { sessionId: "a", text: "last words", willCorrect: false },
    ]);
    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "superseded" }]);
    expect(received(ownerB)).toEqual([]);
    expect(ended(ownerB)).toEqual([]);
  });

  it("lets the old owner's stop join the drain a newer start began", async () => {
    await start(ownerA, "a");
    const finishDrain = deferDrain();
    const startingB = start(ownerB, "b");
    let stopped = false;
    const stopping = stop(ownerA, "a").then(() => {
      stopped = true;
    });
    // A flush from the old owner never reaches the provider it is draining.
    await flush(ownerA, "a");
    await settle();
    expect(stopped).toBe(false);
    expect(shared.calls).toEqual(["start:a", "drain"]);

    finishDrain();
    await Promise.all([stopping, startingB]);
    expect(shared.calls).toEqual(["start:a", "drain", "start:b"]);
  });

  it("waits on the drain when a third start replaces one still waiting for it", async () => {
    const ownerC = makeSender();
    await start(ownerA, "a");
    const finishDrain = deferDrain();
    const startingB = start(ownerB, "b");
    await settle();
    const startingC = start(ownerC, "c");
    await settle();
    expect(shared.calls).toEqual(["start:a", "drain"]);

    finishDrain();
    await expect(startingB).resolves.toEqual({ status: "superseded" });
    await expect(startingC).resolves.toEqual({ status: "started" });
    expect(shared.calls).toEqual(["start:a", "drain", "start:c"]);
    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "superseded" }]);
    expect(ended(ownerB)).toEqual([{ sessionId: "b", reason: "superseded" }]);
  });

  it("ends a waiting start and its pending stop when a third start replaces it", async () => {
    const ownerC = makeSender();
    await start(ownerA, "a");
    const finishDrain = deferDrain();
    const startingB = start(ownerB, "b");
    sendChunk("b", 1);
    await settle();
    const stoppingB = stop(ownerB, "b");
    const startingC = start(ownerC, "c");
    sendChunk("c", 2);

    // B never reached a provider, so its stop has nothing to drain.
    await expect(stoppingB).resolves.toEqual({ rawText: null });
    expect(ended(ownerB)).toEqual([{ sessionId: "b", reason: "superseded" }]);
    expect(shared.calls).toEqual(["start:a", "drain"]);

    finishDrain();
    await expect(startingB).resolves.toEqual({ status: "superseded" });
    await expect(startingC).resolves.toEqual({ status: "started" });
    expect(shared.calls).toEqual(["start:a", "drain", "start:c", "chunk:2"]);
  });

  it("binds the new session's correction signal only once the drain hands over", async () => {
    await start(ownerA, "a");
    const signalA = shared.signals.at(-1)!;
    const finishDrain = deferDrain();
    const startingB = start(ownerB, "b");
    await settle();

    // A's file-link detection during its drain still runs under A's signal.
    expect(shared.signals.at(-1)).toBe(signalA);
    expect(signalA.aborted).toBe(false);

    finishDrain();
    await startingB;
    const signalB = shared.signals.at(-1);
    expect(signalA.aborted).toBe(true);
    expect(signalB).toBeInstanceOf(AbortSignal);
    expect(signalB).not.toBe(signalA);
    expect(signalB?.aborted).toBe(false);
  });

  it("starts the waiting session once a draining view goes away", async () => {
    await start(ownerA, "a");
    deferDrain();
    const startingB = start(ownerB, "b");
    await settle();
    expect(shared.calls).toEqual(["start:a", "drain"]);
    ownerA.destroy();

    await expect(startingB).resolves.toEqual({ status: "started" });
    expect(shared.calls).toEqual(["start:a", "drain", "hard-stop", "start:b"]);
    expect(getLiveVoiceSession()?.sessionId).toBe("b");
  });

  it("cancels a start waiting on a drain when its stop lands before any audio", async () => {
    await start(ownerA, "a");
    const finishDrain = deferDrain();
    const startingB = start(ownerB, "b");
    await settle();
    await stop(ownerB, "b");
    finishDrain();

    await expect(startingB).resolves.toEqual({ status: "superseded" });
    expect(shared.calls).toEqual(["start:a", "drain"]);
    expect(ended(ownerB)).toEqual([{ sessionId: "b", reason: "cancelled" }]);
    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "superseded" }]);
  });

  it("transcribes what a start waiting on a drain heard when its stop lands", async () => {
    await start(ownerA, "a");
    const finishDrain = deferDrain();
    const startingB = start(ownerB, "b");
    sendChunk("b", 1);
    await settle();
    const stoppingB = stop(ownerB, "b");
    await settle();
    expect(shared.calls).toEqual(["start:a", "drain"]);
    finishDrain();
    shared.drain = null;

    await Promise.all([startingB, stoppingB]);
    expect(shared.calls).toEqual(["start:a", "drain", "start:b", "chunk:1", "drain"]);
    expect(ended(ownerB)).toEqual([{ sessionId: "b", reason: "stopped" }]);
  });

  it("ignores audio, stop and flush from another view carrying the live session's id", async () => {
    await start(ownerA, "a");
    sendChunk("a", 1, ownerB);
    await flush(ownerB, "a");
    await expect(stop(ownerB, "a")).resolves.toEqual({ rawText: null });

    expect(shared.calls).toEqual(["start:a"]);
    expect(getLiveVoiceSession()?.sessionId).toBe("a");
    expect(ended(ownerA)).toEqual([]);
  });

  it("refuses a start reusing the id of a session still draining", async () => {
    await start(ownerA, "a");
    const finishDrain = deferDrain();
    const startingB = start(ownerB, "b");

    await expect(start(ownerB, "a")).rejects.toThrow("Voice session already started");
    expect(getLiveVoiceSession()?.sessionId).toBe("b");
    finishDrain();
    await expect(startingB).resolves.toEqual({ status: "started" });
  });

  it("starts the waiting session even when the drain it waits on fails", async () => {
    await start(ownerA, "a");
    let failDrain!: (error: Error) => void;
    shared.drain = new Promise<void>((_resolve, reject) => {
      failDrain = reject;
    });
    const startingB = start(ownerB, "b");
    await settle();
    failDrain(new Error("socket closed"));

    await expect(startingB).resolves.toEqual({ status: "started" });
    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "failed" }]);
    expect(shared.calls).toEqual(["start:a", "drain", "start:b"]);
  });

  it("ends both the draining and the waiting session when the handlers go away", async () => {
    await start(ownerA, "a");
    deferDrain();
    const startingB = start(ownerB, "b");
    await settle();
    cleanup();

    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "cancelled" }]);
    expect(ended(ownerB)).toEqual([{ sessionId: "b", reason: "cancelled" }]);
    await expect(startingB).resolves.toEqual({ status: "superseded" });
    expect(getLiveVoiceSession()).toBeNull();
  });

  it("ends a session the same view replaced at once, retiring its provider", async () => {
    await start(ownerA, "a");
    await start(ownerA, "a2");

    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "superseded" }]);
    expect(shared.calls).toEqual(["start:a", "hard-stop", "start:a2"]);
    expect(getLiveVoiceSession()?.sessionId).toBe("a2");
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

  it("starts a newer session only after an older stop's drain finishes", async () => {
    await start(ownerA, "a");
    const finishDrain = deferDrain();
    const stopping = stop(ownerA, "a");
    const startingB = start(ownerB, "b");
    sendChunk("b", 1);
    await settle();
    expect(shared.calls).toEqual(["start:a", "drain"]);

    finishDrain();
    await Promise.all([stopping, startingB]);

    // The stop asked for is the reason it ended; it was never cut short.
    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "stopped" }]);
    expect(shared.calls).toEqual(["start:a", "drain", "start:b", "chunk:1"]);
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

describe("voiceInput — a session live in another view (#14601)", () => {
  let cleanup: () => void;
  let ownerA: FakeSender;
  let viewB: FakeSender;
  let viewC: FakeSender;
  type FakeWindow = {
    isDestroyed: () => boolean;
    isMinimized: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  };
  // A's window, and B's own window.
  let winA: FakeWindow;
  let winB: FakeWindow;
  const makeWindow = (): FakeWindow => ({
    isDestroyed: () => false,
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  });

  const liveUpdates = (view: FakeSender) =>
    view.sent.filter((m) => m.channel === CHANNELS.VOICE_INPUT_LIVE_SESSION).map((m) => m.payload);
  const lastLive = (view: FakeSender) =>
    liveUpdates(view).at(-1) as { revision: number; session: unknown } | undefined;
  const sentOn = (view: FakeSender, channel: string) =>
    view.sent.filter((m) => m.channel === channel).map((m) => m.payload);
  const invoke = (channel: string, sender: FakeSender, ...args: unknown[]) =>
    getHandler(channel)({ sender }, ...args);

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
    viewB = makeSender();
    viewC = makeSender();
    shared.appViews = [ownerA, viewB, viewC];
    shared.projects.set(ownerA.id, "project-a");
    vi.mocked(projectStore.getProjectById).mockImplementation((id: string) =>
      id === "project-a"
        ? ({ id, name: "Alpha", path: "/alpha" } as ReturnType<typeof projectStore.getProjectById>)
        : null
    );
    winA = makeWindow();
    winB = makeWindow();
    shared.windowOf = new Map([
      [ownerA.id, winA],
      [viewC.id, winA],
      [viewB.id, winB],
    ]);
    shared.shownIn = new Map<Record<string, unknown>, unknown>([
      [winA, ownerA],
      [winB, viewB],
    ]);
    cleanup = registerVoiceInputHandlers({
      mainWindow: { webContents: { send: vi.fn() }, isDestroyed: () => false },
    } as unknown as Parameters<typeof registerVoiceInputHandlers>[0]);
  });

  afterEach(() => {
    cleanup?.();
    shared.appViews = [];
    shared.windowOf = new Map();
    shared.shownIn = new Map();
    vi.mocked(projectStore.getProjectById).mockReset();
    vi.mocked(projectStore.getProjectById).mockReturnValue(null);
  });

  it("tells every other view where the live session runs, and its owner nothing", async () => {
    const idle = (await invoke(CHANNELS.VOICE_INPUT_GET_LIVE_SESSION, viewB)) as {
      revision: number;
    };
    await start(ownerA, "a");

    expect(lastLive(viewB)!.revision).toBeGreaterThan(idle.revision);
    const elsewhere = { sessionId: "a", projectId: "project-a", projectName: "Alpha" };
    expect(lastLive(viewB)?.session).toEqual(elsewhere);
    expect(lastLive(viewC)?.session).toEqual(elsewhere);
    expect(lastLive(ownerA)?.session).toBeNull();
  });

  it("tells every view once the session is over, with a newer revision", async () => {
    await start(ownerA, "a");
    const during = lastLive(viewB)!;

    await stop(ownerA, "a");

    expect(lastLive(viewB)).toEqual({ revision: expect.any(Number), session: null });
    expect(lastLive(viewB)!.revision).toBeGreaterThan(during.revision);
    expect(lastLive(viewC)?.session).toBeNull();
  });

  it("tells every view when the owner's view goes away", async () => {
    await start(ownerA, "a");
    ownerA.destroy();

    expect(lastLive(viewB)?.session).toBeNull();
  });

  it("gives a view that boots mid-session the snapshot it missed", async () => {
    await start(ownerA, "a");
    const latecomer = makeSender();

    const pulled = await invoke(CHANNELS.VOICE_INPUT_GET_LIVE_SESSION, latecomer);

    expect(liveUpdates(latecomer)).toEqual([]);
    expect(pulled).toEqual({
      revision: lastLive(viewB)!.revision,
      session: { sessionId: "a", projectId: "project-a", projectName: "Alpha" },
    });
    expect(await invoke(CHANNELS.VOICE_INPUT_GET_LIVE_SESSION, ownerA)).toMatchObject({
      session: null,
    });
  });

  it("asks the owner to stop when another view's dictation key names its session", async () => {
    await start(ownerA, "a");

    expect(await invoke(CHANNELS.VOICE_INPUT_STOP_LIVE, viewB, "a")).toBe(true);

    expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([{ sessionId: "a" }]);
    // The owner runs the stop, so its drain keeps the text; main stops nothing itself.
    expect(shared.calls).not.toContain("drain");
    expect(shared.calls).not.toContain("hard-stop");
  });

  it("ignores a stop for a session that isn't the live one", async () => {
    await start(ownerA, "a");

    expect(await invoke(CHANNELS.VOICE_INPUT_STOP_LIVE, viewB, "old")).toBe(false);
    await stop(ownerA, "a");
    expect(await invoke(CHANNELS.VOICE_INPUT_STOP_LIVE, viewB, "a")).toBe(false);

    expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([]);
  });

  const reveal = { sessionId: "a", workspaceId: "project-a" };

  it("brings the owner's window forward and asks the owner to show its panel", async () => {
    winA.isMinimized.mockReturnValue(true);
    await start(ownerA, "a");

    expect(await invoke(CHANNELS.VOICE_INPUT_REVEAL_LIVE, viewB, "a")).toBe(true);

    expect(winA.restore).toHaveBeenCalled();
    expect(winA.show).toHaveBeenCalled();
    expect(winA.focus).toHaveBeenCalled();
    expect(winB.focus).not.toHaveBeenCalled();
    expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([reveal]);
    // On screen in its window already, so nothing there switches.
    expect(sentOn(viewB, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([]);
    expect(sentOn(viewC, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([]);
  });

  it("has the owner's window, not the asking one, switch when another view shows there", async () => {
    shared.shownIn.set(winA, viewC);
    await start(ownerA, "a");

    await invoke(CHANNELS.VOICE_INPUT_REVEAL_LIVE, viewB, "a");

    // The owner's own window switches, so its cached view comes forward rather
    // than being released to open the workspace somewhere else.
    expect(sentOn(viewC, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([reveal]);
    expect(sentOn(viewB, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([]);
    expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([reveal]);
    expect(winA.restore).not.toHaveBeenCalled();
  });

  it("reveals nothing for a session that isn't the live one", async () => {
    await start(ownerA, "a");

    expect(await invoke(CHANNELS.VOICE_INPUT_REVEAL_LIVE, viewB, "old")).toBe(false);
    expect(winA.focus).not.toHaveBeenCalled();
    expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([]);
  });

  describe("the dictation key on a page that isn't an app view", () => {
    const press = (overrides: Partial<Electron.Input> = {}) =>
      ({ type: "keyDown", key: ".", isAutoRepeat: false, ...overrides }) as Electron.Input;

    it("asks the owner to stop and takes the key from the page", async () => {
      await start(ownerA, "a");

      expect(claimDictationKey(press())).toBe(true);
      expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([{ sessionId: "a" }]);
    });

    it("takes a held key's repeats without asking again", async () => {
      await start(ownerA, "a");

      expect(claimDictationKey(press({ isAutoRepeat: true }))).toBe(true);
      expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([]);
    });

    it("leaves the key to the page when nothing is running", async () => {
      expect(claimDictationKey(press())).toBe(false);
      expect(claimDictationKey(press({ isAutoRepeat: true }))).toBe(false);

      await start(ownerA, "a");
      await stop(ownerA, "a");
      expect(claimDictationKey(press())).toBe(false);
      expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([]);
    });

    it("leaves every other key to the page", async () => {
      await start(ownerA, "a");

      expect(claimDictationKey(press({ key: "k" }))).toBe(false);
      expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([]);
    });

    it("is what the page key hooks ask while the handlers are registered", async () => {
      await start(ownerA, "a");

      expect(claimPageDictationKey(press())).toBe(true);
      expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([{ sessionId: "a" }]);

      cleanup();
      cleanup = () => {};
      expect(claimPageDictationKey(press())).toBe(false);
    });
  });
});
