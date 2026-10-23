// @vitest-environment jsdom
import { Terminal } from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalHistoryReleaseController } from "../TerminalHistoryReleaseController";
import { restoreScrollback } from "../TerminalScrollbackController";
import {
  HISTORY_RELEASE_DWELL_MS,
  RELEASED_SCROLLBACK_LINES,
  type ManagedTerminal,
} from "../types";
import { getScrollbackForType } from "@/utils/scrollbackConfig";

const mockScrollbackStore = { scrollbackLines: 5000 };
vi.mock("@/store/scrollbackStore", () => ({
  useScrollbackStore: { getState: () => mockScrollbackStore },
}));

const mockPerformanceModeStore = { performanceMode: false };
vi.mock("@/store/performanceModeStore", () => ({
  usePerformanceModeStore: { getState: () => mockPerformanceModeStore },
}));

vi.mock("@/store/projectSettingsStore", () => ({
  useProjectSettingsStore: { getState: () => ({ settings: null }) },
}));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const AGENT_CEILING = getScrollbackForType(true, mockScrollbackStore.scrollbackLines);

function makeManaged(overrides: Record<string, unknown> = {}): ManagedTerminal {
  const buffer = { length: 3000 };
  return {
    terminal: {
      options: { scrollback: AGENT_CEILING },
      rows: 24,
      cols: 180,
      buffer: { active: buffer, normal: buffer },
      hasSelection: vi.fn(() => false),
    },
    kind: "terminal",
    runtimeAgentId: "claude",
    isVisible: false,
    isFocused: false,
    isUserScrolledBack: false,
    isAltBuffer: false,
    ...overrides,
  } as unknown as ManagedTerminal;
}

describe("TerminalHistoryReleaseController (#14220)", () => {
  let instances: Map<string, ManagedTerminal>;
  let observable: boolean;
  let workerIngest: boolean;
  let fetchAndRestore: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>;
  let controller: TerminalHistoryReleaseController;

  beforeEach(() => {
    vi.useFakeTimers();
    instances = new Map();
    observable = true;
    workerIngest = false;
    mockPerformanceModeStore.performanceMode = false;
    fetchAndRestore = vi.fn(async () => true);
    controller = new TerminalHistoryReleaseController({
      getInstance: (id) => instances.get(id),
      fetchAndRestore,
      isViewObservable: () => observable,
      isWorkerIngestEnabled: () => workerIngest,
    });
  });

  afterEach(() => {
    for (const managed of instances.values()) controller.cancel(managed);
    vi.useRealTimers();
  });

  function hide(id: string, managed: ManagedTerminal): void {
    instances.set(id, managed);
    controller.sync(id);
  }

  it("releases history only once a hidden pane has dwelt for the full window", () => {
    const managed = makeManaged();
    hide("t1", managed);

    vi.advanceTimersByTime(HISTORY_RELEASE_DWELL_MS - 1);
    expect(managed.terminal.options.scrollback).toBe(AGENT_CEILING);
    expect(managed.historyReleased).toBeFalsy();

    vi.advanceTimersByTime(1);
    expect(managed.terminal.options.scrollback).toBe(RELEASED_SCROLLBACK_LINES);
    expect(managed.historyReleased).toBe(true);
  });

  it("restarts the dwell when the pane is shown before it lapses", () => {
    const managed = makeManaged();
    hide("t1", managed);
    vi.advanceTimersByTime(HISTORY_RELEASE_DWELL_MS - 1000);

    managed.isVisible = true;
    controller.sync("t1");
    vi.advanceTimersByTime(HISTORY_RELEASE_DWELL_MS);
    expect(managed.historyReleased).toBeFalsy();

    managed.isVisible = false;
    controller.sync("t1");
    vi.advanceTimersByTime(HISTORY_RELEASE_DWELL_MS - 1000);
    expect(managed.historyReleased).toBeFalsy();
    vi.advanceTimersByTime(1000);
    expect(managed.historyReleased).toBe(true);
  });

  it("does not re-arm or restart a dwell already running when hidden again", () => {
    const managed = makeManaged();
    hide("t1", managed);
    vi.advanceTimersByTime(HISTORY_RELEASE_DWELL_MS / 2);
    // A hidden agent's write bursts re-run the tier path on every chunk.
    controller.sync("t1");
    vi.advanceTimersByTime(HISTORY_RELEASE_DWELL_MS / 2);
    expect(managed.historyReleased).toBe(true);
  });

  const guards: Array<[string, (m: ManagedTerminal) => void, () => void]> = [
    ["the user scrolled back", (m) => (m.isUserScrolledBack = true), () => {}],
    ["the alternate screen is up", (m) => (m.isAltBuffer = true), () => {}],
    [
      "a selection is held",
      (m) => vi.mocked(m.terminal.hasSelection).mockReturnValue(true),
      () => {},
    ],
    ["a restore is in progress", (m) => (m.isSerializedRestoreInProgress = true), () => {}],
    ["an attach is in progress", (m) => (m.isAttaching = true), () => {}],
    [
      "attach recovery is in flight",
      (m) => (m.attachRecoveryInFlight = Promise.resolve(true)),
      () => {},
    ],
    ["a post-complete hook reads the buffer", (m) => (m.postCompleteHook = vi.fn()), () => {}],
    ["the view is not observable", () => {}, () => (observable = false)],
    ["worker ingest is on", () => {}, () => (workerIngest = true)],
    ["performance mode is on", () => {}, () => (mockPerformanceModeStore.performanceMode = true)],
    [
      "there is no more history than the floor",
      (m) => {
        (m.terminal.buffer.normal as { length: number }).length =
          m.terminal.rows + RELEASED_SCROLLBACK_LINES;
      },
      () => {},
    ],
  ];

  it.each(guards)("keeps history while %s", (_label, pin, setEnv) => {
    const managed = makeManaged();
    pin(managed);
    setEnv();
    hide("t1", managed);

    vi.advanceTimersByTime(HISTORY_RELEASE_DWELL_MS * 3);
    expect(managed.historyReleased).toBeFalsy();
    expect(managed.terminal.options.scrollback).toBe(AGENT_CEILING);
  });

  it("looks again after another dwell once a transient guard clears", () => {
    const managed = makeManaged({ isUserScrolledBack: true });
    hide("t1", managed);
    vi.advanceTimersByTime(HISTORY_RELEASE_DWELL_MS);
    expect(managed.historyReleased).toBeFalsy();

    managed.isUserScrolledBack = false;
    vi.advanceTimersByTime(HISTORY_RELEASE_DWELL_MS);
    expect(managed.historyReleased).toBe(true);
  });

  it("never releases a focused pane", () => {
    const managed = makeManaged({ isFocused: true });
    hide("t1", managed);
    vi.advanceTimersByTime(HISTORY_RELEASE_DWELL_MS * 2);
    expect(managed.historyReleased).toBeFalsy();
  });

  it("drops a dwell armed for an instance a restart replaced", () => {
    const old = makeManaged();
    hide("t1", old);
    const replacement = makeManaged();
    instances.set("t1", replacement);

    vi.advanceTimersByTime(HISTORY_RELEASE_DWELL_MS);
    expect(old.historyReleased).toBeFalsy();
    expect(replacement.historyReleased).toBeFalsy();
  });

  it("cancel stops a pending release", () => {
    const managed = makeManaged();
    hide("t1", managed);
    controller.cancel(managed);
    vi.advanceTimersByTime(HISTORY_RELEASE_DWELL_MS);
    expect(managed.historyReleased).toBeFalsy();
  });

  it("restores the ceiling and refills history from the host once, on reveal", () => {
    const managed = makeManaged();
    hide("t1", managed);
    vi.advanceTimersByTime(HISTORY_RELEASE_DWELL_MS);
    expect(managed.historyReleased).toBe(true);

    // Tier flaps while hidden must not regrow the capacity.
    restoreScrollback(managed);
    expect(managed.terminal.options.scrollback).toBe(RELEASED_SCROLLBACK_LINES);

    managed.isVisible = true;
    controller.sync("t1");
    controller.sync("t1");

    expect(managed.historyReleased).toBe(false);
    expect(managed.terminal.options.scrollback).toBe(AGENT_CEILING);
    expect(fetchAndRestore).toHaveBeenCalledTimes(1);
    expect(fetchAndRestore).toHaveBeenCalledWith("t1");
  });

  it("never restores a pane whose history was not released", () => {
    const managed = makeManaged({ isVisible: true });
    instances.set("t1", managed);
    controller.sync("t1");
    expect(fetchAndRestore).not.toHaveBeenCalled();
  });

  it("frees a real xterm's history while it keeps parsing the live screen", async () => {
    // xterm parses on a real timer, so only the dwell runs on the fake clock.
    vi.useRealTimers();
    const rows = 10;
    const terminal = new Terminal({ cols: 40, rows, scrollback: 2000, allowProposedApi: true });
    const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
    try {
      let payload = "";
      for (let i = 0; i < 1500; i++) payload += `line ${i}\r\n`;
      await write(payload);
      const screenBefore = Array.from({ length: rows }, (_, i) =>
        terminal.buffer.normal.getLine(terminal.buffer.normal.baseY + i)?.translateToString(true)
      );

      const managed = makeManaged({
        terminal: Object.assign(terminal, { hasSelection: () => false }),
      });
      vi.useFakeTimers();
      hide("t1", managed);
      vi.advanceTimersByTime(HISTORY_RELEASE_DWELL_MS);
      vi.useRealTimers();

      expect(managed.historyReleased).toBe(true);
      expect(terminal.buffer.normal.length).toBe(rows + RELEASED_SCROLLBACK_LINES);
      const screenAfter = Array.from({ length: rows }, (_, i) =>
        terminal.buffer.normal.getLine(terminal.buffer.normal.baseY + i)?.translateToString(true)
      );
      expect(screenAfter).toEqual(screenBefore);

      await write("after release\r\n");
      expect(
        terminal.buffer.normal
          .getLine(terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY - 1)
          ?.translateToString(true)
      ).toBe("after release");
      expect(terminal.buffer.normal.length).toBe(rows + RELEASED_SCROLLBACK_LINES);
    } finally {
      terminal.dispose();
    }
  });
});
