/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const waitForAttachSettledMock =
  vi.fn<(id: string, opts?: { timeoutMs?: number }) => Promise<void>>();
const repaintForRevealMock = vi.fn<(id: string) => boolean>();
const revealTerminalMock = vi.fn<(id: string) => Promise<boolean>>();

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    waitForAttachSettled: waitForAttachSettledMock,
    repaintForReveal: repaintForRevealMock,
    revealTerminal: revealTerminalMock,
  },
}));

const { createWorktreeRevealCoordinator } = await import("../worktreeRevealCoordinator");

/** Drain the microtask queue without letting a frame pass. */
async function drainMicrotasks(ticks = 12): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

/**
 * `revealUntilStable` yields a real frame between attempts, so the coordinator's
 * chain needs frames as well as microtasks to quiesce. MAX_REVEAL_FRAMES is 10,
 * so 16 covers a full budget plus the attach-wait retries.
 */
async function settle(frames = 16): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await drainMicrotasks(4);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  await drainMicrotasks();
}

beforeEach(() => {
  waitForAttachSettledMock.mockReset();
  waitForAttachSettledMock.mockResolvedValue(undefined);
  repaintForRevealMock.mockReset();
  repaintForRevealMock.mockReturnValue(true);
  revealTerminalMock.mockReset();
});

describe("worktreeRevealCoordinator", () => {
  it("does not repaint at arm time — the mount is the trigger", async () => {
    const coordinator = createWorktreeRevealCoordinator();
    coordinator.replace(1, ["a", "b"]);

    await settle(2);

    // A warm parked terminal already satisfies isAttachSettled, so an eager
    // discharge would burn the whole frame budget against a still-hidden host.
    expect(waitForAttachSettledMock).not.toHaveBeenCalled();
    expect(repaintForRevealMock).not.toHaveBeenCalled();
    expect(coordinator.pendingIds()).toEqual(["a", "b"]);
  });

  it("repaints and clears the obligation once the attach settles", async () => {
    const coordinator = createWorktreeRevealCoordinator();
    coordinator.replace(1, ["a"]);

    coordinator.notifyAttached("a");
    await settle();

    expect(waitForAttachSettledMock).toHaveBeenCalledWith("a", expect.anything());
    expect(repaintForRevealMock).toHaveBeenCalledWith("a");
    expect(coordinator.pendingIds()).toEqual([]);
  });

  it("waits for the attach to settle before repainting", async () => {
    let releaseAttach: (() => void) | undefined;
    waitForAttachSettledMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseAttach = resolve;
        })
    );

    const coordinator = createWorktreeRevealCoordinator();
    coordinator.replace(1, ["a"]);
    coordinator.notifyAttached("a");
    await settle(2);

    expect(repaintForRevealMock).not.toHaveBeenCalled();

    releaseAttach?.();
    await settle();

    expect(repaintForRevealMock).toHaveBeenCalledWith("a");
  });

  it("re-arms the attach wait after a timeout instead of abandoning the obligation", async () => {
    waitForAttachSettledMock
      .mockRejectedValueOnce(new Error("attach settle timeout"))
      .mockResolvedValue(undefined);

    const coordinator = createWorktreeRevealCoordinator();
    coordinator.replace(1, ["a"]);
    coordinator.notifyAttached("a");
    await settle();

    expect(waitForAttachSettledMock).toHaveBeenCalledTimes(2);
    expect(coordinator.pendingIds()).toEqual([]);
  });

  it("keeps the obligation armed when every attach wait times out", async () => {
    waitForAttachSettledMock.mockRejectedValue(new Error("attach settle timeout"));

    const coordinator = createWorktreeRevealCoordinator();
    coordinator.replace(1, ["a"]);
    coordinator.notifyAttached("a");
    await settle();

    expect(repaintForRevealMock).not.toHaveBeenCalled();
    expect(coordinator.pendingIds()).toEqual(["a"]);
  });

  it("requires a confirmed paint — an unpaintable host stays armed", async () => {
    repaintForRevealMock.mockReturnValue(false);

    const coordinator = createWorktreeRevealCoordinator();
    coordinator.replace(1, ["a"]);
    coordinator.notifyAttached("a");
    await settle();

    expect(repaintForRevealMock).toHaveBeenCalled();
    expect(coordinator.pendingIds()).toEqual(["a"]);
  });

  it("banks two separate confirm paints before discharging", async () => {
    const coordinator = createWorktreeRevealCoordinator();
    coordinator.replace(1, ["a"]);
    coordinator.notifyAttached("a");
    await settle();

    // Drives the full revealUntilStable loop, not a single bare repaint: one
    // unstuck paint can be undone by the compositor swap or xterm's own
    // observers re-firing, which is why the confirm pass exists. Swapping the
    // loop for a lone repaintForReveal call would land exactly one.
    expect(repaintForRevealMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the obligation armed when the document hides mid-reveal", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");

    const coordinator = createWorktreeRevealCoordinator();
    coordinator.replace(1, ["a"]);
    coordinator.notifyAttached("a");
    await settle();

    // Repainting a hidden surface is pointless, but abandoning the obligation
    // would strand the pane garbled once the window comes back.
    expect(coordinator.pendingIds()).toEqual(["a"]);

    visibility.mockRestore();
  });

  it("never routes through revealTerminal, which reports true for a missing instance", async () => {
    const coordinator = createWorktreeRevealCoordinator();
    coordinator.replace(1, ["a"]);
    coordinator.notifyAttached("a");
    await settle();

    expect(revealTerminalMock).not.toHaveBeenCalled();
  });

  it("ignores an attach notification for a terminal it is not tracking", async () => {
    const coordinator = createWorktreeRevealCoordinator();
    coordinator.replace(1, ["a"]);

    coordinator.notifyAttached("someone-else");
    await settle(2);

    expect(waitForAttachSettledMock).not.toHaveBeenCalled();
  });

  it("does not stack parallel loops for duplicate attach notifications", async () => {
    // Park every discharge on an attach wait that never resolves, so a second
    // loop would have to show up as a second waitForAttachSettled call.
    waitForAttachSettledMock.mockImplementation(() => new Promise<void>(() => {}));

    const coordinator = createWorktreeRevealCoordinator();
    coordinator.replace(1, ["a"]);
    coordinator.notifyAttached("a");
    coordinator.notifyAttached("a");
    coordinator.notifyAttached("a");
    await settle(2);

    expect(waitForAttachSettledMock).toHaveBeenCalledTimes(1);
  });

  it("re-drives a remount that lands while a discharge is in flight", async () => {
    // The remount re-attaches, so the re-drive legitimately re-awaits the settle.
    // Hold every resolver so the second wait can be released independently.
    const resolvers: Array<() => void> = [];
    waitForAttachSettledMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const releaseAll = (): void => {
      resolvers.splice(0).forEach((resolve) => resolve());
    };

    const coordinator = createWorktreeRevealCoordinator();
    coordinator.replace(1, ["a"]);
    coordinator.notifyAttached("a");
    await settle(2);

    // Second mount lands while the first discharge is parked on its attach wait.
    coordinator.notifyAttached("a");
    releaseAll();
    await settle(2);

    // The superseded pass bailed without painting, and the re-drive is now
    // parked on its own attach wait.
    expect(waitForAttachSettledMock).toHaveBeenCalledTimes(2);
    expect(coordinator.pendingIds()).toEqual(["a"]);

    releaseAll();
    await settle();

    expect(repaintForRevealMock).toHaveBeenCalledWith("a");
    expect(coordinator.pendingIds()).toEqual([]);
  });

  it("keeps the obligation when a remount lands after the final confirm paint", async () => {
    // revealUntilStable yields one more frame AFTER its last confirm paint and
    // returns without another abort check. A remount arriving in that gap has
    // its notification swallowed by the inFlight guard, so retiring the
    // obligation on object identity alone would lose it permanently.
    let paints = 0;
    const coordinator = createWorktreeRevealCoordinator();
    repaintForRevealMock.mockImplementation(() => {
      paints++;
      // Fire the remount as the second (final) confirm paint lands, so the
      // notification falls inside revealUntilStable's trailing frame yield.
      if (paints === 2) coordinator.notifyAttached("a");
      return true;
    });

    coordinator.replace(1, ["a"]);
    coordinator.notifyAttached("a");
    await settle();

    // The newer mount still owes a reveal, so the entry must survive and be
    // re-driven rather than retired by the superseded pass.
    expect(waitForAttachSettledMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("drops obligations for terminals the next policy pass no longer targets", () => {
    const coordinator = createWorktreeRevealCoordinator();
    coordinator.replace(1, ["a", "b"]);
    coordinator.replace(2, ["b", "c"]);

    // Wholesale replacement is what bounds the map — "a" never mounted and is gone.
    expect(coordinator.pendingIds()).toEqual(["b", "c"]);
  });

  it("carries a live obligation across a same-generation replay", async () => {
    let releaseAttach: (() => void) | undefined;
    waitForAttachSettledMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseAttach = resolve;
        })
    );

    const coordinator = createWorktreeRevealCoordinator();
    coordinator.replace(1, ["a"]);
    coordinator.notifyAttached("a");
    await settle(2);

    // applyPendingWorktreeSelection replays the CURRENT generation; swapping the
    // entry here would strand the in-flight discharge as permanently stale.
    coordinator.replace(1, ["a"]);
    releaseAttach?.();
    await settle();

    expect(repaintForRevealMock).toHaveBeenCalledWith("a");
    expect(coordinator.pendingIds()).toEqual([]);
  });

  it("does not let a superseded generation's discharge clear a newer obligation", async () => {
    let releaseAttach: (() => void) | undefined;
    waitForAttachSettledMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseAttach = resolve;
        })
    );

    const coordinator = createWorktreeRevealCoordinator();
    // A -> B -> A: generation 1's in-flight pass must not discharge generation 3.
    coordinator.replace(1, ["a"]);
    coordinator.notifyAttached("a");
    await settle(2);
    coordinator.replace(2, ["b"]);
    coordinator.replace(3, ["a"]);

    releaseAttach?.();
    await settle();

    expect(coordinator.pendingIds()).toEqual(["a"]);
  });

  it("clear() drops every obligation and stops an in-flight discharge", async () => {
    let releaseAttach: (() => void) | undefined;
    waitForAttachSettledMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseAttach = resolve;
        })
    );

    const coordinator = createWorktreeRevealCoordinator();
    coordinator.replace(1, ["a"]);
    coordinator.notifyAttached("a");
    await settle(2);

    coordinator.clear();
    releaseAttach?.();
    await settle();

    expect(coordinator.pendingIds()).toEqual([]);
    expect(repaintForRevealMock).not.toHaveBeenCalled();
  });

  it("caps how many terminals repaint concurrently", async () => {
    const painted = new Set<string>();
    repaintForRevealMock.mockImplementation((id: string) => {
      painted.add(id);
      return true;
    });

    const coordinator = createWorktreeRevealCoordinator();
    const ids = ["a", "b", "c", "d", "e", "f"];
    coordinator.replace(1, ids);
    for (const id of ids) coordinator.notifyAttached(id);

    // Before any frame elapses only the slot holders can have painted — every
    // panel in the incoming worktree mounts in the same commit, so without the
    // gate all six would repaint on one frame.
    await drainMicrotasks();
    expect(painted.size).toBeLessThanOrEqual(2);

    await settle(40);
    expect(coordinator.pendingIds()).toEqual([]);
  });
});
