import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceInputSettings } from "../../../../shared/types/ipc/api.js";

vi.mock("../localSpeech.js", () => ({
  getLocalSpeechModels: vi.fn(),
  getLocalSpeechHost: vi.fn(),
}));
vi.mock("../../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  LOCAL_DRAIN_TIMEOUT_CODE,
  LOCAL_DRAIN_TIMEOUT_MS,
  LOCAL_MODEL_FAILED_CODE,
  LOCAL_START_TIMEOUT_MS,
  LOCAL_MODEL_MISSING_CODE,
  LocalTranscriptionProvider,
} from "../LocalTranscriptionProvider.js";
import type { LocalSpeechLeaseHandlers } from "../localSpeechProcess.js";
import type {
  LocalSpeechWorkerInbound,
  LocalSpeechWorkerOutbound,
} from "../localSpeechWorkerProtocol.js";
import type { VoiceTranscriptionEvent } from "../TranscriptionProvider.js";

type SessionMessage = Extract<LocalSpeechWorkerOutbound, { session: number }>;

const SETTINGS = { language: "fr", transcriptionProvider: "local" } as VoiceInputSettings;

function harness(options: { readyDir?: string | null; acquireFails?: boolean } = {}) {
  const posted: LocalSpeechWorkerInbound[] = [];
  const leases: Array<{
    session: number;
    handlers: LocalSpeechLeaseHandlers;
    released: boolean;
    abandoned: boolean;
  }> = [];
  let nextSession = 1;
  let resolveAcquire: (() => void) | null = null;
  const invalidate = vi.fn();
  const provider = new LocalTranscriptionProvider({
    models: () => ({
      readyDir: async () => (options.readyDir === undefined ? "/models/rev" : options.readyDir),
      invalidate,
    }),
    host: () => ({
      acquire: async (_dir, handlers) => {
        if (options.acquireFails) throw new Error("load failed");
        await new Promise<void>((resolve) => (resolveAcquire = resolve));
        const lease = { session: nextSession++, handlers, released: false, abandoned: false };
        leases.push(lease);
        return {
          session: lease.session,
          post: (message: LocalSpeechWorkerInbound) => {
            if (lease.released) return false;
            posted.push(message);
            return true;
          },
          release: () => {
            lease.released = true;
          },
          abandon: () => {
            lease.released = true;
            lease.abandoned = true;
          },
        };
      },
    }),
  });
  const events: VoiceTranscriptionEvent[] = [];
  provider.onEvent((event) => events.push(event));
  const deliver = (message: SessionMessage, lease = leases.at(-1)!) =>
    lease.handlers.onMessage(message);
  const loaded = async () => {
    await vi.waitFor(() => expect(resolveAcquire).not.toBeNull());
    resolveAcquire!();
    resolveAcquire = null;
    await vi.waitFor(() => expect(posted.some((m) => m.type === "start")).toBe(true));
  };
  const start = async () => {
    const started = provider.start(SETTINGS, "voice-1");
    await loaded();
    const session = leases.at(-1)!.session;
    deliver({ type: "started", session, vad: true });
    expect(await started).toEqual({ ok: true });
    return session;
  };
  return { provider, posted, leases, events, deliver, loaded, start, invalidate };
}

const pcm = (n: number) => new Int16Array(n).buffer;

afterEach(() => {
  vi.useRealTimers();
});

describe("LocalTranscriptionProvider", () => {
  it("starts the session in the language's prompt and reports recording", async () => {
    const h = harness();
    const session = await h.start();
    expect(h.posted).toContainEqual({ type: "start", session, promptId: 8 });
    const statuses = h.events.flatMap((e) => (e.type === "status" ? [e.status] : []));
    expect(statuses).toEqual(["connecting", "recording"]);
    expect(h.events).toContainEqual({ type: "terms_sent", terms: [] });
  });

  it("holds audio and an Enter from before the model was ready, and sends them in order", async () => {
    const h = harness();
    const started = h.provider.start(SETTINGS, "voice-1");
    const first = pcm(10);
    const second = pcm(20);
    h.provider.sendAudioChunk(first);
    h.provider.commitParagraphBoundary();
    h.provider.sendAudioChunk(second);
    await h.loaded();
    const session = h.leases[0].session;
    expect(h.posted.map((m) => m.type)).toEqual(["start"]);
    h.deliver({ type: "started", session, vad: true });
    await started;
    expect(h.posted.slice(1)).toEqual([
      { type: "audio", session, pcm: first },
      { type: "cut", session },
      { type: "audio", session, pcm: second },
    ]);
    const third = pcm(5);
    h.provider.sendAudioChunk(third);
    expect(h.posted.at(-1)).toEqual({ type: "audio", session, pcm: third });
  });

  it("turns previews and closed passages into deltas and completions", async () => {
    const h = harness();
    const session = await h.start();
    h.events.length = 0;
    h.deliver({ type: "text", session, segment: 0, text: "send it" });
    h.deliver({ type: "speech-start", session });
    h.deliver({
      type: "segment",
      session,
      segment: 0,
      text: "send it",
      shown: true,
      reason: "pause",
      endOfSpeech: true,
    });
    h.deliver({
      type: "segment",
      session,
      segment: 1,
      text: "and more",
      shown: true,
      reason: "pause",
      endOfSpeech: false,
    });
    h.deliver({
      type: "segment",
      session,
      segment: 2,
      text: "cut here",
      shown: true,
      reason: "cut",
      endOfSpeech: false,
    });
    h.deliver({
      type: "segment",
      session,
      segment: 3,
      text: "",
      shown: true,
      reason: "finish",
      endOfSpeech: false,
    });
    h.deliver({
      type: "segment",
      session,
      segment: 4,
      text: "",
      shown: false,
      reason: "finish",
      endOfSpeech: false,
    });
    expect(h.events).toEqual([
      { type: "delta", text: "send it", itemId: `local-${session}-0`, replace: true },
      { type: "speech_started" },
      {
        type: "complete",
        text: "send it",
        itemId: `local-${session}-0`,
        endsAtPause: true,
        paused: true,
        endOfSpeech: true,
      },
      // The speaker went on before the pause closed: no send.
      {
        type: "complete",
        text: "and more",
        itemId: `local-${session}-1`,
        endsAtPause: true,
        paused: true,
      },
      { type: "complete", text: "cut here", itemId: `local-${session}-2` },
      // A preview with nothing final retires; a passage never shown is skipped.
      { type: "complete", text: "", itemId: `local-${session}-3` },
    ]);
  });

  it("drains on a graceful stop: finish, wait for the worker, then idle", async () => {
    const h = harness();
    const session = await h.start();
    const stopped = h.provider.stopGracefully();
    expect(h.posted.at(-1)).toEqual({ type: "finish", session });
    h.provider.sendAudioChunk(pcm(4));
    expect(h.posted.at(-1)).toEqual({ type: "finish", session });
    h.deliver({
      type: "segment",
      session,
      segment: 0,
      text: "last words",
      shown: true,
      reason: "finish",
      endOfSpeech: false,
    });
    h.deliver({ type: "finished", session });
    await stopped;
    const tail = h.events.slice(-3);
    expect(tail[0]).toEqual({ type: "status", status: "finishing" });
    expect(tail[1]).toMatchObject({ type: "complete", text: "last words" });
    expect(tail[2]).toEqual({ type: "status", status: "idle" });
    expect(h.leases[0].released).toBe(true);
  });

  it("finishes audio held while the model loads when stopped before it is ready", async () => {
    const h = harness();
    const started = h.provider.start(SETTINGS, "voice-1");
    h.provider.sendAudioChunk(pcm(10));
    const stopped = h.provider.stopGracefully();
    await h.loaded();
    const session = h.leases[0].session;
    h.deliver({ type: "started", session, vad: true });
    await started;
    expect(h.posted.map((m) => m.type)).toEqual(["start", "audio", "finish"]);
    h.deliver({ type: "finished", session });
    await stopped;
    expect(h.events.at(-1)).toEqual({ type: "status", status: "idle" });
  });

  it("ends at once when stopped before the model was ready with nothing heard", async () => {
    const h = harness();
    const started = h.provider.start(SETTINGS, "voice-1");
    await h.provider.stopGracefully();
    expect(await started).toMatchObject({ ok: false });
    expect(h.events.at(-1)).toEqual({ type: "status", status: "idle" });
  });

  it("gives up a drain the worker never answers", async () => {
    const h = harness();
    await h.start();
    vi.useFakeTimers();
    const stopped = h.provider.stopGracefully();
    await vi.advanceTimersByTimeAsync(LOCAL_DRAIN_TIMEOUT_MS);
    await stopped;
    expect(h.events.at(-1)).toEqual({ type: "status", status: "idle" });
  });

  it("lands what was shown as incomplete when the worker never finishes, and replaces it", async () => {
    const h = harness();
    const session = await h.start();
    h.deliver({ type: "text", session, segment: 2, text: "and then send" });
    vi.useFakeTimers();
    const stopped = h.provider.stopGracefully();
    await vi.advanceTimersByTimeAsync(LOCAL_DRAIN_TIMEOUT_MS);
    await stopped;
    const tail = h.events.slice(-3);
    expect(tail[0]).toEqual({
      type: "complete",
      text: "and then send",
      itemId: `local-${session}-2`,
      incomplete: true,
    });
    expect(tail[1]).toEqual({
      type: "error",
      error: expect.objectContaining({ severity: "transient", code: LOCAL_DRAIN_TIMEOUT_CODE }),
    });
    expect(tail[2]).toEqual({ type: "status", status: "idle" });
    expect(h.leases[0].abandoned).toBe(true);
  });

  it("gives up on a loaded model that never begins the session, and replaces it", async () => {
    const h = harness();
    const started = h.provider.start(SETTINGS, "voice-1");
    await h.loaded();
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(LOCAL_START_TIMEOUT_MS);
    expect(await started).toMatchObject({ ok: false });
    expect(h.leases[0].abandoned).toBe(true);
    expect(h.events.at(-1)).toEqual({ type: "status", status: "error" });
  });

  it("ignores a loss reported for a session already ended", async () => {
    const h = harness();
    await h.start();
    const firstLease = h.leases[0];
    h.provider.stop();
    await h.start();
    const before = h.events.length;
    firstLease.handlers.onLost();
    expect(h.events.length).toBe(before);
  });

  it("fails the start with a fix when the model isn't downloaded", async () => {
    const h = harness({ readyDir: null });
    const result = await h.provider.start(SETTINGS, "voice-1");
    expect(result).toMatchObject({ ok: false });
    expect(h.events).toContainEqual({
      type: "error",
      error: expect.objectContaining({ severity: "fatal", code: LOCAL_MODEL_MISSING_CODE }),
    });
    expect(h.events.at(-1)).toEqual({ type: "status", status: "error" });
  });

  it("fails the start and has the files checked again when the model won't load", async () => {
    const h = harness({ acquireFails: true });
    const result = await h.provider.start(SETTINGS, "voice-1");
    expect(result).toMatchObject({ ok: false });
    expect(h.invalidate).toHaveBeenCalled();
    expect(h.events).toContainEqual({
      type: "error",
      error: expect.objectContaining({ code: LOCAL_MODEL_FAILED_CODE }),
    });
  });

  it("ends the session when the speech process goes", async () => {
    const h = harness();
    await h.start();
    h.leases[0].handlers.onLost();
    expect(h.events.slice(-2)).toEqual([
      { type: "error", error: expect.objectContaining({ code: LOCAL_MODEL_FAILED_CODE }) },
      { type: "status", status: "error" },
    ]);
  });

  it("never emits what an earlier session's lease still delivers", async () => {
    const h = harness();
    const first = await h.start();
    const firstLease = h.leases[0];
    h.provider.stop();
    await h.start();
    const before = h.events.length;
    h.deliver({ type: "text", session: first, segment: 0, text: "stale" }, firstLease);
    expect(h.events.length).toBe(before);
    expect(firstLease.released).toBe(true);
  });

  it("counts audio past the connect buffer and warns once", async () => {
    const h = harness();
    void h.provider.start(SETTINGS, "voice-1");
    for (let i = 0; i < 152; i++) h.provider.sendAudioChunk(pcm(2400));
    const overflow = h.events.filter((e) => e.type === "error");
    expect(overflow).toHaveLength(1);
    await h.loaded();
    const session = h.leases[0].session;
    h.deliver({ type: "started", session, vad: true });
    // The passage closes where audio was lost, so no command spans the gap.
    const sent = h.posted.filter((m) => m.type === "audio" || m.type === "gap");
    expect(sent).toHaveLength(151);
    expect(sent.at(-1)).toEqual({ type: "gap", session });
    h.deliver({
      type: "segment",
      session,
      segment: 0,
      text: "fix it and send",
      shown: true,
      reason: "gap",
      endOfSpeech: false,
    });
    h.deliver({
      type: "segment",
      session,
      segment: 1,
      text: "",
      shown: false,
      reason: "gap",
      endOfSpeech: false,
    });
    expect(h.events.slice(-2)).toEqual([
      { type: "complete", text: "fix it and send", itemId: `local-${session}-0`, incomplete: true },
      { type: "complete", text: "", incomplete: true },
    ]);
    expect(h.provider.getSessionStats()).toEqual({
      delayTier: "none",
      droppedConnect: 2,
      droppedReplay: 0,
      reconnects: 0,
    });
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
