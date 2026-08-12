import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { RemoteEnvelope } from "../../../../shared/types/remote/index.js";
import { RemoteConsoleObservationService } from "../RemoteConsoleObservationService.js";
import type { RemoteProjectDetailProjectionService } from "../RemoteProjectDetailProjectionService.js";
import type { RemoteSession } from "../RemoteSessionRegistry.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const events = new EventEmitter();
  const sent: RemoteEnvelope[] = [];
  const errors: Array<{ requestId: string; code: string }> = [];
  const removals = new Set<(connectionId: string, streamId: string) => void>();
  const pty = Object.assign(events, {
    beginConsoleObservation: vi.fn(),
    endConsoleObservation: vi.fn(),
  });
  const detail = {
    snapshot: vi.fn(async () => ({
      revision: 9,
      worktrees: [{ id: "worktree-1" }],
      agents: [
        {
          projectId: "project-1",
          worktreeId: "worktree-1",
          panelId: "panel-1",
          launchGeneration: 4,
        },
      ],
    })),
    validateBinding: vi.fn(() => ({ ok: true as const })),
  } as unknown as RemoteProjectDetailProjectionService;
  const sessions = {
    onConsoleStreamRemoved(listener: (connectionId: string, streamId: string) => void) {
      removals.add(listener);
      return () => removals.delete(listener);
    },
    cancelConsoleSubscription: vi.fn(),
    onSessionRemoved(listener: (connectionId: string) => void) {
      const wrapped = (connectionId: string, streamId: string) => {
        if (streamId === "__session__") listener(connectionId);
      };
      removals.add(wrapped);
      return () => removals.delete(wrapped);
    },
  };
  const sender = {
    sendApplicationEnvelope: vi.fn((_connectionId: string, envelope: RemoteEnvelope) => {
      sent.push(envelope);
    }),
    sendApplicationError: vi.fn((_connectionId: string, requestId: string, code: string) =>
      errors.push({ requestId, code })
    ),
  };
  const service = new RemoteConsoleObservationService(
    detail,
    pty,
    sessions,
    sender,
    () => "stream-1"
  );
  const session = {
    id: "session-1",
    connection: { id: "connection-1" },
    capabilities: ["observe-projects"],
  } as RemoteSession;
  const target = {
    projectId: "project-1",
    worktreeId: "worktree-1",
    panelId: "panel-1",
    launchGeneration: 4,
  };
  return { service, session, target, pty, sent, errors, removals, sessions };
}

describe("RemoteConsoleObservationService", () => {
  it("delivers an atomic snapshot before every output chunk after its watermark", async () => {
    const f = fixture();
    const observation = deferred<{
      mode: "snapshot";
      throughSeq: number;
      state: { data: string; cols: number; rows: number };
      chunks: [];
    }>();
    f.pty.beginConsoleObservation.mockReturnValue(observation.promise);

    const subscribing = f.service.subscribe(f.session, "request-1", f.target);
    await Promise.resolve();
    f.pty.emit("console-output", {
      id: "panel-1",
      observerId: "stream-1",
      launchGeneration: 4,
      seq: 1,
      data: "YWZ0ZXI=",
      encoding: "base64",
      bytes: 5,
    });
    observation.resolve({
      mode: "snapshot",
      throughSeq: 0,
      state: { data: "before", cols: 80, rows: 24 },
      chunks: [],
    });
    await subscribing;

    expect(f.sent.map(({ type }) => type)).toEqual(["console.snapshot", "console.output"]);
    expect(f.sent[0]).toMatchObject({
      payload: { mode: "snapshot", throughSeq: 0, snapshot: { data: "before" } },
    });
    expect(f.sent[1]).toMatchObject({ streamId: "stream-1", seq: 1, payload: { bytes: 5 } });
  });

  it("resumes from retained contiguous chunks without manufacturing a snapshot", async () => {
    const f = fixture();
    f.pty.beginConsoleObservation.mockResolvedValue({
      mode: "resume",
      throughSeq: 7,
      state: null,
      chunks: [
        { seq: 6, data: "YQ==", encoding: "base64", bytes: 1 },
        { seq: 7, data: "Yg==", encoding: "base64", bytes: 1 },
      ],
    });

    await f.service.subscribe(f.session, "request-1", { ...f.target, afterSeq: 5 });

    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({
      type: "console.snapshot",
      payload: { mode: "resume", throughSeq: 7, snapshot: null, chunks: [{ seq: 6 }, { seq: 7 }] },
    });
  });

  it("turns retained-history gaps and generation invalidation into typed resync events", async () => {
    const f = fixture();
    f.pty.beginConsoleObservation.mockResolvedValue({
      mode: "resync",
      reason: "gap",
      throughSeq: 12,
      state: null,
      chunks: [],
    });
    await f.service.subscribe(f.session, "request-1", { ...f.target, afterSeq: 2 });

    expect(f.sent.map(({ type }) => type)).toEqual(["console.snapshot", "console.resyncRequired"]);
    expect(f.sent[1]).toMatchObject({ payload: { streamId: "stream-1", reason: "gap" } });
    expect(f.pty.endConsoleObservation).toHaveBeenCalledWith("panel-1", "stream-1");
  });

  it("invalidates a live stream when its terminal generation or PTY host changes", async () => {
    const f = fixture();
    f.pty.beginConsoleObservation.mockResolvedValue({
      mode: "snapshot",
      throughSeq: 0,
      state: { data: "", cols: 80, rows: 24 },
      chunks: [],
    });
    await f.service.subscribe(f.session, "request-1", f.target);
    f.pty.emit("console-invalidated", {
      id: "panel-1",
      observerId: "stream-1",
      launchGeneration: 4,
      reason: "generation-changed",
    });

    expect(f.sent.at(-1)).toMatchObject({
      type: "console.resyncRequired",
      payload: { reason: "generation-changed" },
    });
    expect(f.pty.endConsoleObservation).toHaveBeenCalledWith("panel-1", "stream-1");
  });

  it("bounds output accumulated while a snapshot is in flight and drops only that stream", async () => {
    const f = fixture();
    const observation = deferred<{
      mode: "snapshot";
      throughSeq: number;
      state: { data: string; cols: number; rows: number };
      chunks: [];
    }>();
    f.pty.beginConsoleObservation.mockReturnValue(observation.promise);
    const subscribing = f.service.subscribe(f.session, "request-1", f.target);
    await Promise.resolve();
    for (let seq = 1; seq <= 17; seq += 1) {
      f.pty.emit("console-output", {
        id: "panel-1",
        observerId: "stream-1",
        launchGeneration: 4,
        seq,
        data: "eA==",
        encoding: "base64",
        bytes: 64 * 1024,
      });
    }
    observation.resolve({
      mode: "snapshot",
      throughSeq: 0,
      state: { data: "before", cols: 80, rows: 24 },
      chunks: [],
    });
    await subscribing;

    expect(f.sent.at(-1)).toMatchObject({
      type: "console.resyncRequired",
      payload: { reason: "queue-overflow" },
    });
    expect(f.pty.endConsoleObservation).toHaveBeenCalledWith("panel-1", "stream-1");
  });

  it("rejects a serialized snapshot above the remote transfer cap", async () => {
    const f = fixture();
    f.pty.beginConsoleObservation.mockResolvedValue({
      mode: "snapshot",
      throughSeq: 0,
      state: { data: "x".repeat(5 * 1024 * 1024 + 1), cols: 80, rows: 24 },
      chunks: [],
    });

    await f.service.subscribe(f.session, "request-1", f.target);

    expect(f.sent).toEqual([]);
    expect(f.errors).toEqual([{ requestId: "request-1", code: "HOST_RESOURCE_PRESSURE" }]);
    expect(f.pty.endConsoleObservation).toHaveBeenCalledWith("panel-1", "stream-1");
  });

  it("returns a request error when the host cannot produce an initial snapshot", async () => {
    const f = fixture();
    f.pty.beginConsoleObservation.mockResolvedValue({
      mode: "snapshot",
      throughSeq: 0,
      state: null,
      chunks: [],
    });

    await f.service.subscribe(f.session, "request-1", f.target);

    expect(f.sent).toEqual([]);
    expect(f.errors).toEqual([{ requestId: "request-1", code: "HOST_UI_UNAVAILABLE" }]);
    expect(f.pty.endConsoleObservation).toHaveBeenCalledWith("panel-1", "stream-1");
  });

  it("tears observations down on unsubscribe and session removal", async () => {
    const f = fixture();
    f.pty.beginConsoleObservation.mockResolvedValue({
      mode: "snapshot",
      throughSeq: 0,
      state: { data: "", cols: 80, rows: 24 },
      chunks: [],
    });
    await f.service.subscribe(f.session, "request-1", f.target);
    f.service.unsubscribe(f.session, "request-2", "stream-1");

    expect(f.pty.endConsoleObservation).toHaveBeenCalledWith("panel-1", "stream-1");
    expect(f.sent.at(-1)).toMatchObject({ type: "console.unsubscribe", requestId: "request-2" });

    const pending = fixture();
    const observation = deferred<{
      mode: "snapshot";
      throughSeq: number;
      state: { data: string; cols: number; rows: number };
      chunks: [];
    }>();
    pending.pty.beginConsoleObservation.mockReturnValue(observation.promise);
    const subscribing = pending.service.subscribe(pending.session, "request-3", pending.target);
    await Promise.resolve();
    for (const remove of pending.removals) remove("connection-1", "__session__");
    observation.resolve({
      mode: "snapshot",
      throughSeq: 0,
      state: { data: "", cols: 80, rows: 24 },
      chunks: [],
    });
    await subscribing;
    expect(pending.sent).toEqual([]);
    expect(pending.pty.endConsoleObservation).toHaveBeenCalledWith("panel-1", "stream-1");
    expect(pending.sessions.cancelConsoleSubscription).toHaveBeenCalledWith(
      "connection-1",
      "request-3"
    );
  });
});
