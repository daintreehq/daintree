import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { PtyClient } from "../../../services/PtyClient.js";
import {
  activeTerminalWatches,
  beginWatchRequest,
  resizeWatchedTerminal,
  stopAllTerminalWatches,
  stopTerminalWatch,
  watchTerminal,
  watchedTerminal,
} from "../canopyTerminalWatch.js";

function fakePty(snapshot: unknown = { data: "screen", cols: 120, rows: 36 }) {
  const emitter = new EventEmitter();
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  const pending: Array<(value: unknown) => void> = [];
  const pty = Object.assign(emitter, {
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
    expect(watchedTerminal(1, first.watchId!)).toEqual({ runId: "run-1", spawnedAt: 100 });
    const second = await open(pty, sender, "run-2", 200);
    expect(watchedTerminal(1, first.watchId!)).toBeNull();
    expect(watchedTerminal(1, second.watchId!)).toEqual({ runId: "run-2", spawnedAt: 200 });
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
