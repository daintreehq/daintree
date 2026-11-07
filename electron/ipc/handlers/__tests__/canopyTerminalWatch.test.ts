import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { PtyClient } from "../../../services/PtyClient.js";
import {
  activeTerminalWatches,
  assistantWatchSlot,
  beginWatchRequest,
  claimWatchedRunSize,
  claimWatchedSize,
  followDriveLeaseChange,
  onSizeHoldsChange,
  releaseViewSizeHolds,
  resizeWatchedTerminal,
  sizeHolds,
  stopAllTerminalWatches,
  stopTerminalWatch,
  stopTerminalWatchById,
  stopWorkerTerminalWatches,
  watchTerminal,
  watchedTerminal,
  yieldSizeToPane,
} from "../canopyTerminalWatch.js";

function fakePty(snapshot: unknown = { data: "screen", cols: 120, rows: 36 }) {
  const emitter = new EventEmitter();
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  const pending: Array<(value: unknown) => void> = [];
  /** The launch generation the host tracks for every id; bumped by a respawn. */
  const generation = { current: 1 };
  const pty = Object.assign(emitter, {
    getLiveGeneration: vi.fn(() => generation.current),
    isLiveGeneration: vi.fn((_id: string, live: number) => live === generation.current),
    acquireIpcDataMirror: vi.fn(() => {
      const release = vi.fn();
      releases.push(release);
      return release;
    }),
    resize: vi.fn(),
    getSerializedStateAsync: vi.fn(
      () =>
        new Promise((resolve) => {
          if (snapshot === "manual") pending.push(resolve);
          else resolve(snapshot);
        })
    ),
  });
  return {
    pty: pty as unknown as PtyClient,
    emitter,
    generation,
    releases,
    resolveSnapshots: (value: unknown) => pending.splice(0).forEach((resolve) => resolve(value)),
  };
}

function fakeSender(id = 1) {
  const sent: unknown[] = [];
  const sender = {
    id,
    isDestroyed: () => false,
    send: vi.fn((_channel: string, payload: unknown) => sent.push(payload)),
  };
  return { sender: sender as unknown as WebContents, sent };
}

/** Open a watch the way the IPC op does: claim the request, then start it. */
function open(pty: PtyClient, sender: WebContents, runId: string, spawnedAt = 100) {
  return watchTerminal(pty, sender, runId, spawnedAt, beginWatchRequest(sender.id));
}

afterEach(() => stopAllTerminalWatches());

describe("watchTerminal", () => {
  it("streams only the watched run, tagged for the view, from both transports", async () => {
    const { pty, emitter } = fakePty();
    const { sender, sent } = fakeSender();
    const view = await open(pty, sender, "run-1");

    emitter.emit("data-mirror", "run-1", "a", 10);
    emitter.emit("data", "other", "x", undefined, 5);
    // `data` carries its routing before the offset.
    emitter.emit("data", "run-1", "b", undefined, 12);

    expect(sent).toEqual([
      { kind: "data", watchId: view.watchId, runId: "run-1", data: "a", streamEnd: 10 },
      { kind: "data", watchId: view.watchId, runId: "run-1", data: "b", streamEnd: 12 },
    ]);
  });

  it("drops a chunk it already forwarded, such as a port-recovery resend", async () => {
    const { pty, emitter } = fakePty();
    const { sender, sent } = fakeSender();
    await open(pty, sender, "run-1");
    emitter.emit("data-mirror", "run-1", "a", 10);
    emitter.emit("data", "run-1", "a", { portRecoveryWebContentsId: 3 }, 10);
    expect(sent).toHaveLength(1);
  });

  it("hands back the snapshot with the offset the view fences against", async () => {
    const continuation = { pendingEscapeTail: "", streamOffset: 42 };
    const { pty } = fakePty({ data: "screen", cols: 100, rows: 30, continuation });
    const view = await open(pty, fakeSender().sender, "run-1");
    expect(view.snapshot).toEqual({ data: "screen", cols: 100, rows: 30, continuation });
  });

  it("follows the PTY's size, whoever sets it", async () => {
    const { pty, emitter } = fakePty();
    const { sender, sent } = fakeSender();
    const view = await open(pty, sender, "run-1");
    emitter.emit("resize-result", "run-1", { appliedCols: 90, appliedRows: 20 });
    emitter.emit("resize-result", "run-1", { appliedCols: null, appliedRows: null });
    expect(sent).toEqual([
      { kind: "resize", watchId: view.watchId, runId: "run-1", cols: 90, rows: 20 },
    ]);
  });

  it("ends with its terminal, so nothing can type to a successor under the same id", async () => {
    for (const ending of ["exit", "host-crash"] as const) {
      const { pty, emitter, releases } = fakePty();
      const { sender, sent } = fakeSender();
      const view = await open(pty, sender, "run-1");
      if (ending === "exit") emitter.emit("exit", "run-1", 0);
      else emitter.emit("host-crash", 1);
      expect(sent).toEqual([{ kind: "ended", watchId: view.watchId, runId: "run-1" }]);
      expect(watchedTerminal(1, view.watchId!)).toBeNull();
      expect(releases[0]).toHaveBeenCalledTimes(1);
    }
  });

  it("names the terminal a view may type to only through its current stream", async () => {
    const { pty } = fakePty();
    const { sender } = fakeSender();
    const first = await open(pty, sender, "run-1", 100);
    expect(watchedTerminal(1, first.watchId!)).toEqual({
      runId: "run-1",
      spawnedAt: 100,
      assistant: false,
      mayType: true,
    });
    const second = await open(pty, sender, "run-2", 200);
    expect(watchedTerminal(1, first.watchId!)).toBeNull();
    expect(watchedTerminal(1, second.watchId!)).toMatchObject({ runId: "run-2", spawnedAt: 200 });
  });

  it("holds one watch per view: a new one ends the last and frees its mirror", async () => {
    const { pty, emitter, releases } = fakePty();
    const { sender, sent } = fakeSender();
    await open(pty, sender, "run-1");
    await open(pty, sender, "run-2");
    expect(releases[0]).toHaveBeenCalledTimes(1);
    emitter.emit("data-mirror", "run-1", "old", 1);
    expect(sent).toEqual([]);
    expect(activeTerminalWatches().get(1)?.runId).toBe("run-2");
  });

  it("starts nothing for a request cancelled while its snapshot was read", async () => {
    const { pty, emitter, resolveSnapshots, releases } = fakePty("manual");
    const { sender, sent } = fakeSender();
    const pending = open(pty, sender, "run-1");
    // The panel closed, or the view moved on, mid-read.
    stopTerminalWatch(1);
    resolveSnapshots({ data: "x", cols: 80, rows: 24 });
    expect(await pending).toEqual({ watchId: null, snapshot: null });
    emitter.emit("data-mirror", "run-1", "late", 3);
    expect(sent).toEqual([]);
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(activeTerminalWatches().size).toBe(0);
  });

  it("answers an overtaken request with no stream and keeps the newer one", async () => {
    const { pty, resolveSnapshots } = fakePty("manual");
    const { sender } = fakeSender();
    const first = open(pty, sender, "run-1");
    const second = open(pty, sender, "run-2");
    resolveSnapshots({ data: "x", cols: 80, rows: 24 });
    expect((await first).watchId).toBeNull();
    expect((await second).watchId).not.toBeNull();
    expect(activeTerminalWatches().get(1)?.runId).toBe("run-2");
  });

  it("unwinds a watch whose mirror could not be taken", async () => {
    const { pty, emitter } = fakePty();
    vi.mocked(pty.acquireIpcDataMirror).mockImplementationOnce(() => {
      throw new Error("host gone");
    });
    await expect(open(pty, fakeSender().sender, "run-1")).rejects.toThrow("host gone");
    expect(emitter.listenerCount("data-mirror")).toBe(0);
    expect(activeTerminalWatches().size).toBe(0);
  });

  it("stops listening and frees the mirror when the view stops watching", async () => {
    const { pty, emitter, releases } = fakePty();
    const { sender, sent } = fakeSender();
    await open(pty, sender, "run-1");
    stopTerminalWatch(1);
    emitter.emit("data-mirror", "run-1", "late", 3);
    expect(sent).toEqual([]);
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount("data-mirror")).toBe(0);
  });
});

describe("the global assistant's slot (#16214)", () => {
  /** Open the global assistant's stream as the assistant op does, in its own slot. */
  function openGlobal(pty: PtyClient, sender: WebContents, runId = "global-1", spawnedAt = 300) {
    return watchTerminal(
      pty,
      sender,
      runId,
      spawnedAt,
      beginWatchRequest(sender.id, "global"),
      undefined,
      () => true,
      { isBound: () => true, onEnded: () => () => {}, mayType: () => true },
      false,
      "global"
    );
  }

  it("takes the global session's own slot, and every other subject the pane's", () => {
    expect(assistantWatchSlot({ scope: { kind: "global" } })).toBe("global");
    expect(assistantWatchSlot({ scope: { kind: "project", projectId: "p1" } })).toBe("detail");
    expect(assistantWatchSlot(null)).toBe("detail");
    expect(assistantWatchSlot({ scope: "global" })).toBe("detail");
  });

  it("streams beside the selected run, and a new selection leaves it open", async () => {
    const { pty, emitter, releases } = fakePty();
    const { sender, sent } = fakeSender();
    const global = await openGlobal(pty, sender);
    const first = await open(pty, sender, "run-1");
    await open(pty, sender, "run-2");
    // Only the pane's own stream was replaced.
    expect(releases).toHaveLength(3);
    expect(releases[0]).not.toHaveBeenCalled();
    expect(releases[1]).toHaveBeenCalledTimes(1);
    expect(watchedTerminal(1, first.watchId!)).toBeNull();
    expect(watchedTerminal(1, global.watchId!)).toMatchObject({
      runId: "global-1",
      assistant: true,
    });
    emitter.emit("data-mirror", "global-1", "g", 5);
    emitter.emit("data-mirror", "run-2", "w", 6);
    expect(sent).toEqual([
      expect.objectContaining({ watchId: global.watchId, runId: "global-1", data: "g" }),
      expect.objectContaining({ runId: "run-2", data: "w" }),
    ]);
    expect(activeTerminalWatches().get(1)?.runId).toBe("run-2");
    expect(activeTerminalWatches("global").get(1)?.runId).toBe("global-1");
  });

  it("keeps each slot's request its own: one overtakes only its slot's", async () => {
    const { pty, resolveSnapshots } = fakePty("manual");
    const { sender } = fakeSender();
    const global = openGlobal(pty, sender);
    const worker = open(pty, sender, "run-1");
    resolveSnapshots({ data: "x", cols: 80, rows: 24 });
    expect((await global).watchId).not.toBeNull();
    expect((await worker).watchId).not.toBeNull();
  });

  it("lets a newer global request overtake an older one, and a pane's stop leave it be", async () => {
    const { pty, resolveSnapshots } = fakePty("manual");
    const { sender } = fakeSender();
    const older = openGlobal(pty, sender, "global-1", 300);
    const newer = openGlobal(pty, sender, "global-1", 301);
    const kept = openGlobal(pty, sender, "global-2", 302);
    stopTerminalWatch(1, "detail");
    resolveSnapshots({ data: "x", cols: 80, rows: 24 });
    expect((await older).watchId).toBeNull();
    expect((await newer).watchId).toBeNull();
    expect((await kept).watchId).not.toBeNull();
    expect(activeTerminalWatches("global").get(1)?.runId).toBe("global-2");
    const cancelled = openGlobal(pty, sender, "global-3", 303);
    stopTerminalWatch(1, "global");
    resolveSnapshots({ data: "x", cols: 80, rows: 24 });
    expect((await cancelled).watchId).toBeNull();
    expect(activeTerminalWatches("global").size).toBe(0);
  });

  it("ends one slot by its stream, or by its slot, and both when the view stops", async () => {
    const { pty, releases } = fakePty();
    const { sender } = fakeSender();
    const global = await openGlobal(pty, sender);
    await open(pty, sender, "run-1");
    stopTerminalWatch(1, "detail");
    expect(activeTerminalWatches().size).toBe(0);
    expect(activeTerminalWatches("global").get(1)?.watchId).toBe(global.watchId);
    const worker = await open(pty, sender, "run-2");
    stopTerminalWatchById(1, global.watchId!);
    expect(activeTerminalWatches("global").size).toBe(0);
    expect(activeTerminalWatches().get(1)?.watchId).toBe(worker.watchId);
    await openGlobal(pty, sender);
    stopTerminalWatch(1);
    expect(activeTerminalWatches().size).toBe(0);
    expect(activeTerminalWatches("global").size).toBe(0);
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it("sizes each of a view's terminals through its own stream", async () => {
    const { pty } = fakePty();
    const { sender } = fakeSender();
    const global = await openGlobal(pty, sender);
    const worker = await open(pty, sender, "run-1");
    resizeWatchedTerminal(pty, 1, worker.watchId!, 90, 30);
    resizeWatchedTerminal(pty, 1, global.watchId!, 70, 20);
    expect((pty.resize as unknown as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ["run-1", 90, 30],
      ["global-1", 70, 20],
    ]);
    // Letting go of one hands back only its own terminal's size.
    stopTerminalWatchById(1, global.watchId!);
    expect((pty.resize as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
      "global-1",
      120,
      36,
    ]);
    resizeWatchedTerminal(pty, 1, worker.watchId!, 100, 30);
    expect((pty.resize as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
      "run-1",
      100,
      30,
    ]);
  });
});

describe("resizeWatchedTerminal", () => {
  const resizes = (pty: PtyClient) =>
    (pty.resize as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => call.slice(1));

  /** What the host reports back for a resize of run-1. */
  const echo = (
    emitter: EventEmitter,
    requested: [number, number],
    applied: [number, number] = requested,
    outcome = "applied",
    launchGeneration = 1
  ) =>
    emitter.emit("resize-result", "run-1", {
      launchGeneration,
      requestedCols: requested[0],
      requestedRows: requested[1],
      appliedCols: applied[0],
      appliedRows: applied[1],
      outcome,
    });

  it("holds the PTY at the panel's size, then hands back its pane's size when the watch ends", async () => {
    const { pty } = fakePty();
    const { sender } = fakeSender();
    const view = await open(pty, sender, "run-1");
    resizeWatchedTerminal(pty, sender.id, view.watchId!, 90, 30);
    resizeWatchedTerminal(pty, sender.id, view.watchId!, 90, 30);
    stopTerminalWatch(sender.id);
    // The snapshot said 120×36: the size it goes back to. A repeat sends nothing.
    expect(resizes(pty)).toEqual([
      [90, 30],
      [120, 36],
    ]);
  });

  it("hands back the size the pane gave it while the panel held it", async () => {
    const { pty, emitter } = fakePty();
    const { sender } = fakeSender();
    const view = await open(pty, sender, "run-1");
    resizeWatchedTerminal(pty, sender.id, view.watchId!, 90, 30);
    // The panel's own echo, then the window resized under the pane.
    echo(emitter, [90, 30]);
    echo(emitter, [140, 40]);
    // The panel takes its size back, and on closing hands back the pane's.
    resizeWatchedTerminal(pty, sender.id, view.watchId!, 90, 30);
    echo(emitter, [90, 30]);
    stopTerminalWatch(sender.id);
    expect(resizes(pty)).toEqual([
      [90, 30],
      [90, 30],
      [140, 40],
    ]);
  });

  it("knows a late echo of an earlier hold as its own, not as the pane's size", async () => {
    const { pty, emitter } = fakePty();
    const { sender } = fakeSender();
    const view = await open(pty, sender, "run-1");
    resizeWatchedTerminal(pty, sender.id, view.watchId!, 90, 30);
    resizeWatchedTerminal(pty, sender.id, view.watchId!, 100, 32);
    echo(emitter, [90, 30]);
    echo(emitter, [100, 32]);
    stopTerminalWatch(sender.id);
    expect(resizes(pty).at(-1)).toEqual([120, 36]);
  });

  it("keeps the pane's size when a resize the pane asked for failed", async () => {
    const { pty, emitter } = fakePty();
    const { sender } = fakeSender();
    const view = await open(pty, sender, "run-1");
    resizeWatchedTerminal(pty, sender.id, view.watchId!, 90, 30);
    echo(emitter, [90, 30]);
    // A failure reports the grid the PTY still has: the panel's.
    echo(emitter, [140, 40], [90, 30], "failed");
    stopTerminalWatch(sender.id);
    expect(resizes(pty).at(-1)).toEqual([120, 36]);
  });

  it("leaves a terminal to the first window holding it", async () => {
    const { pty } = fakePty();
    const first = fakeSender(1);
    const second = fakeSender(2);
    const a = await open(pty, first.sender, "run-1");
    const b = await open(pty, second.sender, "run-1");
    resizeWatchedTerminal(pty, first.sender.id, a.watchId!, 90, 30);
    resizeWatchedTerminal(pty, second.sender.id, b.watchId!, 100, 32);
    stopTerminalWatch(second.sender.id);
    stopTerminalWatch(first.sender.id);
    expect(resizes(pty)).toEqual([
      [90, 30],
      [120, 36],
    ]);
  });

  it("ends the stream without handing back a size when the id is respawned", async () => {
    const { pty, emitter } = fakePty();
    const { sender, sent } = fakeSender();
    const view = await open(pty, sender, "run-1");
    resizeWatchedTerminal(pty, sender.id, view.watchId!, 90, 30);
    echo(emitter, [90, 30]);
    echo(emitter, [120, 36], [120, 36], "applied", 2);
    expect(sent.at(-1)).toEqual({ kind: "ended", watchId: view.watchId, runId: "run-1" });
    stopTerminalWatch(sender.id);
    expect(resizes(pty)).toEqual([[90, 30]]);
  });

  it("ends the stream when the id is respawned before any echo, typing nothing into the successor", async () => {
    const { pty, emitter, generation } = fakePty();
    const { sender, sent } = fakeSender();
    const view = await open(pty, sender, "run-1");
    // A restart under the same id: the old exit is retired without a word.
    generation.current = 2;
    expect(watchedTerminal(sender.id, view.watchId!)).toBeNull();
    expect(sent.at(-1)).toEqual({ kind: "ended", watchId: view.watchId, runId: "run-1" });
    // Nor does the successor's output reach the view.
    emitter.emit("data-mirror", "run-1", "successor", 50);
    expect(sent.some((payload) => (payload as { data?: string }).data === "successor")).toBe(false);
  });

  it("never sizes a successor under the same id, nor hands it the old pane's size", async () => {
    const { pty, generation } = fakePty();
    const { sender, sent } = fakeSender();
    const view = await open(pty, sender, "run-1");
    resizeWatchedTerminal(pty, sender.id, view.watchId!, 90, 30);
    generation.current = 2;
    resizeWatchedTerminal(pty, sender.id, view.watchId!, 100, 40);
    expect(sent.at(-1)).toEqual({ kind: "ended", watchId: view.watchId, runId: "run-1" });
    stopTerminalWatch(sender.id);
    expect(resizes(pty)).toEqual([[90, 30]]);
  });

  it("opens nothing for a terminal respawned while its snapshot was read", async () => {
    const { pty, generation, resolveSnapshots } = fakePty("manual");
    const { sender } = fakeSender();
    const opening = open(pty, sender, "run-1");
    generation.current = 2;
    resolveSnapshots({ data: "successor", cols: 80, rows: 24 });
    expect(await opening).toEqual({ watchId: null, snapshot: null });
    expect(activeTerminalWatches().size).toBe(0);
  });

  it("ends the stream on the successor's first output after a respawn", async () => {
    const { pty, emitter, generation } = fakePty();
    const { sender, sent } = fakeSender();
    const view = await open(pty, sender, "run-1");
    generation.current = 2;
    emitter.emit("data-mirror", "run-1", "successor", 50);
    expect(sent).toEqual([{ kind: "ended", watchId: view.watchId, runId: "run-1" }]);
    expect(activeTerminalWatches().size).toBe(0);
  });

  it("hands back the size when the panel moves on to another run", async () => {
    const { pty } = fakePty();
    const { sender } = fakeSender();
    const view = await open(pty, sender, "run-1");
    resizeWatchedTerminal(pty, sender.id, view.watchId!, 90, 30);
    await open(pty, sender, "run-2");
    expect((pty.resize as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
      "run-1",
      120,
      36,
    ]);
  });

  it("sizes nothing it never held, and nothing for a terminal that exited", async () => {
    const { pty, emitter } = fakePty();
    const { sender } = fakeSender();
    await open(pty, sender, "run-1");
    stopTerminalWatch(sender.id);
    expect(resizes(pty)).toEqual([]);

    const view = await open(pty, sender, "run-2");
    resizeWatchedTerminal(pty, sender.id, view.watchId!, 90, 30);
    emitter.emit("exit", "run-2");
    expect(resizes(pty)).toEqual([[90, 30]]);
  });

  it("refuses a stream the view doesn't have open, and a size no pane could measure", async () => {
    const { pty } = fakePty();
    const { sender } = fakeSender();
    const view = await open(pty, sender, "run-1");
    expect(() => resizeWatchedTerminal(pty, sender.id, view.watchId! + 1, 90, 30)).toThrow();
    expect(() => resizeWatchedTerminal(pty, sender.id, view.watchId!, 3, 1)).toThrow();
    expect(() => resizeWatchedTerminal(pty, sender.id, view.watchId!, 90.5, 30)).toThrow();
    expect(resizes(pty)).toEqual([]);
  });
});

describe("an assistant's watch", () => {
  function binding() {
    const state = { bound: true, mayType: true, end: null as (() => void) | null };
    const release = vi.fn();
    return {
      state,
      release,
      binding: {
        isBound: () => state.bound,
        onEnded: (end: () => void) => {
          state.end = end;
          return release;
        },
        mayType: () => state.mayType,
      },
    };
  }

  function openAssistant(pty: PtyClient, sender: WebContents, b: ReturnType<typeof binding>) {
    return watchTerminal(
      pty,
      sender,
      "assistant-1",
      100,
      beginWatchRequest(sender.id),
      1,
      () => true,
      b.binding
    );
  }

  it("ends the moment main lets go of the session, with no output to say so", async () => {
    const { pty, releases } = fakePty();
    const { sender, sent } = fakeSender();
    const b = binding();
    const view = await openAssistant(pty, sender, b);
    expect(watchedTerminal(1, view.watchId!)).toMatchObject({ assistant: true, mayType: true });
    b.state.bound = false;
    b.state.end?.();
    expect(sent).toEqual([{ kind: "ended", watchId: view.watchId, runId: "assistant-1" }]);
    expect(watchedTerminal(1, view.watchId!)).toBeNull();
    expect(b.release).toHaveBeenCalledTimes(1);
    expect(releases[0]).toHaveBeenCalledTimes(1);
    // A replaced run gets no size handed back from this view.
    expect(vi.mocked(pty.resize)).not.toHaveBeenCalled();
  });

  it("ends on a same-id respawn that prints nothing", async () => {
    const { pty, emitter, generation } = fakePty();
    const { sender, sent } = fakeSender();
    const view = await openAssistant(pty, sender, binding());
    generation.current = 2;
    emitter.emit("spawn-result", "other", { success: true });
    expect(sent).toEqual([]);
    emitter.emit("spawn-result", "assistant-1", { success: true });
    expect(sent).toEqual([{ kind: "ended", watchId: view.watchId, runId: "assistant-1" }]);
  });

  it("keeps a refused duplicate spawn's original running stream open", async () => {
    const { pty, emitter } = fakePty();
    const { sender, sent } = fakeSender();
    const view = await openAssistant(pty, sender, binding());
    emitter.emit("spawn-result", "assistant-1", { success: false });
    expect(sent).toEqual([]);
    expect(watchedTerminal(1, view.watchId!)).not.toBeNull();
  });

  it("outlives Canopy's worker streams being stopped", async () => {
    const { pty } = fakePty();
    const assistantView = fakeSender(1);
    const workerView = fakeSender(2);
    const assistant = await openAssistant(pty, assistantView.sender, binding());
    const worker = await open(pty, workerView.sender, "run-1");
    stopWorkerTerminalWatches();
    expect(watchedTerminal(1, assistant.watchId!)).not.toBeNull();
    expect(watchedTerminal(2, worker.watchId!)).toBeNull();
  });

  it("refuses input once the session is no longer the one bound, before any event", async () => {
    const { pty } = fakePty();
    const { sender } = fakeSender();
    const b = binding();
    const view = await openAssistant(pty, sender, b);
    b.state.bound = false;
    expect(watchedTerminal(1, view.watchId!)).toBeNull();
    expect(b.release).toHaveBeenCalledTimes(1);
  });

  it("starts nothing for a session replaced while its snapshot was read", async () => {
    const { pty, resolveSnapshots } = fakePty("manual");
    const { sender } = fakeSender();
    const b = binding();
    const pending = openAssistant(pty, sender, b);
    b.state.bound = false;
    resolveSnapshots({ data: "successor", cols: 80, rows: 24 });
    expect(await pending).toEqual({ watchId: null, snapshot: null });
    expect(b.release).toHaveBeenCalledTimes(1);
  });

  it("says when another view holds the input, and lets go on unwatch", async () => {
    const { pty } = fakePty();
    const { sender } = fakeSender();
    const b = binding();
    const view = await openAssistant(pty, sender, b);
    b.state.mayType = false;
    expect(watchedTerminal(1, view.watchId!)).toMatchObject({ assistant: true, mayType: false });
    stopTerminalWatch(1);
    expect(b.release).toHaveBeenCalledTimes(1);
  });
});

describe("a panel on another machine holding the size (#14497)", () => {
  async function openRemote(fake: ReturnType<typeof fakePty>, authority: { may: boolean }) {
    const { sender, sent } = fakeSender(-5);
    const view = await watchTerminal(
      fake.pty,
      sender,
      "run-1",
      100,
      beginWatchRequest(sender.id),
      1,
      () => authority.may,
      null,
      true
    );
    return { view, sent };
  }

  it("ends a hold whose terminal was silently replaced, unfreezing the successor's panes", async () => {
    const fake = fakePty();
    const heard: string[][] = [];
    const off = onSizeHoldsChange((ids) => heard.push(ids));
    const { view, sent } = await openRemote(fake, { may: true });
    resizeWatchedTerminal(fake.pty, -5, view.watchId!, 100, 30);
    expect(sizeHolds()).toEqual(["run-1"]);
    fake.generation.current = 2;
    fake.emitter.emit("spawn-result", "run-1", { success: true });
    expect(sizeHolds()).toEqual([]);
    expect(heard.at(-1)).toEqual([]);
    expect(sent).toContainEqual(expect.objectContaining({ kind: "ended" }));
    // Nothing of the predecessor's is handed to the successor.
    expect(fake.pty.resize).toHaveBeenCalledTimes(1);
    off();
  });

  it("lets go without handing back when the drive moves, and asks again when it returns", async () => {
    const fake = fakePty();
    const authority = { may: true };
    const { view, sent } = await openRemote(fake, authority);
    resizeWatchedTerminal(fake.pty, -5, view.watchId!, 100, 30);
    fake.emitter.emit("resize-result", "run-1", {
      launchGeneration: 1,
      requestedCols: 100,
      requestedRows: 30,
      appliedCols: 100,
      appliedRows: 30,
      outcome: "applied",
    });

    authority.may = false;
    followDriveLeaseChange();
    expect(sizeHolds()).toEqual([]);

    // The new driver's pane takes the PTY.
    fake.emitter.emit("resize-result", "run-1", {
      launchGeneration: 1,
      requestedCols: 160,
      requestedRows: 45,
      appliedCols: 160,
      appliedRows: 45,
      outcome: "applied",
    });
    sent.length = 0;
    authority.may = true;
    followDriveLeaseChange();
    // Nothing is held until the panel asks, and it is told the grid to ask against.
    expect(sizeHolds()).toEqual([]);
    expect(sent).toEqual([
      { kind: "resize", watchId: view.watchId, runId: "run-1", cols: 160, rows: 45 },
    ]);

    vi.mocked(fake.pty.resize).mockClear();
    stopTerminalWatch(-5);
    // The hold was given up with the drive, so there is nothing to hand back.
    expect(fake.pty.resize).not.toHaveBeenCalled();
  });
});

describe("a panel on this machine holding the size (#16333)", () => {
  const resizes = (pty: PtyClient) =>
    (pty.resize as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => call.slice(1));

  const echo = (emitter: EventEmitter, cols: number, rows: number) =>
    emitter.emit("resize-result", "run-1", {
      launchGeneration: 1,
      requestedCols: cols,
      requestedRows: rows,
      appliedCols: cols,
      appliedRows: rows,
      outcome: "applied",
    });

  /** A panel that holds run-1 at 100x30, its pane having been 120x36. */
  async function held(id = 1) {
    const fake = fakePty();
    const view = fakeSender(id);
    const opened = await open(fake.pty, view.sender, "run-1");
    resizeWatchedTerminal(fake.pty, id, opened.watchId!, 100, 30);
    echo(fake.emitter, 100, 30);
    vi.mocked(fake.pty.resize).mockClear();
    view.sent.length = 0;
    return { ...fake, ...view, watchId: opened.watchId! };
  }

  it("tells every other view here, so a pane elsewhere follows the PTY instead of fitting", async () => {
    const { pty } = fakePty();
    const { sender } = fakeSender(1);
    const heard: string[][] = [];
    const off = onSizeHoldsChange((ids) => heard.push(ids));
    const view = await open(pty, sender, "run-1");

    resizeWatchedTerminal(pty, sender.id, view.watchId!, 100, 30);
    expect(heard.at(-1)).toEqual(["run-1"]);
    expect(sizeHolds()).toEqual(["run-1"]);

    stopTerminalWatch(sender.id);
    expect(heard.at(-1)).toEqual([]);
    off();
  });

  it("publishes the release only after the size is handed back, so the pane's fit lands last", async () => {
    const { pty } = await held();
    const order: string[] = [];
    vi.mocked(pty.resize).mockImplementation(() => void order.push("handed back"));
    const off = onSizeHoldsChange(() => order.push("released"));
    stopTerminalWatch(1);
    expect(order).toEqual(["handed back", "released"]);
    off();
  });

  describe("a pane's interaction taking the size", () => {
    it("lets go without moving the PTY: the pane's own fit does that, once", async () => {
      const { pty, sent, watchId } = await held();
      const heard: string[][] = [];
      const off = onSizeHoldsChange((ids) => heard.push(ids));

      yieldSizeToPane("run-1");

      expect(heard).toEqual([[]]);
      expect(pty.resize).not.toHaveBeenCalled();
      expect(sent).toEqual([
        { kind: "resize", watchId, runId: "run-1", cols: 100, rows: 30, following: true },
      ]);
      off();
    });

    it("leaves the panel following: no measure re-holds, and it draws what the pane set", async () => {
      const { pty, emitter, sent, watchId } = await held();
      yieldSizeToPane("run-1");
      echo(emitter, 132, 40);
      sent.length = 0;

      resizeWatchedTerminal(pty, 1, watchId, 100, 30);
      echo(emitter, 140, 42);

      expect(pty.resize).not.toHaveBeenCalled();
      expect(sizeHolds()).toEqual([]);
      expect(sent).toEqual([
        { kind: "resize", watchId, runId: "run-1", cols: 140, rows: 42, following: true },
      ]);
    });

    it("hands nothing back when the following panel closes: the size is already the pane's", async () => {
      const { pty, emitter } = await held();
      yieldSizeToPane("run-1");
      echo(emitter, 132, 40);
      stopTerminalWatch(1);
      expect(pty.resize).not.toHaveBeenCalled();
    });

    it("does nothing for a terminal no panel holds", async () => {
      const { pty, sent } = await held();
      yieldSizeToPane("run-2");
      expect(sent).toEqual([]);
      expect(sizeHolds()).toEqual(["run-1"]);
      expect(pty.resize).not.toHaveBeenCalled();
    });

    it("ends a hold whose terminal was silently replaced, unfreezing the successor's panes", async () => {
      const { emitter, generation, sent } = await held();
      const heard: string[][] = [];
      const off = onSizeHoldsChange((ids) => heard.push(ids));
      generation.current = 2;
      emitter.emit("spawn-result", "run-1", { success: true });
      expect(heard.at(-1)).toEqual([]);
      expect(sent).toContainEqual(expect.objectContaining({ kind: "ended" }));
      off();
    });
  });

  describe("the panel's own interaction taking it back", () => {
    it("lets the next measure hold again, and hands back the pane's newest size", async () => {
      const { pty, emitter, sent, watchId } = await held();
      yieldSizeToPane("run-1");
      echo(emitter, 132, 40);
      sent.length = 0;

      claimWatchedSize(1, watchId);
      expect(sent).toEqual([{ kind: "resize", watchId, runId: "run-1", cols: 132, rows: 40 }]);
      expect(pty.resize).not.toHaveBeenCalled();

      resizeWatchedTerminal(pty, 1, watchId, 100, 30);
      echo(emitter, 100, 30);
      expect(resizes(pty)).toEqual([[100, 30]]);
      expect(sizeHolds()).toEqual(["run-1"]);

      vi.mocked(pty.resize).mockClear();
      stopTerminalWatch(1);
      expect(resizes(pty)).toEqual([[132, 40]]);
    });

    it("needs a panel that is following: the holder claims nothing", async () => {
      const { sent, watchId } = await held();
      claimWatchedSize(1, watchId);
      expect(sent).toEqual([]);
    });

    it("finds the stream of a reply sent by the run, and only its incarnation's", async () => {
      const { pty, sent, watchId } = await held();
      yieldSizeToPane("run-1");
      sent.length = 0;

      claimWatchedRunSize(1, "run-1", 99);
      claimWatchedRunSize(1, "run-2", 100);
      expect(sent).toEqual([]);

      claimWatchedRunSize(1, "run-1", 100);
      resizeWatchedTerminal(pty, 1, watchId, 100, 30);
      expect(sizeHolds()).toEqual(["run-1"]);
    });
  });

  describe("two panels showing the terminal", () => {
    async function pair() {
      const first = await held(1);
      const second = fakeSender(2);
      // Opened under the first panel's hold, so its snapshot reports the panel's size.
      vi.mocked(first.pty.getSerializedStateAsync).mockResolvedValueOnce({
        data: "screen",
        cols: 100,
        rows: 30,
      } as Awaited<ReturnType<PtyClient["getSerializedStateAsync"]>>);
      const opened = await open(first.pty, second.sender, "run-1");
      const watchId = opened.watchId!;
      // The second measures, finds the size taken, and is told so.
      resizeWatchedTerminal(first.pty, 2, watchId, 90, 28);
      return { first, second, watchId };
    }

    it("follows the first window's hold rather than fighting it", async () => {
      const { first, second, watchId } = await pair();
      expect(first.pty.resize).not.toHaveBeenCalled();
      expect(second.sent.at(-1)).toMatchObject({ kind: "resize", watchId, following: true });
    });

    it("leaves both following when the pane takes the size, so neither re-holds on a measure", async () => {
      const { first, second, watchId } = await pair();
      yieldSizeToPane("run-1");
      resizeWatchedTerminal(first.pty, 1, first.watchId, 100, 30);
      resizeWatchedTerminal(first.pty, 2, watchId, 90, 28);
      expect(first.pty.resize).not.toHaveBeenCalled();
      expect(second.sent.at(-1)).toMatchObject({ following: true });
    });

    it("passes the hold across on the other's interaction, with no gap for a pane to fit in", async () => {
      const { first, watchId } = await pair();
      const heard: string[][] = [];
      const off = onSizeHoldsChange((ids) => heard.push(ids));

      claimWatchedSize(2, watchId);

      expect(heard).toEqual([]);
      expect(sizeHolds()).toEqual(["run-1"]);
      expect(first.sent.at(-1)).toMatchObject({ kind: "resize", following: true });

      resizeWatchedTerminal(first.pty, 2, watchId, 90, 28);
      resizeWatchedTerminal(first.pty, 1, first.watchId, 100, 30);
      expect(resizes(first.pty)).toEqual([[90, 28]]);

      // What goes back is the pane's size, never the first panel's.
      vi.mocked(first.pty.resize).mockClear();
      stopTerminalWatch(2);
      expect(resizes(first.pty)).toEqual([[120, 36]]);
      off();
    });

    it("keeps a late echo of the first panel's hold from passing as the pane's size", async () => {
      const { first, watchId } = await pair();
      // Still on its way when the second panel takes over.
      resizeWatchedTerminal(first.pty, 1, first.watchId, 110, 32);
      claimWatchedSize(2, watchId);
      echo(first.emitter, 110, 32);

      vi.mocked(first.pty.resize).mockClear();
      stopTerminalWatch(2);
      expect(resizes(first.pty)).toEqual([[120, 36]]);
    });

    it("keeps its own hold still on its way when one comes across from the other panel", async () => {
      const first = await held(1);
      const second = fakeSender(2);
      const other = await open(first.pty, second.sender, "run-1");
      resizeWatchedTerminal(first.pty, 1, first.watchId, 110, 32);
      yieldSizeToPane("run-1");
      claimWatchedSize(2, other.watchId!);
      resizeWatchedTerminal(first.pty, 2, other.watchId!, 90, 28);

      claimWatchedSize(1, first.watchId);
      echo(first.emitter, 110, 32);

      vi.mocked(first.pty.resize).mockClear();
      stopTerminalWatch(1);
      expect(resizes(first.pty)).toEqual([[120, 36]]);
    });

    it("counts a hold that went across and back once, leaving the pane's own echo the pane's", async () => {
      const { first, watchId } = await pair();
      resizeWatchedTerminal(first.pty, 1, first.watchId, 110, 32);
      claimWatchedSize(2, watchId);
      claimWatchedSize(1, first.watchId);
      echo(first.emitter, 110, 32);

      // The pane happens to fit that same size.
      yieldSizeToPane("run-1");
      echo(first.emitter, 110, 32);

      claimWatchedSize(1, first.watchId);
      resizeWatchedTerminal(first.pty, 1, first.watchId, 100, 30);
      vi.mocked(first.pty.resize).mockClear();
      stopTerminalWatch(1);
      expect(resizes(first.pty)).toEqual([[110, 32]]);
    });

    it("lets a window put away before it ever measured go, without touching the other's hold", async () => {
      const first = await held(1);
      const second = fakeSender(2);
      const opened = await open(first.pty, second.sender, "run-1");

      releaseViewSizeHolds(2);

      expect(first.pty.resize).not.toHaveBeenCalled();
      expect(sizeHolds()).toEqual(["run-1"]);
      expect(second.sent.at(-1)).toMatchObject({ kind: "resize", following: true });

      // Nothing the first window does later hands the size to a window no one can read.
      stopTerminalWatch(1);
      vi.mocked(first.pty.resize).mockClear();
      resizeWatchedTerminal(first.pty, 2, opened.watchId!, 90, 28);
      expect(first.pty.resize).not.toHaveBeenCalled();
      expect(sizeHolds()).toEqual([]);
    });
  });

  describe("a window put away", () => {
    it("lets go, the PTY going back to the pane's size before the panes hear", async () => {
      const { pty, sent, watchId } = await held();
      const order: string[] = [];
      vi.mocked(pty.resize).mockImplementation(() => void order.push("handed back"));
      const off = onSizeHoldsChange(() => order.push("released"));

      releaseViewSizeHolds(1);

      expect(resizes(pty)).toEqual([[120, 36]]);
      expect(order).toEqual(["handed back", "released"]);
      expect(sizeHolds()).toEqual([]);
      expect(sent.at(-1)).toMatchObject({ kind: "resize", watchId, following: true });
      expect(activeTerminalWatches().has(1)).toBe(true);
      off();
    });

    it("takes nothing back on the window's return: only the user's interaction does", async () => {
      const { pty, emitter, watchId } = await held();
      releaseViewSizeHolds(1);
      echo(emitter, 120, 36);
      vi.mocked(pty.resize).mockClear();

      resizeWatchedTerminal(pty, 1, watchId, 100, 30);

      expect(pty.resize).not.toHaveBeenCalled();
      expect(sizeHolds()).toEqual([]);
    });

    it("hands back even when the PTY last reported the pane's size, if a hold is on its way", async () => {
      const { pty, emitter, watchId } = await held();
      yieldSizeToPane("run-1");
      echo(emitter, 120, 36);
      claimWatchedSize(1, watchId);
      resizeWatchedTerminal(pty, 1, watchId, 100, 30);
      vi.mocked(pty.resize).mockClear();

      releaseViewSizeHolds(1);

      expect(resizes(pty)).toEqual([[120, 36]]);
    });

    it("tells a panel put away while its stream opened, once it has a grid to say so with", async () => {
      const fake = fakePty("manual");
      const view = fakeSender(1);
      const opening = open(fake.pty, view.sender, "run-1");
      await vi.waitFor(() => expect(fake.pty.getSerializedStateAsync).toHaveBeenCalled());

      releaseViewSizeHolds(1);
      expect(view.sent).toEqual([]);

      fake.resolveSnapshots({ data: "screen", cols: 120, rows: 36 });
      const opened = await opening;

      expect(view.sent).toEqual([
        {
          kind: "resize",
          watchId: opened.watchId,
          runId: "run-1",
          cols: 120,
          rows: 36,
          following: true,
        },
      ]);
    });

    it("is heard twice as once: a repeat hands nothing back again", async () => {
      const { pty, emitter } = await held();
      releaseViewSizeHolds(1);
      echo(emitter, 120, 36);
      vi.mocked(pty.resize).mockClear();
      releaseViewSizeHolds(1);
      expect(pty.resize).not.toHaveBeenCalled();
    });

    it("lets a new selection take the size as a first one does", async () => {
      const { pty, sender } = await held();
      releaseViewSizeHolds(1);
      vi.mocked(pty.resize).mockClear();

      const reopened = await open(pty, sender, "run-1");
      resizeWatchedTerminal(pty, 1, reopened.watchId!, 100, 30);

      expect(resizes(pty)).toEqual([[100, 30]]);
      expect(sizeHolds()).toEqual(["run-1"]);
    });
  });

  describe("the drive lease moving", () => {
    async function drivenHold() {
      const fake = fakePty();
      const view = fakeSender(1);
      const authority = { may: true };
      const opened = await watchTerminal(
        fake.pty,
        view.sender,
        "run-1",
        100,
        beginWatchRequest(1),
        1,
        () => authority.may
      );
      resizeWatchedTerminal(fake.pty, 1, opened.watchId!, 100, 30);
      echo(fake.emitter, 100, 30);
      vi.mocked(fake.pty.resize).mockClear();
      view.sent.length = 0;
      return { ...fake, ...view, authority, watchId: opened.watchId! };
    }

    it("lets go with nothing handed back, and asks again when the drive returns", async () => {
      const { pty, emitter, sent, authority, watchId } = await drivenHold();
      authority.may = false;
      followDriveLeaseChange();
      expect(sizeHolds()).toEqual([]);

      // The new driver's pane takes the PTY.
      echo(emitter, 150, 45);
      sent.length = 0;
      authority.may = true;
      followDriveLeaseChange();

      // No stale hold comes back: nothing is held until the panel asks.
      expect(sizeHolds()).toEqual([]);
      expect(sent).toEqual([{ kind: "resize", watchId, runId: "run-1", cols: 150, rows: 45 }]);
      expect(pty.resize).not.toHaveBeenCalled();
    });

    it("leaves a following panel following: the lease moving is nothing the user did to it", async () => {
      const { emitter, sent, authority } = await drivenHold();
      yieldSizeToPane("run-1");
      echo(emitter, 120, 36);
      authority.may = false;
      followDriveLeaseChange();
      sent.length = 0;

      authority.may = true;
      followDriveLeaseChange();

      expect(sent).toEqual([]);
    });
  });

  describe("a hold from another machine", () => {
    async function remoteHold() {
      const fake = fakePty();
      const { sender, sent } = fakeSender(-5);
      const view = await watchTerminal(
        fake.pty,
        sender,
        "run-1",
        100,
        beginWatchRequest(sender.id),
        1,
        () => true,
        null,
        true
      );
      resizeWatchedTerminal(fake.pty, -5, view.watchId!, 100, 30);
      vi.mocked(fake.pty.resize).mockClear();
      sent.length = 0;
      return { ...fake, sent, watchId: view.watchId! };
    }

    it("stands against a pane's interaction", async () => {
      const { pty, sent } = await remoteHold();
      yieldSizeToPane("run-1");
      expect(sizeHolds()).toEqual(["run-1"]);
      expect(sent).toEqual([]);
      expect(pty.resize).not.toHaveBeenCalled();
    });

    it("stands against any window here being put away", async () => {
      const { pty } = await remoteHold();
      releaseViewSizeHolds(-5);
      expect(sizeHolds()).toEqual(["run-1"]);
      expect(pty.resize).not.toHaveBeenCalled();
    });

    it("stands against a panel here claiming it, which goes on following", async () => {
      const fake = fakePty();
      const local = fakeSender(1);
      const view = await open(fake.pty, local.sender, "run-1");
      releaseViewSizeHolds(1);
      const remote = fakeSender(-5);
      const opened = await watchTerminal(
        fake.pty,
        remote.sender,
        "run-1",
        100,
        beginWatchRequest(-5),
        1,
        () => true,
        null,
        true
      );
      resizeWatchedTerminal(fake.pty, -5, opened.watchId!, 100, 30);
      local.sent.length = 0;

      claimWatchedSize(1, view.watchId!);

      expect(local.sent).toEqual([]);
      expect(sizeHolds()).toEqual(["run-1"]);
      vi.mocked(fake.pty.resize).mockClear();
      stopTerminalWatch(-5);
      resizeWatchedTerminal(fake.pty, 1, view.watchId!, 90, 28);
      expect(resizes(fake.pty)).not.toContainEqual([90, 28]);
    });

    it("never tells a panel from another machine to follow when a pane takes a hold from here", async () => {
      const { pty, sent } = await held();
      const remote = fakeSender(-5);
      const opened = await watchTerminal(
        pty,
        remote.sender,
        "run-1",
        100,
        beginWatchRequest(-5),
        1,
        () => true,
        null,
        true
      );

      yieldSizeToPane("run-1");

      expect(sent.at(-1)).toMatchObject({ following: true });
      expect(remote.sent).toEqual([]);
      vi.mocked(pty.resize).mockClear();
      resizeWatchedTerminal(pty, -5, opened.watchId!, 90, 28);
      expect(resizes(pty)).toEqual([[90, 28]]);
    });

    it("leaves a panel here asking again rather than following, as the hold ends with the drive", async () => {
      const { pty } = await remoteHold();
      const local = fakeSender(1);
      const view = await open(pty, local.sender, "run-1");

      resizeWatchedTerminal(pty, 1, view.watchId!, 90, 28);
      expect(local.sent).toEqual([]);

      stopTerminalWatch(-5);
      vi.mocked(pty.resize).mockClear();
      resizeWatchedTerminal(pty, 1, view.watchId!, 90, 28);
      expect(resizes(pty)).toEqual([[90, 28]]);
    });
  });
});
