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
  persistSessionSnapshotSync,
} from "../terminalSessionPersistence.js";
import type { AnalysisBackend, AnalysisFinalCapture } from "../analysis/AnalysisBackend.js";
import type { TerminalInfo } from "../types.js";

const ID = "term-preserved";

function createWorkerHost(info: Partial<TerminalInfo> = {}) {
  let settle!: (capture: AnalysisFinalCapture) => void;
  const captured = new Promise<AnalysisFinalCapture>((resolve) => {
    settle = resolve;
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
    isDisposed: false,
    serializeForPersistence: () => null,
    disposeHeadless: vi.fn(),
    onPreserved,
  } satisfies PreservedSnapshotCaptureHost;
  return { host, settle, release, onPreserved };
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
  });

  afterEach(async () => {
    flushPendingSessionWritesSync();
    process.env.DAINTREE_USER_DATA = previousUserData;
    await fsp.rm(userDataDir, { recursive: true, force: true });
  });

  const sessionFile = () => getSessionPath(ID)!;

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

    await vi.waitFor(() => {
      expect(fs.readFileSync(sessionFile(), "utf8")).toBe(
        "DAINTREE_SESSION_v2\n100x30\nexit screen"
      );
    });
  });

  it("leaves a session deleted when the delete lands during the worker round trip", async () => {
    persistSessionSnapshotSync(ID, { data: "pre-exit screen", cols: 80, rows: 24 });
    const { host, settle, onPreserved } = createWorkerHost();
    new PreservedSnapshotCapture(host).snapshotAndDispose();

    // Killing an exited terminal neither disposes it nor stops this capture.
    await deleteSessionFile(ID);
    settle({ snapshot: screen, persistence });
    await vi.waitFor(() => expect(onPreserved).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fs.existsSync(sessionFile())).toBe(false);
  });

  it("writes nothing when the terminal is disposed before the capture lands", async () => {
    persistSessionSnapshotSync(ID, { data: "pre-exit screen", cols: 80, rows: 24 });
    const { host, settle, onPreserved } = createWorkerHost();
    new PreservedSnapshotCapture(host).snapshotAndDispose();

    host.isDisposed = true;
    settle({ snapshot: screen, persistence });
    await drainMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onPreserved).not.toHaveBeenCalled();
    expect(host.terminalInfo.preservedSnapshot).toBeUndefined();
    expect(fs.readFileSync(sessionFile(), "utf8")).toBe(
      "DAINTREE_SESSION_v2\n80x24\npre-exit screen"
    );
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

    expect(fs.readFileSync(sessionFile(), "utf8")).toBe("DAINTREE_SESSION_v2\n80x24\nsettled turn");
  });
});
