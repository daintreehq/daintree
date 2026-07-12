// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const suppressMock = vi.hoisted(() => vi.fn());
const lockResizeMock = vi.hoisted(() => vi.fn());
const repaintForRevealMock = vi.hoisted(() => vi.fn());
const revealTerminalMock = vi.hoisted(() => vi.fn());
const waitForAttachSettledMock = vi.hoisted(() => vi.fn());
const lockMock = vi.hoisted(() => vi.fn());
const getPanelStateMock = vi.hoisted(() => vi.fn());
const getWorktreeSelectionStateMock = vi.hoisted(() => vi.fn());

type HelpPanelFixture = { terminalId: string | null; sessionId: string | null };
type HelpPanelSubscriber = (state: HelpPanelFixture, prev: HelpPanelFixture) => void;

// The help store is the discharge trigger, so the mock needs a real subscriber
// list — `getState` alone can't express the null→bound edge #11070 turns on.
const helpPanelStoreMock = vi.hoisted(() => {
  let state: HelpPanelFixture = { terminalId: null, sessionId: null };
  const subscribers = new Set<HelpPanelSubscriber>();
  return {
    getState: (): HelpPanelFixture => state,
    subscribe: (fn: HelpPanelSubscriber): (() => void) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    /** Test-side: publish a new state and notify, exactly as Zustand would. */
    emit(next: Partial<HelpPanelFixture>): void {
      const prev = state;
      state = { ...state, ...next };
      for (const fn of subscribers) fn(state, prev);
    },
    reset(): void {
      state = { terminalId: null, sessionId: null };
      subscribers.clear();
    },
    subscriberCount: (): number => subscribers.size,
  };
});

vi.mock("@/services/terminal/TerminalInstanceService", () => ({
  terminalInstanceService: {
    suppressResizesDuringLayoutTransition: suppressMock,
    lockResize: lockResizeMock,
    repaintForReveal: repaintForRevealMock,
    revealTerminal: revealTerminalMock,
    waitForAttachSettled: waitForAttachSettledMock,
  },
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: getPanelStateMock },
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: getWorktreeSelectionStateMock },
}));

vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: helpPanelStoreMock,
}));

vi.mock("../layoutTransitionLock", () => ({
  lockSidebarLayoutTransition: lockMock,
}));

import { createAssistantRevealCoordinator, suppressSidebarResizes } from "../sidebarToggle";
import { MAX_REVEAL_FRAMES, REVEAL_CONFIRM_PAINTS } from "@/services/terminal/revealUntilStable";
import { SIDEBAR_TOGGLE_LOCK_MS } from "../terminalLayout";

type PanelFixture = {
  id: string;
  location: "grid" | "dock" | "trash" | "background";
  worktreeId: string | null;
};

function setup(panels: PanelFixture[], activeWorktreeId: string | null) {
  getPanelStateMock.mockReturnValue({
    panelIds: panels.map((p) => p.id),
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
  });
  getWorktreeSelectionStateMock.mockReturnValue({ activeWorktreeId });
}

describe("suppressSidebarResizes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    helpPanelStoreMock.reset();
  });

  it("suppresses resizes for grid panels of the active worktree", () => {
    setup(
      [
        { id: "p-1", location: "grid", worktreeId: "wt-a" },
        { id: "p-2", location: "grid", worktreeId: "wt-a" },
      ],
      "wt-a"
    );

    suppressSidebarResizes();

    expect(suppressMock).toHaveBeenCalledTimes(1);
    expect(suppressMock).toHaveBeenCalledWith(["p-1", "p-2"], SIDEBAR_TOGGLE_LOCK_MS);
  });

  it("excludes dock panels from the suppression set", () => {
    setup(
      [
        { id: "p-grid", location: "grid", worktreeId: "wt-a" },
        { id: "p-dock", location: "dock", worktreeId: "wt-a" },
      ],
      "wt-a"
    );

    suppressSidebarResizes();

    expect(suppressMock).toHaveBeenCalledWith(["p-grid"], SIDEBAR_TOGGLE_LOCK_MS);
  });

  it("excludes panels belonging to other worktrees", () => {
    setup(
      [
        { id: "p-active", location: "grid", worktreeId: "wt-a" },
        { id: "p-other", location: "grid", worktreeId: "wt-b" },
      ],
      "wt-a"
    );

    suppressSidebarResizes();

    expect(suppressMock).toHaveBeenCalledWith(["p-active"], SIDEBAR_TOGGLE_LOCK_MS);
  });

  it("excludes trash and background panels from the suppression set", () => {
    setup(
      [
        { id: "p-grid", location: "grid", worktreeId: "wt-a" },
        { id: "p-trash", location: "trash", worktreeId: "wt-a" },
        { id: "p-bg", location: "background", worktreeId: "wt-a" },
      ],
      "wt-a"
    );

    suppressSidebarResizes();

    expect(suppressMock).toHaveBeenCalledWith(["p-grid"], SIDEBAR_TOGGLE_LOCK_MS);
  });

  it("handles a null activeWorktreeId without crashing", () => {
    setup([{ id: "p-1", location: "grid", worktreeId: "wt-a" }], null);

    expect(() => suppressSidebarResizes()).not.toThrow();
    expect(suppressMock).toHaveBeenCalledWith([], SIDEBAR_TOGGLE_LOCK_MS);
  });

  it("locks the sidebar layout transition for the same window", () => {
    setup([{ id: "p-1", location: "grid", worktreeId: "wt-a" }], "wt-a");

    suppressSidebarResizes();

    expect(lockMock).toHaveBeenCalledTimes(1);
    expect(lockMock).toHaveBeenCalledWith(SIDEBAR_TOGGLE_LOCK_MS);
  });

  it("includes the assistant terminal when it is a live panel", () => {
    helpPanelStoreMock.emit({ terminalId: "assistant-1" });
    setup(
      [
        { id: "p-grid", location: "grid", worktreeId: "wt-a" },
        { id: "assistant-1", location: "dock", worktreeId: "wt-a" },
      ],
      "wt-a"
    );

    suppressSidebarResizes();

    // The dock-located assistant terminal is suppressed even though dock panels
    // are otherwise excluded — it animates alongside the sidebar gesture.
    expect(suppressMock).toHaveBeenCalledWith(["p-grid", "assistant-1"], SIDEBAR_TOGGLE_LOCK_MS);
  });

  it("omits the assistant terminal when it is not yet a registered panel", () => {
    helpPanelStoreMock.emit({ terminalId: "assistant-1" });
    setup([{ id: "p-grid", location: "grid", worktreeId: "wt-a" }], "wt-a");

    suppressSidebarResizes();

    expect(suppressMock).toHaveBeenCalledWith(["p-grid"], SIDEBAR_TOGGLE_LOCK_MS);
  });
});

describe("createAssistantRevealCoordinator — issue #11070", () => {
  let rafQueue: FrameRequestCallback[] = [];
  let dispose: (() => void) | null = null;

  // Frames are queued, never run inline: a synchronous rAF stub collapses the
  // frame separation the confirm-paint pass and the generation guards rely on.
  async function pump(ticks = MAX_REVEAL_FRAMES + 2): Promise<void> {
    for (let i = 0; i < ticks; i++) {
      await Promise.resolve();
      const queued = rafQueue;
      rafQueue = [];
      for (const cb of queued) cb(0);
      await Promise.resolve();
    }
  }

  function start() {
    const coordinator = createAssistantRevealCoordinator();
    dispose = coordinator.start();
    coordinator.setVisible(true);
    return coordinator;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    helpPanelStoreMock.reset();
    rafQueue = [];
    dispose = null;
    repaintForRevealMock.mockReturnValue(true);
    waitForAttachSettledMock.mockResolvedValue(undefined);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
  });

  afterEach(() => {
    dispose?.();
    vi.unstubAllGlobals();
  });

  it("repaints the warm assistant terminal that is already bound at settle time", async () => {
    helpPanelStoreMock.emit({ terminalId: "assistant-1" });
    const coordinator = start();

    coordinator.settleAfterTransition(true);
    await pump();

    // The attach gate is not skipped even on the warm path — it resolves at once
    // for an already-attached terminal, and going through it keeps a mid-attach
    // paint from retiring the obligation early.
    expect(waitForAttachSettledMock).toHaveBeenCalledWith("assistant-1", {
      timeoutMs: expect.any(Number),
    });
    expect(repaintForRevealMock).toHaveBeenCalledTimes(REVEAL_CONFIRM_PAINTS);
    expect(repaintForRevealMock).toHaveBeenCalledWith("assistant-1");
  });

  it("does not clear the resize lock — the suppression timer owns the unlock", async () => {
    // reconcileGeometryFresh inside repaintForReveal is lock-exempt, so the
    // corrective resize lands while the lock stays armed. Clearing it here would
    // defeat the dead-man TTL that gates the ResizeObserver debounce tail.
    helpPanelStoreMock.emit({ terminalId: "assistant-1" });
    const coordinator = start();

    coordinator.settleAfterTransition(true);
    await pump();

    expect(lockResizeMock).not.toHaveBeenCalled();
  });

  it("retains the dropped repaint and discharges it once the terminal binds", async () => {
    // The #11070 regression: the slide settles while the session is still
    // provisioning, so there is no terminalId to repaint. The old one-shot
    // returned early and the footer never painted.
    const coordinator = start();

    coordinator.settleAfterTransition(true);
    expect(repaintForRevealMock).not.toHaveBeenCalled();

    helpPanelStoreMock.emit({ terminalId: "assistant-1", sessionId: "s-1" });
    await pump();

    expect(waitForAttachSettledMock).toHaveBeenCalledWith("assistant-1", {
      timeoutMs: expect.any(Number),
    });
    expect(repaintForRevealMock).toHaveBeenCalledTimes(REVEAL_CONFIRM_PAINTS);
    expect(repaintForRevealMock).toHaveBeenCalledWith("assistant-1");
  });

  it("discharges through repaintForReveal, never revealTerminal (#10671)", async () => {
    // revealTerminal passes trustDomVisibility, which would let a transform-hidden
    // assistant pane accumulate a fleet-wide WebGL want — and it reports `true`
    // for a MISSING instance, which would bank false confirm paints against a
    // reserved-but-unregistered id and re-drop the repaint.
    const coordinator = start();

    coordinator.settleAfterTransition(true);
    helpPanelStoreMock.emit({ terminalId: "assistant-1" });
    await pump();

    expect(revealTerminalMock).not.toHaveBeenCalled();
    expect(repaintForRevealMock).toHaveBeenCalled();
    for (const call of repaintForRevealMock.mock.calls) {
      // No opts argument — the isVisible gate stays on.
      expect(call).toEqual(["assistant-1"]);
    }
  });

  it("waits for the xterm to attach before repainting a freshly reserved id", async () => {
    // setTerminal publishes a RESERVED id before addPanel is even awaited, so the
    // id arriving is not the terminal existing.
    let settleAttach: () => void = () => {};
    waitForAttachSettledMock.mockReturnValue(
      new Promise<void>((resolve) => {
        settleAttach = resolve;
      })
    );
    const coordinator = start();

    coordinator.settleAfterTransition(true);
    helpPanelStoreMock.emit({ terminalId: "assistant-1" });
    await pump(3);

    expect(repaintForRevealMock).not.toHaveBeenCalled();

    settleAttach();
    await pump();

    expect(repaintForRevealMock).toHaveBeenCalledWith("assistant-1");
  });

  it("retries across frames when the host has no renderable box yet", async () => {
    repaintForRevealMock.mockImplementation(
      () => repaintForRevealMock.mock.calls.length > 2 // unpaintable for the first two frames
    );
    const coordinator = start();

    coordinator.settleAfterTransition(true);
    helpPanelStoreMock.emit({ terminalId: "assistant-1" });
    await pump();

    expect(repaintForRevealMock).toHaveBeenCalledTimes(2 + REVEAL_CONFIRM_PAINTS);
  });

  it("drives the retry itself when the terminal is bound but unpaintable — no store edge is coming", async () => {
    // terminalId is already set at settle time, so no null→bound subscription
    // edge will ever fire. The obligation has to start its own discharge.
    helpPanelStoreMock.emit({ terminalId: "assistant-1" });
    repaintForRevealMock.mockReturnValueOnce(false).mockReturnValue(true);
    const coordinator = start();

    coordinator.settleAfterTransition(true);
    await pump();

    expect(waitForAttachSettledMock).toHaveBeenCalledWith("assistant-1", {
      timeoutMs: expect.any(Number),
    });
    // One unpaintable frame, then the confirm paints.
    expect(repaintForRevealMock).toHaveBeenCalledTimes(1 + REVEAL_CONFIRM_PAINTS);
  });

  it("re-arms the attach wait across repeated timeouts, so a late attach still discharges", async () => {
    // A timed-out waiter is deregistered — a single wait would silently abandon a
    // terminal that attaches just after the deadline, with the sidebar still open
    // and no further store edge coming. That is #11070 with a longer fuse.
    // TWO rejections before the success: a one-rejection fixture would also pass
    // against an implementation that only ever retried once.
    waitForAttachSettledMock
      .mockRejectedValueOnce(new Error("attach settle timeout"))
      .mockRejectedValueOnce(new Error("attach settle timeout"))
      .mockResolvedValue(undefined);
    helpPanelStoreMock.emit({ terminalId: "assistant-1" });
    const coordinator = start();

    coordinator.settleAfterTransition(true);
    await pump();

    expect(waitForAttachSettledMock.mock.calls.length).toBeGreaterThan(2);
    expect(repaintForRevealMock).toHaveBeenCalledWith("assistant-1");
  });

  it("gives up the attach wait after a bounded number of attempts", async () => {
    waitForAttachSettledMock.mockRejectedValue(new Error("attach settle timeout"));
    helpPanelStoreMock.emit({ terminalId: "assistant-1" });
    const coordinator = start();

    coordinator.settleAfterTransition(true);
    await pump();

    // Bounded — a dead binding must not spin forever.
    expect(waitForAttachSettledMock.mock.calls.length).toBeLessThan(10);
    expect(repaintForRevealMock).not.toHaveBeenCalled();
  });

  it("cancels the obligation when the assistant is hidden before the terminal binds", async () => {
    const coordinator = start();

    coordinator.settleAfterTransition(true);
    coordinator.setVisible(false);
    helpPanelStoreMock.emit({ terminalId: "assistant-1" });
    await pump();

    // A terminal that binds while the panel is sliding away must not be
    // repainted into a hidden pane.
    expect(repaintForRevealMock).not.toHaveBeenCalled();
  });

  it("abandons an in-flight discharge when the assistant is hidden mid-attach", async () => {
    let settleAttach: () => void = () => {};
    waitForAttachSettledMock.mockReturnValue(
      new Promise<void>((resolve) => {
        settleAttach = resolve;
      })
    );
    const coordinator = start();

    coordinator.settleAfterTransition(true);
    helpPanelStoreMock.emit({ terminalId: "assistant-1" });
    await pump(2);

    coordinator.setVisible(false);
    settleAttach();
    await pump();

    expect(repaintForRevealMock).not.toHaveBeenCalled();
  });

  it("arms nothing on a hide settle", async () => {
    const coordinator = start();

    coordinator.settleAfterTransition(false);
    helpPanelStoreMock.emit({ terminalId: "assistant-1" });
    await pump();

    expect(repaintForRevealMock).not.toHaveBeenCalled();
  });

  it("keeps the obligation armed when the attach wait is exhausted, and retries on the next binding", async () => {
    // Every attach attempt times out, so the discharge gives up — but it must
    // give up WITHOUT retiring the obligation, or the repaint is dropped again.
    waitForAttachSettledMock.mockRejectedValue(new Error("attach settle timeout"));
    const coordinator = start();

    coordinator.settleAfterTransition(true);
    helpPanelStoreMock.emit({ terminalId: "assistant-1" });
    await pump();

    expect(repaintForRevealMock).not.toHaveBeenCalled();

    // The reserved id is finalized in place once provisioning resolves — the
    // session edge picks the still-armed obligation back up.
    waitForAttachSettledMock.mockReset();
    waitForAttachSettledMock.mockResolvedValue(undefined);
    helpPanelStoreMock.emit({ terminalId: "assistant-1", sessionId: "s-1" });
    await pump();

    expect(repaintForRevealMock).toHaveBeenCalledWith("assistant-1");
  });

  it("stops repainting a terminal superseded by a re-bind", async () => {
    let settleAttach: () => void = () => {};
    waitForAttachSettledMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settleAttach = resolve;
        })
    );
    const coordinator = start();

    coordinator.settleAfterTransition(true);
    helpPanelStoreMock.emit({ terminalId: "assistant-1" });
    await pump(2);

    // A relaunch rebinds the panel to a new terminal while the first is still
    // waiting to attach. The stale wait must not repaint the dead id.
    helpPanelStoreMock.emit({ terminalId: "assistant-2" });
    settleAttach();
    await pump();

    expect(repaintForRevealMock).not.toHaveBeenCalledWith("assistant-1");
    expect(repaintForRevealMock).toHaveBeenCalledWith("assistant-2");
  });

  it("does not repaint once disposed, and drops its store subscription", async () => {
    const coordinator = start();

    coordinator.settleAfterTransition(true);
    dispose?.();
    dispose = null;

    expect(helpPanelStoreMock.subscriberCount()).toBe(0);

    helpPanelStoreMock.emit({ terminalId: "assistant-1" });
    await pump();

    expect(repaintForRevealMock).not.toHaveBeenCalled();
  });

  it("ignores help-store updates that leave the terminal binding untouched", async () => {
    const coordinator = start();

    coordinator.settleAfterTransition(true);
    // An unrelated field changing (figures, width, …) must not spin up a discharge.
    helpPanelStoreMock.emit({});
    await pump();

    expect(waitForAttachSettledMock).not.toHaveBeenCalled();
    expect(repaintForRevealMock).not.toHaveBeenCalled();
  });

  it("does not re-discharge a completed obligation on a later binding", async () => {
    const coordinator = start();

    coordinator.settleAfterTransition(true);
    helpPanelStoreMock.emit({ terminalId: "assistant-1" });
    await pump();
    const callsAfterDischarge = repaintForRevealMock.mock.calls.length;
    expect(callsAfterDischarge).toBe(REVEAL_CONFIRM_PAINTS);

    // The obligation is discharged; a later session update is not a new trigger.
    helpPanelStoreMock.emit({ sessionId: "s-2" });
    await pump();

    expect(repaintForRevealMock).toHaveBeenCalledTimes(callsAfterDischarge);
  });
});
