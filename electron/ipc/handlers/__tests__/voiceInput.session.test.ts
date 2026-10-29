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
  /** Cleanup turned on in the voice settings. */
  correctionEnabled: false,
  /** Dictation turned on in the voice settings; a saved patch writes it. */
  enabled: true,
  /** Every cleanup request that reached the correction service, still open. */
  cleanups: [] as Array<{
    rawText: string;
    signal: AbortSignal | undefined;
    onText: ((text: string) => void) | undefined;
    finish: (text: string) => void;
    /** Settles it as a request that failed, without its signal aborting. */
    fail: () => void;
    /** Settles it as refused by the account, a failure every passage will meet. */
    refuse: (reason: string) => void;
  }>,
  /** The cleanup key in the voice settings. */
  openaiApiKey: "sk-test",
  /** When set, the project vocabulary read waits on this. */
  vocabulary: null as null | Promise<never[]>,
  assembleKeyterms: null as null | (() => Promise<string[]>),
  /** The start context svc.start() was last handed: OpenAI's pending terms. */
  startContext: undefined as undefined | { keyterms?: Promise<string[]> },
  transcriptionProvider: "openai" as "openai" | "deepgram",
  /** What the fake provider counts for the session it was started for. */
  providerStats: { delayTier: "low", droppedConnect: 0, droppedReplay: 0, reconnects: 0 },
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
    this.keytermsNeededToConnect = function (settings: { transcriptionProvider?: string }) {
      return settings.transcriptionProvider === "deepgram";
    };
    this.start = function (
      _settings: unknown,
      sessionId: string,
      context?: { keyterms?: Promise<string[]> }
    ) {
      shared.providerSessionId = sessionId;
      shared.startContext = context;
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
    this.getSessionStats = function (sessionId: string) {
      return sessionId === shared.providerSessionId ? shared.providerStats : null;
    };
  },
}));

vi.mock("../../../services/VoiceCorrectionService.js", () => ({
  VoiceCorrectionService: function VoiceCorrectionService(this: Record<string, unknown>) {
    this.warm = () => Promise.resolve();
    this.preconnect = () => {};
    // Settles as failed once its signal aborts, as a real request does.
    this.correct = function (
      request: { rawText: string },
      _settings: unknown,
      signal?: AbortSignal,
      onText?: (text: string) => void
    ) {
      return new Promise((resolve) => {
        const fail = () =>
          resolve({ action: "no_change", confirmedText: request.rawText, failed: true });
        if (signal?.aborted) return fail();
        signal?.addEventListener("abort", fail, { once: true });
        shared.cleanups.push({
          rawText: request.rawText,
          signal,
          onText,
          finish: (text) =>
            resolve({ action: "replace", confirmedText: text, verdict: "replaced" }),
          fail,
          refuse: (reason) =>
            resolve({
              action: "no_change",
              confirmedText: request.rawText,
              failed: true,
              verdict: "failed",
              cleanupFailure: { reason, provider: "openai" },
            }),
        });
      });
    };
  },
}));

vi.mock("../../../services/projectVoiceDictionary.js", () => ({
  readProjectVoiceDictionary: vi.fn(() => shared.vocabulary ?? Promise.resolve([])),
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProject: vi.fn(() => null),
    getProjectById: vi.fn(() => null),
    getCurrentProjectId: vi.fn(() => null),
  },
}));

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
    get: vi.fn((key: string) =>
      key === "voiceInput"
        ? {
            enabled: shared.enabled,
            openaiApiKey: shared.openaiApiKey,
            deepgramApiKey: "dg-test",
            transcriptionProvider: shared.transcriptionProvider,
            correctionEnabled: shared.correctionEnabled,
          }
        : undefined
    ),
    set: vi.fn((key: string, value: { enabled?: unknown }) => {
      if (key === "voiceInput" && typeof value.enabled === "boolean")
        shared.enabled = value.enabled;
    }),
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
    getShownAppWebContents: vi.fn(() => [...shared.shownIn.values()]),
  };
});

vi.mock("../../../services/menuAccelerators.js", () => ({
  isDictationKey: vi.fn((input: { key: string }) => input.key === "."),
}));

const bundle = vi.hoisted(() => ({ replaced: false, launchable: false }));

vi.mock("../../../lifecycle/appBundleIdentity.js", () => ({
  isAppBundleReplaced: vi.fn(() => bundle.replaced),
  isAppBundleLaunchable: vi.fn(() => bundle.launchable),
}));

vi.mock("../../../lifecycle/appRelaunch.js", () => ({ relaunchApp: vi.fn() }));

import {
  registerVoiceInputHandlers,
  getLiveVoiceSession,
  claimDictationKey,
} from "../voiceInput.js";
import { CHANNELS } from "../../channels.js";
import { claimPageDictationKey } from "../../../services/voice/pageDictationKey.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { AUDIO_BUFFER_MAX_CHUNKS } from "../../../services/voice/TranscriptionProvider.js";
import {
  _resetDictationViewHoldsForTests,
  isDictationViewHeld,
} from "../../../services/voice/dictationViewHold.js";
import { relaunchApp } from "../../../lifecycle/appRelaunch.js";

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
    focus: vi.fn(),
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

function cancel(sender: FakeSender, sessionId: string) {
  return getHandler(CHANNELS.VOICE_INPUT_CANCEL)({ sender }, sessionId);
}

function correct(sender: FakeSender, sessionId: string, rawText: string) {
  return getHandler(CHANNELS.VOICE_INPUT_CORRECT)({ sender }, { rawText, sessionId });
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

/**
 * Holds keyterm assembly. Only Deepgram waits for it before its provider
 * starts (the terms go on its socket URL), so this also switches to Deepgram,
 * keeping the session in its starting phase until the terms land.
 */
function deferKeyterms() {
  shared.transcriptionProvider = "deepgram";
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

beforeEach(() => {
  shared.enabled = true;
});

// What the view received, minus its session-ended notice.
const received = (sender: FakeSender) =>
  sender.sent.filter((m) => m.channel !== CHANNELS.VOICE_INPUT_SESSION_ENDED);

type Ended = { sessionId: string; reason: string; report: Record<string, unknown> };

const endedPayloads = (sender: FakeSender) =>
  sender.sent
    .filter((m) => m.channel === CHANNELS.VOICE_INPUT_SESSION_ENDED)
    .map((m) => m.payload as Ended);

const ended = (sender: FakeSender) =>
  endedPayloads(sender).map(({ sessionId, reason }) => ({ sessionId, reason }));

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
    shared.correctionEnabled = false;
    shared.cleanups = [];
    shared.openaiApiKey = "sk-test";
    shared.vocabulary = null;
    shared.assembleKeyterms = null;
    shared.startContext = undefined;
    shared.transcriptionProvider = "openai";
    shared.providerStats = { delayTier: "low", droppedConnect: 0, droppedReplay: 0, reconnects: 0 };
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

  it("keeps the terms the provider reported, unforwarded, until the next dictation", async () => {
    const getLastTerms = () => getHandler(CHANNELS.VOICE_INPUT_GET_LAST_TERMS)({});
    expect(await getLastTerms()).toBeNull();

    shared.assembleKeyterms = async () => ["alpha", "Beta", "gamma"];
    await start(ownerA, "a");
    expect(await getLastTerms()).toMatchObject({ sessionId: "a", assembledCount: 3, sent: null });

    emit({
      type: "terms_sent",
      terms: ["alpha", "beta", "unassembled"],
      keytermAttempt: "trimmed",
    });
    expect(await getLastTerms()).toMatchObject({
      sessionId: "a",
      sent: [
        { term: "alpha", source: "dictionary" },
        { term: "beta", source: "dictionary" },
      ],
      keytermAttempt: "trimmed",
    });
    expect(received(ownerA)).toEqual([]);

    emit({ type: "terms_sent", terms: [] });
    expect(await getLastTerms()).toMatchObject({ sent: [] });

    // A session that reported keeps what it reported when it ends.
    await stop(ownerA, "a");
    const reported = (await getLastTerms()) as Record<string, unknown>;
    expect(reported).toMatchObject({ sessionId: "a", sent: [] });
    expect(reported).not.toHaveProperty("endedBeforeSending");

    shared.assembleKeyterms = async () => ["delta"];
    await start(ownerB, "b");
    expect(await getLastTerms()).toMatchObject({ sessionId: "b", assembledCount: 1, sent: null });

    // Ending before the provider reported leaves "nothing sent", not "pending",
    // and marks it so the page doesn't blame the provider's limits.
    await stop(ownerB, "b");
    expect(await getLastTerms()).toMatchObject({
      sessionId: "b",
      sent: [],
      endedBeforeSending: true,
    });
  });

  it("records OpenAI's terms when they land after its start, before it reports them", async () => {
    const getLastTerms = () => getHandler(CHANNELS.VOICE_INPUT_GET_LAST_TERMS)({});
    let landA!: (terms: string[]) => void;
    shared.assembleKeyterms = () => new Promise<string[]>((r) => (landA = r));
    await expect(start(ownerA, "a")).resolves.toEqual({ status: "started" });

    // OpenAI's provider started without waiting on assembly.
    expect(shared.calls).toContain("start:a");
    expect(await getLastTerms()).toMatchObject({ sessionId: "a", sent: null });

    // The provider sends, and reports, only once its pending terms land.
    landA(["Daintree", "xterm"]);
    const terms = await shared.startContext!.keyterms!;
    expect(terms).toEqual(["Daintree", "xterm"]);
    emit({ type: "terms_sent", terms });
    const reported = (await getLastTerms()) as Record<string, unknown>;
    expect(reported).toMatchObject({
      sessionId: "a",
      provider: "openai",
      assembledCount: 2,
      sent: [
        { term: "Daintree", source: "dictionary" },
        { term: "xterm", source: "dictionary" },
      ],
    });
    expect(reported).not.toHaveProperty("endedBeforeSending");
  });

  it("keeps a session stopped before its OpenAI terms land as ended before sending", async () => {
    const getLastTerms = () => getHandler(CHANNELS.VOICE_INPUT_GET_LAST_TERMS)({});
    let landA!: (terms: string[]) => void;
    shared.assembleKeyterms = () => new Promise<string[]>((r) => (landA = r));
    await start(ownerA, "a");
    const pendingA = shared.startContext!.keyterms!;
    await stop(ownerA, "a");
    expect(await getLastTerms()).toMatchObject({
      sessionId: "a",
      sent: [],
      endedBeforeSending: true,
    });

    shared.assembleKeyterms = async () => ["delta"];
    await start(ownerB, "b");
    await expect(shared.startContext!.keyterms!).resolves.toEqual(["delta"]);

    // A's terms landing late leave B's slot and sources alone.
    landA(["alpha"]);
    await expect(pendingA).resolves.toEqual(["alpha"]);
    emit({ type: "terms_sent", terms: ["alpha", "delta"] });
    expect(await getLastTerms()).toMatchObject({
      sessionId: "b",
      assembledCount: 1,
      sent: [{ term: "delta", source: "dictionary" }],
    });
  });

  it("lets a spoken rewrite instruction take the slot, marked as one", async () => {
    const getLastTerms = () => getHandler(CHANNELS.VOICE_INPUT_GET_LAST_TERMS)({});
    shared.assembleKeyterms = async () => ["alpha"];
    await start(ownerA, "a");
    expect(await getLastTerms()).not.toHaveProperty("rewrite");
    await stop(ownerA, "a");

    shared.assembleKeyterms = async () => ["beta"];
    owners.set("b", ownerB);
    await getHandler(CHANNELS.VOICE_INPUT_START)({ sender: ownerB }, "b", { intent: "rewrite" });
    await shared.startContext!.keyterms!;
    emit({ type: "terms_sent", terms: ["beta"] });
    expect(await getLastTerms()).toMatchObject({
      sessionId: "b",
      rewrite: true,
      sent: [{ term: "beta", source: "dictionary" }],
    });
  });

  it("records Deepgram's terms before its provider starts", async () => {
    const getLastTerms = () => getHandler(CHANNELS.VOICE_INPUT_GET_LAST_TERMS)({});
    shared.transcriptionProvider = "deepgram";
    shared.assembleKeyterms = async () => ["alpha", "beta"];
    await start(ownerA, "a");
    expect(shared.startContext).toBeUndefined();
    expect(await getLastTerms()).toMatchObject({
      sessionId: "a",
      provider: "deepgram",
      assembledCount: 2,
      sent: null,
    });

    emit({ type: "terms_sent", terms: ["alpha"], keytermAttempt: "trimmed" });
    expect(await getLastTerms()).toMatchObject({
      sent: [{ term: "alpha", source: "dictionary" }],
      keytermAttempt: "trimmed",
    });
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

  it("cancels a running session without draining it, dropping anything it still emits", async () => {
    await start(ownerA, "a");
    await cancel(ownerA, "a");
    emit({ type: "complete", text: "late words" });

    expect(shared.calls).toEqual(["start:a", "hard-stop"]);
    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "cancelled" }]);
    expect(received(ownerA)).toEqual([]);
    expect(getLiveVoiceSession()).toBeNull();
  });

  it("cancels a session still starting without ever bringing up its provider", async () => {
    const resolveKeyterms = deferKeyterms();
    const pending = start(ownerA, "a");
    sendChunk("a", 1);
    await cancel(ownerA, "a");
    resolveKeyterms();

    await expect(pending).resolves.toEqual({ status: "superseded" });
    expect(shared.calls).toEqual([]);
    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "cancelled" }]);
  });

  it("ignores a cancel carrying an id that isn't the live session's", async () => {
    await start(ownerA, "a");
    await cancel(ownerB, "b");

    expect(shared.calls).toEqual(["start:a"]);
    expect(getLiveVoiceSession()?.sessionId).toBe("a");
    expect(ended(ownerA)).toEqual([]);
  });

  it("ends a draining session as cancelled when a cancel overtakes its stop", async () => {
    await start(ownerA, "a");
    const finishDrain = deferDrain();
    const stopping = stop(ownerA, "a");
    await cancel(ownerA, "a");
    emit({ type: "complete", text: "drained words" });
    finishDrain();
    await stopping;

    expect(shared.calls).toEqual(["start:a", "drain", "hard-stop"]);
    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "cancelled" }]);
    expect(received(ownerA)).toEqual([]);
  });

  it("ignores a cancel from a view that doesn't own the session", async () => {
    await start(ownerA, "a");
    await cancel(ownerB, "a");

    expect(shared.calls).toEqual(["start:a"]);
    expect(getLiveVoiceSession()?.sessionId).toBe("a");
    expect(ended(ownerA)).toEqual([]);
  });

  it("leaves a session being drained for another view's start to that drain", async () => {
    await start(ownerA, "a");
    const finishDrain = deferDrain();
    const startingB = start(ownerB, "b");
    await settle();
    await cancel(ownerA, "a");

    expect(shared.calls).toEqual(["start:a", "drain"]);
    finishDrain();
    await expect(startingB).resolves.toEqual({ status: "started" });
    expect(ended(ownerA)).toEqual([{ sessionId: "a", reason: "superseded" }]);
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

  describe("cleanup after a stop", () => {
    beforeEach(() => {
      shared.correctionEnabled = true;
    });

    // The cleanup request A's correction reached the service with.
    const requestFor = async (rawText: string) => {
      await vi.waitFor(() => expect(shared.cleanups.map((c) => c.rawText)).toContain(rawText));
      return shared.cleanups.find((c) => c.rawText === rawText)!;
    };

    // A follow-up pressed around A's stop: how it starts, and how it ends.
    const followUps: Array<[string, () => Promise<unknown>, () => unknown]> = [
      ["stops", () => start(ownerA, "b"), () => stop(ownerA, "b")],
      ["is cancelled", () => start(ownerA, "b"), () => cancel(ownerA, "b")],
      [
        "fails to start",
        () => {
          shared.startResult = { ok: false, error: "OpenAI API key not configured" };
          return start(ownerA, "b");
        },
        () => {},
      ],
      ["runs in another view that goes away", () => start(ownerB, "b"), () => ownerB.destroy()],
    ];

    const expectLanded = async (
      cleanupA: Promise<unknown>,
      requestA: Awaited<ReturnType<typeof requestFor>>
    ) => {
      expect(getLiveVoiceSession()).toBeNull();
      expect(requestA.signal?.aborted).toBe(false);
      requestA.finish("Fix the bug.");
      await expect(cleanupA).resolves.toMatchObject({
        action: "replace",
        correctedText: "Fix the bug.",
      });
    };

    it.each(followUps)(
      "keeps a dictation's cleanup running when the next one %s while it's out",
      async (_label, startB, endB) => {
        await start(ownerA, "a");
        await stop(ownerA, "a");
        const cleanupA = correct(ownerA, "a", "fix the bug");
        const requestA = await requestFor("fix the bug");

        await startB();
        await endB();
        await expectLanded(cleanupA, requestA);
      }
    );

    it.each(followUps)(
      "keeps a dictation's cleanup running when the next one %s while it reads its context",
      async (_label, startB, endB) => {
        shared.projects.set(ownerA.id, "proj-a");
        let readVocabulary!: () => void;
        shared.vocabulary = new Promise((resolve) => {
          readVocabulary = () => resolve([]);
        });
        await start(ownerA, "a");
        await stop(ownerA, "a");
        const cleanupA = correct(ownerA, "a", "fix the bug");
        await settle();
        expect(shared.cleanups).toEqual([]);

        await startB();
        readVocabulary();
        const requestA = await requestFor("fix the bug");
        await endB();
        await expectLanded(cleanupA, requestA);
      }
    );

    // Pressed again while A's stop was still draining: B is up before A's
    // cleanup is asked for.
    it.each(followUps)(
      "keeps a dictation's cleanup asked for after the next one starts running when it %s",
      async (_label, startB, endB) => {
        await start(ownerA, "a");
        await stop(ownerA, "a");
        await startB();
        const cleanupA = correct(ownerA, "a", "fix the bug");
        const requestA = await requestFor("fix the bug");

        await endB();
        await expectLanded(cleanupA, requestA);
      }
    );

    it("cancels only the cleanup whose view goes away", async () => {
      await start(ownerA, "a");
      await stop(ownerA, "a");
      const cleanupA = correct(ownerA, "a", "fix the bug");
      await start(ownerB, "b");
      await stop(ownerB, "b");
      const cleanupB = correct(ownerB, "b", "ship it");
      const [requestA, requestB] = [await requestFor("fix the bug"), await requestFor("ship it")];

      ownerA.destroy();

      expect(requestA.signal?.aborted).toBe(true);
      await expect(cleanupA).resolves.toMatchObject({ failed: true });
      expect(requestB.signal?.aborted).toBe(false);
      requestB.finish("Ship it.");
      // The service's verdict reaches the renderer for its session summary.
      await expect(cleanupB).resolves.toMatchObject({
        correctedText: "Ship it.",
        verdict: "replaced",
      });
    });

    it("sends nothing for a cleanup whose view went away while it read its context", async () => {
      shared.projects.set(ownerA.id, "proj-a");
      let readVocabulary!: () => void;
      shared.vocabulary = new Promise((resolve) => {
        readVocabulary = () => resolve([]);
      });
      await start(ownerA, "a");
      await stop(ownerA, "a");
      const cleanupA = correct(ownerA, "a", "fix the bug");
      await settle();

      ownerA.destroy();
      readVocabulary();

      await expect(cleanupA).resolves.toEqual({
        action: "no_change",
        correctedText: "fix the bug",
        failed: true,
        verdict: "failed",
      });
      expect(shared.cleanups).toEqual([]);
    });

    it("stops watching the view once the cleanup has replied", async () => {
      await start(ownerA, "a");
      await stop(ownerA, "a");
      const cleanupA = correct(ownerA, "a", "fix the bug");
      const requestA = await requestFor("fix the bug");
      requestA.finish("Fix the bug.");
      await cleanupA;

      ownerA.destroy();
      expect(requestA.signal?.aborted).toBe(false);
    });

    it("streams a cleanup's text so far back to the view that asked, under its id", async () => {
      await start(ownerA, "a");
      await stop(ownerA, "a");
      await start(ownerB, "b");
      await stop(ownerB, "b");
      const askWithStream = (owner: FakeSender, sessionId: string, rawText: string, id: string) =>
        getHandler(CHANNELS.VOICE_INPUT_CORRECT)(
          { sender: owner },
          { rawText, sessionId, streamId: id }
        );
      const cleanupA = askWithStream(ownerA, "a", "fix the bug", "s1");
      const cleanupB = askWithStream(ownerB, "b", "ship it now", "s2");
      const [requestA, requestB] = [
        await requestFor("fix the bug"),
        await requestFor("ship it now"),
      ];
      const progress = (owner: FakeSender) =>
        owner.sent.filter((s) => s.channel === CHANNELS.VOICE_INPUT_CORRECTION_PROGRESS);

      requestA.onText!("Fix the");
      requestB.onText!("Ship it");
      expect(progress(ownerA)).toEqual([
        {
          channel: CHANNELS.VOICE_INPUT_CORRECTION_PROGRESS,
          payload: { streamId: "s1", text: "Fix the" },
        },
      ]);
      expect(progress(ownerB)).toEqual([
        {
          channel: CHANNELS.VOICE_INPUT_CORRECTION_PROGRESS,
          payload: { streamId: "s2", text: "Ship it" },
        },
      ]);

      requestA.finish("Fix the bug.");
      requestB.finish("Ship it now.");
      await expect(cleanupA).resolves.toMatchObject({ correctedText: "Fix the bug." });
      await expect(cleanupB).resolves.toMatchObject({ correctedText: "Ship it now." });
    });

    it("streams nothing for a cleanup that didn't ask, or to a view that went away", async () => {
      await start(ownerA, "a");
      await stop(ownerA, "a");
      void correct(ownerA, "a", "fix the bug");
      expect((await requestFor("fix the bug")).onText).toBeUndefined();

      void getHandler(CHANNELS.VOICE_INPUT_CORRECT)(
        { sender: ownerA },
        { rawText: "ship it", sessionId: "a", streamId: "s2" }
      );
      const requestB = await requestFor("ship it");
      ownerA.destroyed = true;
      requestB.onText!("Ship");
      expect(ownerA.sent.some((s) => s.channel === CHANNELS.VOICE_INPUT_CORRECTION_PROGRESS)).toBe(
        false
      );
    });

    it("cancels a cleanup still out when the handlers are unregistered", async () => {
      await start(ownerA, "a");
      await stop(ownerA, "a");
      const cleanupA = correct(ownerA, "a", "fix the bug");
      const requestA = await requestFor("fix the bug");

      cleanup();

      expect(requestA.signal?.aborted).toBe(true);
      await expect(cleanupA).resolves.toMatchObject({ failed: true });
    });
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

  describe("cleanup prefetched at a pause", () => {
    beforeEach(() => {
      shared.correctionEnabled = true;
    });

    const prefetch = (owner: FakeSender, sessionId: string, ...rawTexts: string[]) =>
      getHandler(CHANNELS.VOICE_INPUT_PREFETCH_CORRECTIONS)(
        { sender: owner },
        { sessionId, requests: rawTexts.map((rawText) => ({ rawText, sessionId })) }
      );
    const ask = (owner: FakeSender, sessionId: string, rawText: string, streamId = "s1") =>
      getHandler(CHANNELS.VOICE_INPUT_CORRECT)({ sender: owner }, { rawText, sessionId, streamId });
    const requestFor = async (rawText: string) => {
      await vi.waitFor(() => expect(shared.cleanups.map((c) => c.rawText)).toContain(rawText));
      return shared.cleanups.find((c) => c.rawText === rawText)!;
    };
    const progress = (owner: FakeSender) =>
      owner.sent
        .filter((s) => s.channel === CHANNELS.VOICE_INPUT_CORRECTION_PROGRESS)
        .map((s) => s.payload);

    it("hands the stop the reply a pause already started for the same passage", async () => {
      await start(ownerA, "a");
      await prefetch(ownerA, "a", "run the tests");
      const prefetched = await requestFor("run the tests");
      prefetched.onText!("Run the");

      await stop(ownerA, "a");
      const reply = ask(ownerA, "a", "run the tests");
      await settle();
      expect(shared.cleanups).toHaveLength(1);
      expect(progress(ownerA)).toEqual([{ streamId: "s1", text: "Run the" }]);

      prefetched.onText!("Run the tests");
      prefetched.finish("Run the tests.");
      await expect(reply).resolves.toMatchObject({
        action: "replace",
        correctedText: "Run the tests.",
      });
      expect(progress(ownerA)).toEqual([
        { streamId: "s1", text: "Run the" },
        { streamId: "s1", text: "Run the tests" },
      ]);
    });

    it("sends the stop's own cleanup when the words changed after the pause", async () => {
      await start(ownerA, "a");
      await prefetch(ownerA, "a", "run the");
      await requestFor("run the");

      await stop(ownerA, "a");
      const reply = ask(ownerA, "a", "run the tests");
      const own = await requestFor("run the tests");
      expect(shared.cleanups).toHaveLength(2);
      own.finish("Run the tests.");
      await expect(reply).resolves.toMatchObject({ correctedText: "Run the tests." });
    });

    it("gives a stop whose prefetch failed a try of its own", async () => {
      await start(ownerA, "a");
      await prefetch(ownerA, "a", "run the tests");
      const prefetched = await requestFor("run the tests");

      await stop(ownerA, "a");
      const reply = ask(ownerA, "a", "run the tests");
      prefetched.fail();
      await vi.waitFor(() => expect(shared.cleanups).toHaveLength(2));
      shared.cleanups[1]!.finish("Run the tests.");
      await expect(reply).resolves.toMatchObject({ correctedText: "Run the tests." });
    });

    it("lets a passage be taken once, so a second stop asking for it sends its own", async () => {
      await start(ownerA, "a");
      await prefetch(ownerA, "a", "run the tests");
      const prefetched = await requestFor("run the tests");
      await stop(ownerA, "a");

      const first = ask(ownerA, "a", "run the tests");
      const second = ask(ownerA, "a", "run the tests", "s2");
      await vi.waitFor(() => expect(shared.cleanups).toHaveLength(2));
      prefetched.finish("Run the tests.");
      shared.cleanups[1]!.finish("Run the tests!");
      await expect(first).resolves.toMatchObject({ correctedText: "Run the tests." });
      await expect(second).resolves.toMatchObject({ correctedText: "Run the tests!" });
    });

    it("cancels a prefetch the dictation talked on past", async () => {
      await start(ownerA, "a");
      await prefetch(ownerA, "a", "run the");
      const stale = await requestFor("run the");
      await prefetch(ownerA, "a", "run the tests");

      expect(stale.signal?.aborted).toBe(true);
      expect((await requestFor("run the tests")).signal?.aborted).toBe(false);
    });

    it("starts at most eight runs a session, and none for a passage past 2,000 characters", async () => {
      await start(ownerA, "a");
      // Each pause's run reaches OpenAI before the next pause replaces it.
      for (let i = 0; i < 10; i++) {
        await prefetch(ownerA, "a", `pause ${i}`);
        await settle();
      }
      expect(shared.cleanups.map((c) => c.rawText)).toEqual(
        Array.from({ length: 8 }, (_, i) => `pause ${i}`)
      );

      await start(ownerB, "b");
      await prefetch(ownerB, "b", "x".repeat(2_001));
      await prefetch(ownerB, "b", "x".repeat(2_000));
      await vi.waitFor(() => expect(shared.cleanups).toHaveLength(9));
      expect(shared.cleanups[8]!.rawText).toHaveLength(2_000);
    });

    it("cancels a cancelled dictation's prefetch", async () => {
      await start(ownerA, "a");
      await prefetch(ownerA, "a", "run the tests");
      const prefetched = await requestFor("run the tests");

      await cancel(ownerA, "a");
      expect(prefetched.signal?.aborted).toBe(true);
    });

    it("prefetches nothing for another view's session, a stopping one, or with cleanup off", async () => {
      await start(ownerA, "a");
      await prefetch(ownerB, "a", "from the wrong view");
      const endDrain = deferDrain();
      const stopping = stop(ownerA, "a");
      await prefetch(ownerA, "a", "while it drains");
      endDrain();
      await stopping;
      shared.correctionEnabled = false;
      await start(ownerB, "b");
      await prefetch(ownerB, "b", "with cleanup off");
      await settle();

      expect(shared.cleanups).toEqual([]);
    });
  });

  describe("a cleanup failure that will recur (#14963)", () => {
    beforeEach(() => {
      shared.correctionEnabled = true;
    });

    const prefetch = (owner: FakeSender, sessionId: string, rawText: string) =>
      getHandler(CHANNELS.VOICE_INPUT_PREFETCH_CORRECTIONS)(
        { sender: owner },
        { sessionId, requests: [{ rawText, sessionId }] }
      );
    // Each passage's request, once it reaches the service, taken in turn.
    const nextRequest = async (rawText: string) => {
      const pending = () => shared.cleanups.filter((c) => c.rawText === rawText);
      await vi.waitFor(() => expect(pending().length).toBeGreaterThan(0));
      const request = pending()[0]!;
      shared.cleanups.splice(shared.cleanups.indexOf(request), 1);
      return request;
    };
    const refused = async (owner: FakeSender, rawText: string) => {
      const reply = correct(owner, "a", rawText);
      (await nextRequest(rawText)).refuse("key_rejected");
      return (await reply) as Record<string, unknown>;
    };
    const TOLD = { cleanupFailure: { reason: "key_rejected", provider: "openai" } };

    it("tells the first reply of an outage, and no other from any view", async () => {
      await start(ownerA, "a");
      await stop(ownerA, "a");

      const first = await refused(ownerA, "fix the bug");
      expect(first).toMatchObject({ correctedText: "fix the bug", failed: true, ...TOLD });
      const again = await refused(ownerA, "and the lexer");
      const elsewhere = await refused(ownerB, "in another view");

      for (const reply of [again, elsewhere]) {
        expect(reply).toMatchObject({ failed: true, verdict: "failed" });
        expect(reply).not.toHaveProperty("cleanupFailure");
      }
    });

    it("tells it again after a cleanup on the account works", async () => {
      await start(ownerA, "a");
      await stop(ownerA, "a");
      await refused(ownerA, "fix the bug");

      const worked = correct(ownerA, "a", "fix the bug");
      (await nextRequest("fix the bug")).finish("Fix the bug.");
      await expect(worked).resolves.toMatchObject({ correctedText: "Fix the bug." });

      expect(await refused(ownerA, "fix the bug")).toMatchObject(TOLD);
    });

    it("tells a new key's failure, however recently the old key's was told", async () => {
      await start(ownerA, "a");
      await stop(ownerA, "a");
      await refused(ownerA, "fix the bug");

      shared.openaiApiKey = "sk-replaced";
      expect(await refused(ownerA, "fix the bug")).toMatchObject(TOLD);
    });

    it("spends nothing on a failure that may pass", async () => {
      await start(ownerA, "a");
      await stop(ownerA, "a");
      const failed = correct(ownerA, "a", "fix the bug");
      (await nextRequest("fix the bug")).fail();
      expect(await failed).not.toHaveProperty("cleanupFailure");

      expect(await refused(ownerA, "fix the bug")).toMatchObject(TOLD);
    });

    it("tells nothing to a view that went away", async () => {
      await start(ownerA, "a");
      await stop(ownerA, "a");
      const gone = makeSender();
      const reply = correct(gone, "a", "fix the bug");
      const request = await nextRequest("fix the bug");
      gone.destroyed = true;
      request.refuse("key_rejected");
      expect(await reply).not.toHaveProperty("cleanupFailure");

      expect(await refused(ownerA, "fix the bug")).toMatchObject(TOLD);
    });

    it("takes a prefetch's refusal as the stop's, without asking the account again", async () => {
      await start(ownerA, "a");
      await prefetch(ownerA, "a", "run the tests");
      (await nextRequest("run the tests")).refuse("key_rejected");

      await stop(ownerA, "a");
      await expect(correct(ownerA, "a", "run the tests")).resolves.toMatchObject(TOLD);
      await settle();
      expect(shared.cleanups).toEqual([]);
    });

    it("tells nothing for a prefetch no stop took", async () => {
      await start(ownerA, "a");
      await prefetch(ownerA, "a", "run the");
      (await nextRequest("run the")).refuse("key_rejected");

      await stop(ownerA, "a");
      expect(await refused(ownerA, "run the tests")).toMatchObject(TOLD);
    });
  });

  describe("the report sent with the ended notice", () => {
    it("carries main's and the provider's counts, and none of the text", async () => {
      shared.assembleKeyterms = () => Promise.resolve(["daintree", "canopy", "worktree"]);
      shared.providerStats = {
        delayTier: "low",
        droppedConnect: 3,
        droppedReplay: 4,
        reconnects: 2,
      };
      await start(ownerA, "a");
      emit({ type: "complete", text: "fix the login bug", itemId: "i1" });
      emit({ type: "complete", text: "", itemId: "i2" });
      emit({ type: "complete", text: "   " });
      await stop(ownerA, "a");

      const [payload] = endedPayloads(ownerA);
      expect(payload).toEqual({
        sessionId: "a",
        reason: "stopped",
        report: {
          provider: "openai",
          delayTier: "low",
          biasTermCount: 3,
          droppedPreStart: 0,
          droppedConnect: 3,
          droppedReplay: 4,
          reconnects: 2,
          completedSegments: 1,
          emptyCompletions: 2,
        },
      });
      expect(JSON.stringify(payload)).not.toMatch(/daintree|canopy|login/);
    });

    it("counts every chunk refused while the session was still starting", async () => {
      const resolveKeyterms = deferKeyterms();
      const pending = start(ownerA, "a");
      for (let i = 0; i < AUDIO_BUFFER_MAX_CHUNKS + 5; i++) sendChunk("a", i % 250);
      const stopping = stop(ownerA, "a");
      resolveKeyterms();
      await pending;
      await stopping;

      expect(endedPayloads(ownerA)[0]?.report).toMatchObject({ droppedPreStart: 5 });
    });

    it("reads a superseded session's counts before the new session's provider starts", async () => {
      shared.providerStats = {
        delayTier: "low",
        droppedConnect: 2,
        droppedReplay: 0,
        reconnects: 3,
      };
      await start(ownerA, "a");
      await start(ownerB, "b");

      expect(endedPayloads(ownerA)).toMatchObject([
        { sessionId: "a", reason: "superseded", report: { reconnects: 3, droppedConnect: 2 } },
      ]);
    });

    it("has no provider counts for a session that ended before its provider started", async () => {
      // An older session's provider is still the service's, with counts of its own.
      shared.providerStats = {
        delayTier: "low",
        droppedConnect: 9,
        droppedReplay: 9,
        reconnects: 9,
      };
      await start(ownerA, "z");
      await stop(ownerA, "z");
      const resolveKeyterms = deferKeyterms();
      const pending = start(ownerA, "a");
      await stop(ownerA, "a");
      resolveKeyterms(["daintree"]);
      await pending;

      expect(endedPayloads(ownerA).find((p) => p.sessionId === "a")?.report).toMatchObject({
        delayTier: null,
        biasTermCount: null,
        droppedConnect: 0,
        droppedReplay: 0,
        reconnects: 0,
        completedSegments: 0,
      });
    });
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
    shared.transcriptionProvider = "openai";
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
    const elsewhere = {
      sessionId: "a",
      hostId: "local",
      projectId: "project-a",
      projectName: "Alpha",
      details: null,
    };
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
      session: {
        sessionId: "a",
        hostId: "local",
        projectId: "project-a",
        projectName: "Alpha",
        details: null,
      },
    });
    expect(await invoke(CHANNELS.VOICE_INPUT_GET_LIVE_SESSION, ownerA)).toMatchObject({
      session: null,
    });
  });

  it("asks the owner to stop when another view's dictation key names its session", async () => {
    await start(ownerA, "a");

    expect(await invoke(CHANNELS.VOICE_INPUT_STOP_LIVE, viewB, { sessionId: "a" })).toBe(true);

    expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([{ sessionId: "a" }]);
    // The owner runs the stop, so its drain keeps the text; main stops nothing itself.
    expect(shared.calls).not.toContain("drain");
    expect(shared.calls).not.toContain("hard-stop");
    // Not the key's own stop, so nothing is brought forward.
    expect(winA.focus).not.toHaveBeenCalled();
    expect(ownerA.focus).not.toHaveBeenCalled();
  });

  it("ignores a stop for a session that isn't the live one", async () => {
    await start(ownerA, "a");

    expect(await invoke(CHANNELS.VOICE_INPUT_STOP_LIVE, viewB, { sessionId: "old" })).toBe(false);
    await stop(ownerA, "a");
    expect(
      await invoke(CHANNELS.VOICE_INPUT_STOP_LIVE, viewB, { sessionId: "a", returnToTarget: true })
    ).toBe(false);

    expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([]);
    expect(winA.focus).not.toHaveBeenCalled();
  });

  it("asks the owner to stop when dictation is turned off mid-session (#14947)", async () => {
    await start(ownerA, "a");

    await invoke(CHANNELS.VOICE_INPUT_SET_SETTINGS, viewB, { language: "de" });
    expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([]);

    await invoke(CHANNELS.VOICE_INPUT_SET_SETTINGS, viewB, { enabled: false });

    expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([{ sessionId: "a" }]);
    // The owner drains it, so what was said stays in its draft.
    expect(shared.calls).not.toContain("hard-stop");
    expect(winA.focus).not.toHaveBeenCalled();
  });

  it("stops a start that reaches main after dictation was turned off, keeping its speech", async () => {
    await invoke(CHANNELS.VOICE_INPUT_SET_SETTINGS, viewB, { enabled: false });

    await start(ownerA, "a");

    // The owner may already hold queued speech, so it drains rather than being refused.
    expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([{ sessionId: "a" }]);
    expect(getLiveVoiceSession()?.sessionId).toBe("a");
    expect(shared.calls).not.toContain("hard-stop");
  });

  it("asks nothing of a view when dictation is turned off with nothing live", async () => {
    await start(ownerA, "a");
    await stop(ownerA, "a");

    await invoke(CHANNELS.VOICE_INPUT_SET_SETTINGS, viewB, { enabled: false });

    expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([]);
  });

  describe("taking the person back to the dictation (#14791)", () => {
    const back = { sessionId: "a", returnToTarget: true };

    it("brings the owner's window forward and gives the owner the keyboard when it's on screen", async () => {
      winA.isMinimized.mockReturnValue(true);
      await start(ownerA, "a");

      expect(await invoke(CHANNELS.VOICE_INPUT_STOP_LIVE, viewB, back)).toBe(true);

      expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([back]);
      expect(winA.restore).toHaveBeenCalled();
      expect(winA.show).toHaveBeenCalled();
      expect(winA.focus).toHaveBeenCalled();
      expect(winB.focus).not.toHaveBeenCalled();
      // A browser panel or portal tab there may hold the keyboard: a view's own
      // focus moves can't take it from another view.
      expect(ownerA.focus).toHaveBeenCalled();
      // The owner's stop request carries the return; a reveal on top would
      // bring its pane forward twice.
      expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([]);
      expect(sentOn(viewB, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([]);
    });

    it("has the view on screen in the owner's window switch to the owner's workspace", async () => {
      shared.shownIn.set(winA, viewC);
      await start(ownerA, "a");

      await invoke(CHANNELS.VOICE_INPUT_STOP_LIVE, viewB, back);

      expect(sentOn(viewC, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([
        { sessionId: "a", hostId: "local", workspaceId: "project-a" },
      ]);
      expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([back]);
      // The switch focuses the view it brings in.
      expect(ownerA.focus).not.toHaveBeenCalled();
      expect(winA.focus).toHaveBeenCalled();
    });
  });

  it("gives the owner on screen the keyboard when another window's indicator asks for it", async () => {
    await start(ownerA, "a");

    await invoke(CHANNELS.VOICE_INPUT_REVEAL_LIVE, viewB, "a");

    expect(ownerA.focus).toHaveBeenCalled();
  });

  const reveal = { sessionId: "a", hostId: "local", workspaceId: "project-a" };

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

    it("asks the owner to stop, takes the key from the page and goes back to the dictation", async () => {
      await start(ownerA, "a");

      expect(claimDictationKey(press())).toBe(true);
      expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([
        { sessionId: "a", returnToTarget: true },
      ]);
      // The page may be a browser panel in the owner's own window.
      expect(winA.focus).toHaveBeenCalled();
      expect(ownerA.focus).toHaveBeenCalled();
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
      expect(sentOn(ownerA, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([
        { sessionId: "a", returnToTarget: true },
      ]);

      cleanup();
      cleanup = () => {};
      expect(claimPageDictationKey(press())).toBe(false);
    });
  });
});

describe("voiceInput — one dictation across hosts (#14773)", () => {
  let cleanup: () => void;
  // This Mac's view of project-a, and two hosts' views of a project that has
  // the same id on both.
  let local: FakeSender;
  let studio1: FakeSender;
  let studio2: FakeSender;
  type FakeWindow = {
    isDestroyed: () => boolean;
    isMinimized: () => boolean;
    restore: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  };
  let winA: FakeWindow;
  let winB: FakeWindow;
  const makeWindow = (): FakeWindow => ({
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  });

  const sentOn = (view: FakeSender, channel: string) =>
    view.sent.filter((m) => m.channel === channel).map((m) => m.payload);
  const lastLive = (view: FakeSender) =>
    sentOn(view, CHANNELS.VOICE_INPUT_LIVE_SESSION).at(-1) as
      { revision: number; session: unknown } | undefined;
  const invoke = (channel: string, sender: FakeSender, ...args: unknown[]) =>
    getHandler(channel)({ sender }, ...args);
  const startIn = (sender: FakeSender, sessionId: string, workspaceName?: string) => {
    owners.set(sessionId, sender);
    return getHandler(CHANNELS.VOICE_INPUT_START)(
      { sender },
      sessionId,
      workspaceName ? { workspaceName } : undefined
    );
  };
  const held = (view: FakeSender) => isDictationViewHeld(view as unknown as Electron.WebContents);

  beforeEach(() => {
    vi.clearAllMocks();
    shared.calls = [];
    shared.listeners.clear();
    shared.providerSessionId = null;
    shared.startResult = { ok: true };
    shared.drain = null;
    shared.endDrain = null;
    shared.assembleKeyterms = null;
    shared.transcriptionProvider = "openai";
    shared.projects.clear();
    _resetDictationViewHoldsForTests();
    local = makeSender();
    studio1 = makeSender();
    studio2 = makeSender();
    shared.appViews = [local, studio1, studio2];
    shared.projects.set(local.id, "project-a");
    shared.projects.set(studio1.id, "studio-01:proj-r");
    shared.projects.set(studio2.id, "studio-02:proj-r");
    vi.mocked(projectStore.getProjectById).mockImplementation((id: string) =>
      id === "project-a"
        ? ({ id, name: "Alpha", path: "/alpha" } as ReturnType<typeof projectStore.getProjectById>)
        : null
    );
    // Window A was on this Mac and has since switched to studio-01, keeping
    // this Mac's view cached; window B is on studio-02.
    winA = makeWindow();
    winB = makeWindow();
    shared.windowOf = new Map([
      [local.id, winA],
      [studio1.id, winA],
      [studio2.id, winB],
    ]);
    shared.shownIn = new Map<Record<string, unknown>, unknown>([
      [winA, studio1],
      [winB, studio2],
    ]);
    cleanup = registerVoiceInputHandlers({
      mainWindow: { webContents: { send: vi.fn() }, isDestroyed: () => false },
    } as unknown as Parameters<typeof registerVoiceInputHandlers>[0]);
  });

  afterEach(() => {
    cleanup?.();
    vi.useRealTimers();
    shared.appViews = [];
    shared.windowOf = new Map();
    shared.shownIn = new Map();
    _resetDictationViewHoldsForTests();
    vi.mocked(projectStore.getProjectById).mockReset();
    vi.mocked(projectStore.getProjectById).mockReturnValue(null);
  });

  describe("started on this Mac", () => {
    it("tells a host's views it runs on this Mac, by the project's own id", async () => {
      await startIn(local, "a", "Alpha");

      const elsewhere = {
        sessionId: "a",
        hostId: "local",
        projectId: "project-a",
        projectName: "Alpha",
        details: null,
      };
      expect(lastLive(studio1)?.session).toEqual(elsewhere);
      expect(lastLive(studio2)?.session).toEqual(elsewhere);
    });

    it("has the host's view on screen in the owner's window go back to this Mac", async () => {
      await startIn(local, "a", "Alpha");

      expect(await invoke(CHANNELS.VOICE_INPUT_REVEAL_LIVE, studio2, "a")).toBe(true);

      const reveal = { sessionId: "a", hostId: "local", workspaceId: "project-a" };
      expect(sentOn(studio1, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([reveal]);
      expect(sentOn(local, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([reveal]);
      expect(sentOn(studio2, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([]);
      expect(winA.focus).toHaveBeenCalled();
      expect(winB.focus).not.toHaveBeenCalled();
    });

    it("is stopped by the dictation key in a host's view", async () => {
      await startIn(local, "a", "Alpha");

      const back = { sessionId: "a", returnToTarget: true };
      expect(await invoke(CHANNELS.VOICE_INPUT_STOP_LIVE, studio2, back)).toBe(true);

      expect(sentOn(local, CHANNELS.VOICE_INPUT_STOP_REQUESTED)).toEqual([back]);
      // This Mac's view goes back on screen in the owner's window.
      expect(sentOn(studio1, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([
        { sessionId: "a", hostId: "local", workspaceId: "project-a" },
      ]);
    });

    it("is drained, its text kept on this Mac, when a host's view starts one", async () => {
      await startIn(local, "a", "Alpha");

      await startIn(studio1, "b", "Remote R");

      expect(ended(local)).toEqual([{ sessionId: "a", reason: "superseded" }]);
      expect(shared.calls.indexOf("drain")).toBeLessThan(shared.calls.indexOf("start:b"));
      expect(lastLive(local)?.session).toMatchObject({ sessionId: "b", hostId: "studio-01" });
    });
  });

  describe("started on a host", () => {
    it("names the host and the project the view called itself, which this Mac can't", async () => {
      await startIn(studio1, "a", "Remote R");

      expect(lastLive(local)?.session).toEqual({
        sessionId: "a",
        hostId: "studio-01",
        projectId: "proj-r",
        projectName: "Remote R",
        details: null,
      });
      expect(lastLive(studio1)?.session).toBeNull();
    });

    it("has this Mac's view on screen in the owner's window go to the host", async () => {
      shared.shownIn.set(winA, local);
      await startIn(studio1, "a", "Remote R");

      await invoke(CHANNELS.VOICE_INPUT_REVEAL_LIVE, studio2, "a");

      const reveal = { sessionId: "a", hostId: "studio-01", workspaceId: "proj-r" };
      expect(sentOn(local, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([reveal]);
      expect(sentOn(studio1, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([reveal]);
    });

    it("never mixes up two hosts' projects that share an id", async () => {
      await startIn(studio1, "a", "Remote R");

      // Window B shows studio-02's copy of the same project id.
      expect(lastLive(studio2)?.session).toMatchObject({
        hostId: "studio-01",
        projectId: "proj-r",
      });
      await invoke(CHANNELS.VOICE_INPUT_REVEAL_LIVE, studio2, "a");

      expect(sentOn(studio2, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([]);
      expect(sentOn(studio1, CHANNELS.VOICE_INPUT_REVEAL_REQUESTED)).toEqual([
        { sessionId: "a", hostId: "studio-01", workspaceId: "proj-r" },
      ]);
    });
  });

  describe("what other views show of it (#14921)", () => {
    const details = (overrides: Record<string, unknown> = {}) => ({
      phase: "recording",
      kind: "dictation",
      targetTitle: "Claude",
      targetChrome: {
        iconId: "claude",
        label: "Claude",
        isAgent: true,
        agentId: "claude",
        processId: null,
        runtimeKind: "agent",
        hasExited: false,
      },
      targetHostId: "local",
      projectName: "Alpha",
      worktreeLabel: "main",
      micLabel: "MacBook Pro Microphone",
      micSignal: "live",
      micNotice: null,
      stopWarning: false,
      correctionEnabled: true,
      locked: false,
      wordCount: 3,
      transcript: "fix the build",
      provider: "openai",
      clock: { at: 1_000, elapsedMs: 7_000, pausedMs: 0, paused: false, autoStop: null },
      ...overrides,
    });
    const publish = (owner: FakeSender, sessionId: string, value = details()) =>
      invoke(CHANNELS.VOICE_INPUT_PUBLISH_DETAILS, owner, { sessionId, details: value });
    // A chunk of steady tone; at a tenth of full scale its RMS is 0.1, a level
    // of 0.6 on the owner's meter.
    const sendTone = (sessionId: string, from: FakeSender, amplitude = 3277) => {
      const call = ipcMainMock.on.mock.calls.find(([c]) => c === CHANNELS.VOICE_INPUT_AUDIO_CHUNK);
      const samples = new Int16Array(2400).fill(amplitude);
      (call![1] as (e: unknown, s: unknown, c: ArrayBuffer) => void)(
        { sender: from },
        sessionId,
        samples.buffer
      );
    };
    const levels = (view: FakeSender) =>
      sentOn(view, CHANNELS.VOICE_INPUT_LIVE_LEVEL) as Array<{ sessionId: string; level: number }>;
    let clock = 0;
    beforeEach(() => {
      clock = 10_000;
      vi.spyOn(performance, "now").mockImplementation(() => clock);
    });
    afterEach(() => {
      vi.mocked(performance.now).mockRestore();
    });

    // Each pairing the issue names: the owner, the view on screen elsewhere,
    // and a view cached behind it.
    const pairings = [
      {
        name: "a session on this Mac, seen from a host's view",
        setup: () => ({ owner: local, shown: studio1, cached: null as FakeSender | null }),
      },
      {
        name: "a session on a host, seen from this Mac's view",
        setup: () => {
          shared.shownIn.set(winA, local);
          return { owner: studio1, shown: local, cached: null as FakeSender | null };
        },
      },
      {
        name: "a session on one host, seen from another host's view",
        setup: () => ({ owner: studio1, shown: studio2, cached: local as FakeSender | null }),
      },
      {
        name: "a session in one project, seen from another project on the same host",
        setup: () => {
          const other = makeSender();
          shared.projects.set(other.id, "studio-01:proj-s");
          shared.appViews = [...shared.appViews, other];
          shared.windowOf.set(other.id, winB);
          shared.shownIn.set(winB, other);
          return { owner: studio1, shown: other, cached: studio2 as FakeSender | null };
        },
      },
    ];

    describe.each(pairings)("$name", ({ setup }) => {
      it("passes the owner's details on, and keeps them from the owner", async () => {
        const { owner, shown, cached } = setup();
        await startIn(owner, "a", "Workspace");
        const before = lastLive(shown)!.revision;

        expect(await publish(owner, "a")).toBe(true);

        expect(lastLive(shown)!.revision).toBeGreaterThan(before);
        expect(lastLive(shown)?.session).toMatchObject({
          sessionId: "a",
          details: details(),
        });
        if (cached) expect(lastLive(cached)?.session).toMatchObject({ details: details() });
        expect(lastLive(owner)?.session).toBeNull();
        expect(await invoke(CHANNELS.VOICE_INPUT_GET_LIVE_SESSION, shown)).toMatchObject({
          session: { details: details() },
        });
      });

      it("sends the input level to the view on screen, never the owner or a cached view", async () => {
        const { owner, shown, cached } = setup();
        await startIn(owner, "a", "Workspace");

        sendTone("a", owner);

        expect(levels(shown)).toHaveLength(1);
        expect(levels(shown)[0]!.sessionId).toBe("a");
        expect(levels(shown)[0]!.level).toBeCloseTo(0.6, 2);
        expect(levels(owner)).toEqual([]);
        if (cached) expect(levels(cached)).toEqual([]);
      });

      it("pauses and resumes the owner's session from the other view", async () => {
        const { owner, shown } = setup();
        await startIn(owner, "a", "Workspace");

        expect(
          await invoke(CHANNELS.VOICE_INPUT_SET_PAUSED_LIVE, shown, {
            sessionId: "a",
            paused: true,
          })
        ).toBe(true);
        expect(
          await invoke(CHANNELS.VOICE_INPUT_SET_PAUSED_LIVE, shown, {
            sessionId: "a",
            paused: false,
          })
        ).toBe(true);

        expect(sentOn(owner, CHANNELS.VOICE_INPUT_PAUSE_REQUESTED)).toEqual([
          { sessionId: "a", paused: true },
          { sessionId: "a", paused: false },
        ]);
      });
    });

    it("takes no report from a view that doesn't own the session", async () => {
      await startIn(local, "a", "Alpha");
      const before = lastLive(studio1)!.revision;

      expect(await publish(studio2, "a")).toBe(false);
      expect(await publish(local, "other")).toBe(false);

      expect(lastLive(studio1)!.revision).toBe(before);
      expect(lastLive(studio1)?.session).toMatchObject({ details: null });
    });

    it("takes no report once the session is over, so nothing revives it", async () => {
      await startIn(local, "a", "Alpha");
      await stop(local, "a");

      expect(await publish(local, "a")).toBe(false);

      expect(lastLive(studio1)?.session).toBeNull();
    });

    it("starts the next session with no details of the last", async () => {
      await startIn(local, "a", "Alpha");
      await publish(local, "a");

      await startIn(studio1, "b", "Remote R");

      expect(lastLive(local)?.session).toMatchObject({ sessionId: "b", details: null });
    });

    it("refuses a malformed report", async () => {
      await startIn(local, "a", "Alpha");

      await expect(
        publish(local, "a", details({ targetTitle: "x".repeat(10_000) }))
      ).rejects.toThrow();
      await expect(publish(local, "a", details({ phase: "idle" }))).rejects.toThrow();
      await expect(
        publish(local, "a", details({ transcript: "x".repeat(5_000) }))
      ).rejects.toThrow();
    });

    it("passes on that the app was replaced under it, so no view blames the mic (#14937)", async () => {
      await startIn(local, "a", "Alpha");
      const micNotice = { kind: "silent", bluetooth: false, appReplaced: true };

      expect(await publish(local, "a", details({ micSignal: "silent", micNotice }))).toBe(true);

      expect(await invoke(CHANNELS.VOICE_INPUT_GET_LIVE_SESSION, studio1)).toMatchObject({
        session: { details: { micNotice } },
      });
    });

    it("sends about ten level readings a second however fast chunks arrive", async () => {
      await startIn(local, "a", "Alpha");

      for (let i = 0; i < 10; i++) {
        sendTone("a", local);
        clock += 20;
      }

      // 200ms of chunks every 20ms: one reading per 80ms.
      expect(levels(studio1)).toHaveLength(3);
    });

    it("meters each chunk on the owner's scale: silence at rest, loud speech capped", async () => {
      await startIn(local, "a", "Alpha");

      for (const amplitude of [0, 1638, 3277, 16384]) {
        sendTone("a", local, amplitude);
        clock += 100;
      }

      const readings = levels(studio1).map((reading) => reading.level);
      expect(readings).toHaveLength(4);
      expect(readings[0]).toBe(0);
      expect(readings[1]).toBeCloseTo(0.3, 2);
      expect(readings[2]).toBeCloseTo(0.6, 2);
      expect(readings[3]).toBe(1);
    });

    it("sends no level for audio from a view that doesn't own the session", async () => {
      await startIn(local, "a", "Alpha");

      sendTone("a", studio2);

      expect(levels(studio1)).toEqual([]);
    });

    it("asks nobody to pause a session that isn't the live one", async () => {
      await startIn(local, "a", "Alpha");

      expect(
        await invoke(CHANNELS.VOICE_INPUT_SET_PAUSED_LIVE, studio1, {
          sessionId: "old",
          paused: true,
        })
      ).toBe(false);
      await stop(local, "a");
      expect(
        await invoke(CHANNELS.VOICE_INPUT_SET_PAUSED_LIVE, studio1, {
          sessionId: "a",
          paused: true,
        })
      ).toBe(false);

      expect(sentOn(local, CHANNELS.VOICE_INPUT_PAUSE_REQUESTED)).toEqual([]);
    });
  });

  describe("keeping the dictating view", () => {
    it("holds the view from the start, and briefly past a cancel for its ending", async () => {
      const starting = startIn(local, "a");
      expect(held(local)).toBe(true);
      await starting;
      expect(held(studio1)).toBe(false);
      vi.useFakeTimers();

      await cancel(local, "a");
      expect(held(local)).toBe(true);

      vi.advanceTimersByTime(5_000);
      expect(held(local)).toBe(false);
    });

    it("keeps holding it after a stop, for the cleanup the renderer asks for next", async () => {
      await startIn(local, "a");
      vi.useFakeTimers();

      await stop(local, "a");
      expect(held(local)).toBe(true);

      vi.advanceTimersByTime(5_000);
      expect(held(local)).toBe(false);
    });

    it("keeps a replaced session's view past its drain, for the words it still commits", async () => {
      await startIn(local, "a");

      await startIn(studio1, "b");

      expect(ended(local)).toEqual([{ sessionId: "a", reason: "superseded" }]);
      expect(held(local)).toBe(true);
      expect(held(studio1)).toBe(true);
    });

    it("lets go of a view that went away", async () => {
      await startIn(local, "a");

      local.destroy();

      // Asked by id, as a view reusing nothing of the old one would be.
      const sameId = { id: local.id, isDestroyed: () => false } as unknown as Electron.WebContents;
      expect(isDictationViewHeld(sameId)).toBe(false);
    });

    it("lets go of every hold when the handlers go away", async () => {
      await startIn(local, "a");
      await stop(local, "a");
      expect(held(local)).toBe(true);

      cleanup();
      cleanup = () => {};

      expect(held(local)).toBe(false);
    });
  });
});

describe("voiceInput — an app bundle replaced under it (#14937)", () => {
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    bundle.replaced = false;
    bundle.launchable = false;
    cleanup = registerVoiceInputHandlers({
      mainWindow: { webContents: { send: vi.fn() }, isDestroyed: () => false },
    } as unknown as Parameters<typeof registerVoiceInputHandlers>[0]);
  });

  afterEach(() => {
    cleanup?.();
  });

  it("answers whether the bundle on disk is still the one running", async () => {
    const ask = () => getHandler(CHANNELS.VOICE_INPUT_IS_APP_REPLACED)({ sender: makeSender() });
    expect(await ask()).toBe(false);

    bundle.replaced = true;
    expect(await ask()).toBe(true);
  });

  it("restarts into the new bundle, keeping the session", async () => {
    bundle.replaced = true;
    bundle.launchable = true;

    expect(
      await getHandler(CHANNELS.VOICE_INPUT_RESTART_REPLACED_APP)({ sender: makeSender() })
    ).toBe(true);
    expect(relaunchApp).toHaveBeenCalledExactlyOnceWith("bundle-replaced");
  });

  it("restarts into a bundle that was put back as it was, since the user asked", async () => {
    bundle.launchable = true;

    expect(
      await getHandler(CHANNELS.VOICE_INPUT_RESTART_REPLACED_APP)({ sender: makeSender() })
    ).toBe(true);
    expect(relaunchApp).toHaveBeenCalledExactlyOnceWith("bundle-replaced");
  });

  it("refuses a restart with no bundle to come back up as", async () => {
    bundle.replaced = true;

    expect(
      await getHandler(CHANNELS.VOICE_INPUT_RESTART_REPLACED_APP)({ sender: makeSender() })
    ).toBe(false);
    expect(relaunchApp).not.toHaveBeenCalled();
  });
});
