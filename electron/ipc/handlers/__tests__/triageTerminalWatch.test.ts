import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { PtyClient } from "../../../services/PtyClient.js";
import {
  activeTerminalWatches,
  beginWatchRequest,
  stopAllTerminalWatches,
  stopTerminalWatch,
  watchTerminal,
  watchedTerminal,
} from "../triageTerminalWatch.js";

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

  it("follows the PTY's size, which only the owning pane sets", async () => {
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
