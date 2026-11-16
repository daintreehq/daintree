import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityMonitor } from "../../ActivityMonitor.js";
import { AnalysisSession } from "../analysis/AnalysisSession.js";
import { InThreadAnalysisBackend } from "../analysis/InThreadAnalysisBackend.js";
import { SynchronizedFrameDetector } from "../SynchronizedFrameDetector.js";
import type { FrameSnapshot } from "../SynchronizedFrameAnalyzer.js";
import type { TerminalInfo } from "../types.js";

// Production options never yield a monitor that reads frame snapshots, so the
// consuming branch is reached by overriding simple output mode on real options.
const optionOverrides = vi.hoisted(() => ({ simpleOutputState: undefined as boolean | undefined }));
vi.mock("../terminalActivityPatterns.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminalActivityPatterns.js")>();
  return {
    ...actual,
    buildActivityMonitorOptions: (
      ...args: Parameters<typeof actual.buildActivityMonitorOptions>
    ) => {
      const options = actual.buildActivityMonitorOptions(...args);
      const { simpleOutputState } = optionOverrides;
      return simpleOutputState === undefined ? options : { ...options, simpleOutputState };
    },
  };
});

const ROWS = 10;
const STATUS = "⠋ Thinking… (3s)";
const FRAME = `\x1b[?2026h\x1b[${ROWS};1H\x1b[2K${STATUS}\x1b[?2026l`;
const UNCLOSED_OPEN = "\x1b[?2026h";

interface Harness {
  startMonitor(agentId: string | undefined): void;
  stopMonitor(): void;
  feed(data: string): Promise<void>;
  dispose(): void;
}

function sessionHarness(): Harness {
  const session = new AnalysisSession(
    {
      terminalId: "sync-frames",
      cols: 40,
      rows: ROWS,
      scrollback: 100,
      restore: false,
      spawnedAt: 1,
      epoch: 1,
    },
    () => {}
  );
  return {
    startMonitor: (agentId) =>
      session.startMonitor({
        agentId,
        initialState: "idle",
        skipInitialStateEmit: true,
        hasProcessValidator: false,
      }),
    stopMonitor: () => session.stopMonitor(),
    feed: async (data) => {
      session.feedChunk(data, { agentLive: true });
      await session.serialize();
    },
    dispose: () => session.free(),
  };
}

function inThreadHarness(): Harness {
  const terminalInfo = {
    id: "sync-frames",
    spawnedAt: 1,
    contentEpoch: 0,
    ptyProcess: { pid: 0 },
  } as unknown as TerminalInfo;
  const backend = new InThreadAnalysisBackend({
    terminalId: "sync-frames",
    terminalInfo,
    cols: 40,
    rows: ROWS,
    scrollback: 100,
    restore: false,
    processTreeCache: null,
    isAgentLive: () => true,
    onActivityState: () => {},
    onWaitingTimeout: () => {},
    onBootComplete: () => {},
    onPtyResponse: () => {},
    onViewport: () => {},
    onOutputPromotion: () => {},
  });
  return {
    startMonitor: (agentId) =>
      backend.startMonitor({ agentId, initialState: "idle", skipInitialStateEmit: true }),
    stopMonitor: () => backend.stopMonitor(),
    feed: async (data) => {
      backend.feedChunk(data, { agentLive: true });
      await backend.serialize();
    },
    // The owner stops the monitor before releasing the mirror.
    dispose: () => {
      backend.stopMonitor();
      backend.release();
    },
  };
}

describe.each([
  ["AnalysisSession", sessionHarness],
  ["InThreadAnalysisBackend", inThreadHarness],
])("%s synchronized-frame gating (#17041)", (_name, makeHarness) => {
  let harness: Harness;
  let handleOpen: ReturnType<typeof vi.spyOn>;
  let captureSnapshot: ReturnType<typeof vi.spyOn>;
  let onSynchronizedFrame: ReturnType<typeof vi.spyOn>;

  // Any detector hook on the parser would run handleOpen, which arms the
  // missing-close timer, even for a frame that never closes.
  function expectNoFrameWork(): void {
    expect(handleOpen).not.toHaveBeenCalled();
    expect(captureSnapshot).not.toHaveBeenCalled();
    expect(onSynchronizedFrame).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    const detector = SynchronizedFrameDetector.prototype as unknown as {
      handleOpen(): boolean;
      captureSnapshot(): FrameSnapshot;
    };
    handleOpen = vi.spyOn(detector, "handleOpen");
    captureSnapshot = vi.spyOn(detector, "captureSnapshot");
    onSynchronizedFrame = vi.spyOn(ActivityMonitor.prototype, "onSynchronizedFrame");
    harness = makeHarness();
  });

  afterEach(() => {
    harness.dispose();
    optionOverrides.simpleOutputState = undefined;
    vi.restoreAllMocks();
  });

  it("hooks no frames before a monitor starts", async () => {
    await harness.feed(FRAME + UNCLOSED_OPEN);
    expectNoFrameWork();
  });

  it("hooks no frames for an agent monitor", async () => {
    harness.startMonitor("claude");
    await harness.feed(FRAME + FRAME + UNCLOSED_OPEN);
    expectNoFrameWork();
  });

  it("hooks no frames for a plain-terminal monitor", async () => {
    harness.startMonitor(undefined);
    await harness.feed(FRAME + FRAME + UNCLOSED_OPEN);
    expectNoFrameWork();
  });

  it("delivers each frame's snapshot to a monitor that consumes them", async () => {
    optionOverrides.simpleOutputState = false;
    harness.startMonitor("claude");

    await harness.feed(FRAME + FRAME);

    expect(onSynchronizedFrame).toHaveBeenCalledTimes(2);
    const snapshot = onSynchronizedFrame.mock.calls[0][0] as FrameSnapshot;
    expect(snapshot.bottomRowText).toBe(STATUS);
    expect(snapshot.rows).toHaveLength(3);
  });

  it("drops the hook with the monitor and reinstalls it on restart", async () => {
    optionOverrides.simpleOutputState = false;
    harness.startMonitor("claude");
    await harness.feed(UNCLOSED_OPEN);
    harness.stopMonitor();
    handleOpen.mockClear();

    await harness.feed(FRAME);
    expectNoFrameWork();

    harness.startMonitor("claude");
    await harness.feed(FRAME);
    expect(onSynchronizedFrame).toHaveBeenCalledTimes(1);
  });
});
