// @vitest-environment jsdom
import { Terminal } from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HISTORY_LOST_NOTICE,
  TerminalHistoryReleaseController,
} from "../TerminalHistoryReleaseController";
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

const renderSuspension = vi.hoisted(() => ({
  suspendXtermRender: vi.fn(() => true),
  resumeXtermRender: vi.fn(),
}));
vi.mock("../xtermRenderSuspension", () => renderSuspension);

const AGENT_CEILING = getScrollbackForType(true, mockScrollbackStore.scrollbackLines);
const EXIT_LINE = "\r\n[Process exited with code 1]\r\n";

function makeManaged(overrides: Record<string, unknown> = {}): ManagedTerminal {
  const buffer = { length: 3000 };
  return {
    terminal: {
      options: { scrollback: AGENT_CEILING, disableStdin: false },
      rows: 24,
      cols: 180,
      buffer: { active: buffer, normal: buffer },
      textarea: undefined,
      hasSelection: vi.fn(() => false),
      write: vi.fn((_data: unknown, callback?: () => void) => callback?.()),
    },
    kind: "terminal",
    runtimeAgentId: "claude",
    isOpened: false,
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
  let inputHeldDuringFetch: boolean[];
  let localWrites: string[];
  let controller: TerminalHistoryReleaseController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16)
    );
    renderSuspension.suspendXtermRender.mockClear();
    renderSuspension.resumeXtermRender.mockClear();
    instances = new Map();
    observable = true;
    workerIngest = false;
    mockPerformanceModeStore.performanceMode = false;
    inputHeldDuringFetch = [];
    localWrites = [];
    fetchAndRestore = vi.fn(async (id: string) => {
      inputHeldDuringFetch.push(instances.get(id)?.isInputLocked === true);
      return true;
    });
    controller = new TerminalHistoryReleaseController({
      getInstance: (id) => instances.get(id),
      fetchAndRestore,
      isViewObservable: () => observable,
      isWorkerIngestEnabled: () => workerIngest,
      applyInputLock: (managed) => {
        managed.isInputLocked =
          managed.inputLockedByUser === true || managed.historyRefilling === true;
      },
      writeLocal: (_managed, data) => localWrites.push(data),
    });
  });

  afterEach(() => {
    for (const managed of instances.values()) controller.cancel(managed);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  function hide(id: string, managed: ManagedTerminal): void {
    instances.set(id, managed);
    controller.sync(id);
  }

  function releaseHidden(id: string, managed = makeManaged()): ManagedTerminal {
    hide(id, managed);
    vi.advanceTimersByTime(HISTORY_RELEASE_DWELL_MS);
    expect(managed.historyReleased).toBe(true);
    return managed;
  }

  async function reveal(id: string): Promise<void> {
    const managed = instances.get(id)!;
    managed.isVisible = true;
    controller.sync(id);
    await vi.advanceTimersByTimeAsync(100);
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

  it("does not restart a dwell already running when hidden again", () => {
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
    ["a reader pins the history", (m) => (m.historyPins = 1), () => {}],
    ["the PTY has exited", (m) => (m.ptyExited = true), () => {}],
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

  it("keeps a pane holding real keyboard focus, but not one left flagged focused", () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    const focused = makeManaged();
    (focused.terminal as { textarea?: HTMLTextAreaElement }).textarea = textarea;
    hide("focused", focused);

    // Unmounted while focused: the flag is stale, nothing has the DOM focus.
    const stale = makeManaged({ isFocused: true });
    hide("stale", stale);

    vi.advanceTimersByTime(HISTORY_RELEASE_DWELL_MS * 2);
    expect(focused.historyReleased).toBeFalsy();
    expect(stale.historyReleased).toBe(true);
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

  it("holds capacity while hidden and refills history once, on reveal", async () => {
    const managed = releaseHidden("t1");

    // Tier flaps while hidden must not regrow the capacity.
    restoreScrollback(managed);
    expect(managed.terminal.options.scrollback).toBe(RELEASED_SCROLLBACK_LINES);

    await reveal("t1");
    controller.sync("t1");
    await vi.advanceTimersByTimeAsync(100);

    expect(managed.historyReleased).toBe(false);
    expect(managed.historyRefillPending).toBe(false);
    expect(managed.terminal.options.scrollback).toBe(AGENT_CEILING);
    expect(fetchAndRestore).toHaveBeenCalledTimes(1);
    expect(fetchAndRestore).toHaveBeenCalledWith("t1");
  });

  it("holds typing and painting through the replay, then lets both go", async () => {
    const managed = releaseHidden("t1", makeManaged({ isOpened: true }));

    await reveal("t1");

    expect(inputHeldDuringFetch).toEqual([true]);
    expect(managed.isInputLocked).toBe(false);
    expect(renderSuspension.suspendXtermRender).toHaveBeenCalledTimes(1);
    const [, owner] = renderSuspension.suspendXtermRender.mock.calls[0] as unknown[];
    expect(owner).not.toBe("view");
    expect(renderSuspension.resumeXtermRender).toHaveBeenCalledWith(managed.terminal, owner);
  });

  it("paints the live frame before the replay starts", async () => {
    releaseHidden("t1", makeManaged({ isOpened: true }));
    const managed = instances.get("t1")!;
    managed.isVisible = true;
    controller.sync("t1");

    await vi.advanceTimersByTimeAsync(16);
    expect(fetchAndRestore).not.toHaveBeenCalled();
    expect(renderSuspension.suspendXtermRender).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(fetchAndRestore).toHaveBeenCalledTimes(1);
  });

  it("leaves a user's input lock in place after the replay", async () => {
    const managed = releaseHidden("t1");
    managed.inputLockedByUser = true;
    managed.isInputLocked = true;

    await reveal("t1");

    expect(inputHeldDuringFetch).toEqual([true]);
    expect(managed.isInputLocked).toBe(true);
  });

  it("keeps the paint hold through a hide and reveal in the middle of the replay", async () => {
    releaseHidden("t1", makeManaged({ isOpened: true }));
    let finish!: (restored: boolean) => void;
    fetchAndRestore.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (finish = resolve))
    );

    await reveal("t1");
    const managed = instances.get("t1")!;
    managed.isVisible = false;
    controller.sync("t1");
    managed.isVisible = true;
    controller.sync("t1");
    await vi.advanceTimersByTimeAsync(100);

    expect(fetchAndRestore).toHaveBeenCalledTimes(1);
    expect(renderSuspension.resumeXtermRender).not.toHaveBeenCalled();
    expect(managed.isInputLocked).toBe(true);

    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(renderSuspension.resumeXtermRender).toHaveBeenCalledTimes(1);
    expect(managed.isInputLocked).toBe(false);
  });

  it("retries a failed refill on the next reveal", async () => {
    const managed = releaseHidden("t1");
    fetchAndRestore.mockResolvedValueOnce(false);

    await reveal("t1");
    expect(managed.historyRefillPending).toBe(true);

    managed.isVisible = false;
    controller.sync("t1");
    await reveal("t1");

    expect(fetchAndRestore).toHaveBeenCalledTimes(2);
    expect(managed.historyRefillPending).toBe(false);
  });

  it("tries for the history at once when a released session exits, and never again", async () => {
    const managed = releaseHidden("t1");
    fetchAndRestore.mockResolvedValueOnce(false);

    controller.noteExit("t1", EXIT_LINE);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchAndRestore).toHaveBeenCalledTimes(1);
    expect(managed.historyRefillPending).toBe(false);
    await reveal("t1");
    expect(fetchAndRestore).toHaveBeenCalledTimes(1);
  });

  it("keeps a memory-pressure cap through an exit-time refill of a hidden pane", async () => {
    const managed = releaseHidden("t1");
    managed.scrollbackPressureCapped = true;

    controller.noteExit("t1", EXIT_LINE);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchAndRestore).toHaveBeenCalledTimes(1);
    expect(managed.terminal.options.scrollback).toBe(RELEASED_SCROLLBACK_LINES);
  });

  it("refills a capped exit-time refill again at full capacity on reveal", async () => {
    const managed = releaseHidden("t1");
    managed.scrollbackPressureCapped = true;

    controller.noteExit("t1", EXIT_LINE);
    await vi.advanceTimersByTimeAsync(0);
    expect(managed.historyRefillPending).toBe(true);

    await reveal("t1");

    expect(fetchAndRestore).toHaveBeenCalledTimes(2);
    expect(managed.terminal.options.scrollback).toBe(AGENT_CEILING);
    expect(managed.historyRefillPending).toBe(false);
    // Each restore replays over the marker, so each one writes it back.
    expect(localWrites).toEqual([EXIT_LINE, EXIT_LINE]);
  });

  it("writes the exit line only after the exit-time refill lands", async () => {
    releaseHidden("t1");
    let finish!: (restored: boolean) => void;
    fetchAndRestore.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (finish = resolve))
    );

    controller.noteExit("t1", EXIT_LINE);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchAndRestore).toHaveBeenCalledTimes(1);
    expect(localWrites).toEqual([]);

    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(localWrites).toEqual([EXIT_LINE]);
  });

  it("says the earlier output is gone when a released session's refill comes back empty", async () => {
    releaseHidden("t1");
    fetchAndRestore.mockResolvedValueOnce(false);

    controller.noteExit("t1", EXIT_LINE);
    await vi.advanceTimersByTimeAsync(0);

    expect(localWrites).toEqual([HISTORY_LOST_NOTICE, EXIT_LINE]);
    expect(HISTORY_LOST_NOTICE).toContain(
      "[Earlier output was released while this terminal was hidden and can't be restored]"
    );
  });

  it("writes the exit line at once, with no notice, for a pane that kept its history", () => {
    const managed = makeManaged();
    hide("t1", managed);

    controller.noteExit("t1", EXIT_LINE);

    expect(fetchAndRestore).not.toHaveBeenCalled();
    expect(localWrites).toEqual([EXIT_LINE]);
  });

  it("never refills a pane whose history was not released", async () => {
    const managed = makeManaged({ isVisible: true });
    instances.set("t1", managed);
    controller.sync("t1");
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchAndRestore).not.toHaveBeenCalled();
  });

  it("frees a real xterm's history while it keeps parsing the live screen", async () => {
    // xterm parses on a real timer, so only the dwell runs on the fake clock.
    vi.useRealTimers();
    const rows = 10;
    const terminal = new Terminal({ cols: 40, rows, scrollback: 2000, allowProposedApi: true });
    const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
    const screen = () =>
      Array.from({ length: rows }, (_, i) =>
        terminal.buffer.normal.getLine(terminal.buffer.normal.baseY + i)?.translateToString(true)
      );
    try {
      let payload = "";
      for (let i = 0; i < 1500; i++) payload += `line ${i}\r\n`;
      await write(payload);
      const screenBefore = screen();

      const managed = makeManaged({
        terminal: Object.assign(terminal, { hasSelection: () => false }),
      });
      vi.useFakeTimers();
      hide("t1", managed);
      vi.advanceTimersByTime(HISTORY_RELEASE_DWELL_MS);
      vi.useRealTimers();

      expect(managed.historyReleased).toBe(true);
      expect(terminal.buffer.normal.length).toBe(rows + RELEASED_SCROLLBACK_LINES);
      expect(screen()).toEqual(screenBefore);

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
