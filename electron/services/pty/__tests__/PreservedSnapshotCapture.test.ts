import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PreservedSnapshotCapture,
  type PreservedSnapshotCaptureHost,
} from "../PreservedSnapshotCapture.js";
import {
  deleteSessionFile,
  flushPendingSessionWritesSync,
  getSessionPath,
  persistSessionSnapshotAsync,
} from "../terminalSessionPersistence.js";
import type { AnalysisBackend, AnalysisFinalCapture } from "../analysis/AnalysisBackend.js";
import type { TerminalInfo } from "../types.js";

// Every write the capture starts is collected, so a test can wait for all of
// them to finish before asserting that none of them landed.
const writes = vi.hoisted(() => [] as Promise<void>[]);
vi.mock("../terminalSessionPersistence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminalSessionPersistence.js")>();
  return {
    ...actual,
    persistSessionSnapshotAsync: (
      ...args: Parameters<typeof actual.persistSessionSnapshotAsync>
    ) => {
      const write = actual.persistSessionSnapshotAsync(...args);
      writes.push(write);
      return write;
    },
  };
});

async function settleWrites(): Promise<void> {
  while (writes.length > 0) await Promise.allSettled(writes.splice(0));
}

const ID = "term-preserved";

function createWorkerHost(info: Partial<TerminalInfo> = {}) {
  let settle!: (capture: AnalysisFinalCapture) => void;
  let fail!: (error: Error) => void;
  const captured = new Promise<AnalysisFinalCapture>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const release = vi.fn();
  const onPreserved = vi.fn();
  const host = {
    id: ID,
    terminalInfo: { contentEpoch: 0, pendingHeadlessWrites: 0, ...info } as TerminalInfo,
    analysis: {
      kind: "worker",
      captureFinalSnapshot: () => captured,
      release,
    } as unknown as AnalysisBackend,
    isDisposed: false as boolean,
    serializeForPersistence: () => null,
    disposeHeadless: vi.fn(),
    onPreserved,
  } satisfies PreservedSnapshotCaptureHost;
  return { host, settle, fail, release, onPreserved };
}

// Settles the capture's `.then` without giving the event loop a turn, so any
// file I/O it started cannot have completed yet.
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const screen = { data: "exit screen\r\n\x1b[2mrestore banner\x1b[0m", cols: 100, rows: 30 };
const persistence = { data: "exit screen", cols: 100, rows: 30 };

describe("PreservedSnapshotCapture — final exit write (worker analysis)", () => {
  let userDataDir: string;
  const previousUserData = process.env.DAINTREE_USER_DATA;

  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "daintree-preserved-capture-"));
    process.env.DAINTREE_USER_DATA = userDataDir;
    writes.length = 0;
  });

  afterEach(async () => {
    await settleWrites();
    flushPendingSessionWritesSync();
    process.env.DAINTREE_USER_DATA = previousUserData;
    await fsp.rm(userDataDir, { recursive: true, force: true });
  });

  const sessionFile = () => getSessionPath(ID)!;
  const readSession = () => fs.readFileSync(sessionFile(), "utf8");

  it("preserves the screen without waiting on disk, then writes the banner-free payload", async () => {
    const { host, settle, release, onPreserved } = createWorkerHost();
    new PreservedSnapshotCapture(host).snapshotAndDispose();

    settle({ snapshot: screen, persistence });
    await drainMicrotasks();

    expect(host.terminalInfo.preservedSnapshot).toBe(screen);
    expect(release).toHaveBeenCalledTimes(1);
    expect(onPreserved).toHaveBeenCalledTimes(1);
    // Nothing touched the disk on the pty-host loop (#16806).
    expect(fs.existsSync(sessionFile())).toBe(false);

    await settleWrites();
    expect(readSession()).toBe("DAINTREE_SESSION_v2\n100x30\nexit screen");
  });

  it("leaves a session deleted when the delete lands during the worker round trip", async () => {
    const { host, settle, onPreserved } = createWorkerHost();
    new PreservedSnapshotCapture(host).snapshotAndDispose();

    // Killing an exited terminal neither disposes it nor stops this capture.
    await deleteSessionFile(ID);
    settle({ snapshot: screen, persistence });
    await vi.waitFor(() => expect(onPreserved).toHaveBeenCalledTimes(1));
    await settleWrites();

    expect(fs.existsSync(sessionFile())).toBe(false);
  });

  it("gives the file back to the write it superseded when the terminal is disposed first", async () => {
    const periodic = persistSessionSnapshotAsync(ID, { data: "periodic", cols: 80, rows: 24 });
    const { host, settle, onPreserved } = createWorkerHost();
    new PreservedSnapshotCapture(host).snapshotAndDispose();
    await periodic;
    expect(fs.existsSync(sessionFile())).toBe(false);

    host.isDisposed = true;
    settle({ snapshot: screen, persistence });

    await vi.waitFor(() => {
      expect(readSession()).toBe("DAINTREE_SESSION_v2\n80x24\nperiodic");
    });
    expect(onPreserved).not.toHaveBeenCalled();
    expect(host.terminalInfo.preservedSnapshot).toBeUndefined();
  });

  it("writes nothing once cancelled, though the capture still lands in memory", async () => {
    const { host, settle, onPreserved } = createWorkerHost();
    const capture = new PreservedSnapshotCapture(host);
    capture.snapshotAndDispose();

    capture.cancel();
    settle({ snapshot: screen, persistence });
    await vi.waitFor(() => expect(onPreserved).toHaveBeenCalledTimes(1));
    await settleWrites();

    expect(host.terminalInfo.preservedSnapshot).toBe(screen);
    expect(fs.existsSync(sessionFile())).toBe(false);
  });

  it("logs a failed capture, keeps the slot, and gives the file back", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const periodic = persistSessionSnapshotAsync(ID, { data: "periodic", cols: 80, rows: 24 });
    const { host, fail, release, onPreserved } = createWorkerHost();
    new PreservedSnapshotCapture(host).snapshotAndDispose();
    await periodic;

    fail(new Error("worker gone"));

    await vi.waitFor(() => {
      expect(readSession()).toBe("DAINTREE_SESSION_v2\n80x24\nperiodic");
    });
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to capture final snapshot"),
      expect.any(Error)
    );
    expect(release).not.toHaveBeenCalled();
    expect(onPreserved).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("leaves an agent terminal's in-flight event snapshot alone", async () => {
    // Agent sessions get no exit write, so their exit must not void the
    // event-driven write already on its way.
    const inFlight = persistSessionSnapshotAsync(ID, { data: "settled turn", cols: 80, rows: 24 });
    const { host, settle, onPreserved } = createWorkerHost({ launchAgentId: "claude" });
    new PreservedSnapshotCapture(host).snapshotAndDispose();

    settle({ snapshot: screen, persistence });
    await vi.waitFor(() => expect(onPreserved).toHaveBeenCalledTimes(1));
    await inFlight;
    await settleWrites();

    expect(readSession()).toBe("DAINTREE_SESSION_v2\n80x24\nsettled turn");
  });
});
