import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PanelInstance } from "@shared/types/panel";

const fullWakeMock = vi.fn();
const repaintForRevealMock = vi.fn();
const revealTerminalMock = vi.fn();
const isFocusedMock = vi.fn();
const setFocusedMock = vi.fn();
const logWarnMock = vi.fn();
const notifyWarmReactivationCompleteMock = vi.fn();

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    fullWakeForVisibilityRestore: fullWakeMock,
    repaintForReveal: repaintForRevealMock,
    revealTerminal: revealTerminalMock,
    isFocused: isFocusedMock,
    setFocused: setFocusedMock,
  },
}));

vi.mock("@/utils/logger", () => ({
  logWarn: logWarnMock,
}));

vi.mock("@/utils/warmReactivationGate", () => ({
  notifyWarmReactivationComplete: notifyWarmReactivationCompleteMock,
}));

let mockActiveWorktreeId: string | null = null;
let mockPanelIds: string[] = [];
let mockPanelsById: Record<string, PanelInstance> = {};
let mockFocusedId: string | null = null;
let mockHelpTerminalId: string | null = null;

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({ activeWorktreeId: mockActiveWorktreeId }),
  },
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      panelIds: mockPanelIds,
      panelsById: mockPanelsById,
      focusedId: mockFocusedId,
    }),
  },
}));

vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: {
    getState: () => ({ terminalId: mockHelpTerminalId }),
  },
  // #12108: the wake fan-out covers every assistant lane, not just the focused
  // one — a background assistant's xterm still needs waking on view reveal.
  selectSlotTerminalIds: (s: { terminalId: string | null }) => (s.terminalId ? [s.terminalId] : []),
}));

const { wakeActiveWorktreeTerminals, repaintActiveWorktreeTerminals } =
  await import("@/store/wakeActiveWorktreeTerminals");

function panel(id: string, overrides: Partial<PanelInstance> = {}): PanelInstance {
  return {
    id,
    title: id,
    kind: "terminal",
    location: "grid",
    ...overrides,
  } as PanelInstance;
}

beforeEach(() => {
  fullWakeMock.mockReset();
  fullWakeMock.mockResolvedValue(undefined);
  repaintForRevealMock.mockReset();
  revealTerminalMock.mockReset();
  setFocusedMock.mockReset();
  // Default: terminals are paintable on the first attempt.
  revealTerminalMock.mockResolvedValue(true);
  isFocusedMock.mockReset();
  isFocusedMock.mockReturnValue(false);
  logWarnMock.mockReset();
  notifyWarmReactivationCompleteMock.mockReset();
  mockActiveWorktreeId = null;
  mockPanelIds = [];
  mockPanelsById = {};
  mockFocusedId = null;
  mockHelpTerminalId = null;
});

describe("wakeActiveWorktreeTerminals", () => {
  it("wakes grid terminals in the active worktree", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const b = panel("b", { worktreeId: "wt-1" });
    mockPanelIds = ["a", "b"];
    mockPanelsById = { a, b };

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(2);
    expect(fullWakeMock).toHaveBeenCalledWith("a");
    expect(fullWakeMock).toHaveBeenCalledWith("b");
  });

  it("releases the warm reactivation gate after waking (#9679)", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    mockPanelIds = ["a"];
    mockPanelsById = { a };

    await wakeActiveWorktreeTerminals();

    expect(notifyWarmReactivationCompleteMock).toHaveBeenCalledTimes(1);
  });

  it("releases the warm reactivation gate even with zero grid terminals", async () => {
    // No matching panels — the early return must still fire the warm signal so
    // the bridge cover doesn't linger until main's hard timeout on empty grids.
    mockActiveWorktreeId = "wt-1";

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).not.toHaveBeenCalled();
    expect(notifyWarmReactivationCompleteMock).toHaveBeenCalledTimes(1);
  });

  it("releases the warm reactivation gate even when a wake throws", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    mockPanelIds = ["a"];
    mockPanelsById = { a };
    // A wake rejection is caught per-terminal, but assert the finally still runs.
    fullWakeMock.mockRejectedValue(new Error("wake boom"));

    await wakeActiveWorktreeTerminals();

    expect(notifyWarmReactivationCompleteMock).toHaveBeenCalledTimes(1);
  });

  it("excludes terminals from other worktrees", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const b = panel("b", { worktreeId: "wt-2" });
    mockPanelIds = ["a", "b"];
    mockPanelsById = { a, b };

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(1);
    expect(fullWakeMock).toHaveBeenCalledWith("a");
  });

  it("excludes dock-located terminals", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1", location: "grid" });
    const dock = panel("dock", { worktreeId: "wt-1", location: "dock" });
    mockPanelIds = ["a", "dock"];
    mockPanelsById = { a, dock };

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(1);
    expect(fullWakeMock).toHaveBeenCalledWith("a");
  });

  it("excludes trash-located terminals", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const trash = panel("trash", { worktreeId: "wt-1", location: "trash" });
    mockPanelIds = ["a", "trash"];
    mockPanelsById = { a, trash };

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(1);
    expect(fullWakeMock).toHaveBeenCalledWith("a");
  });

  it("excludes non-terminal panel kinds", async () => {
    mockActiveWorktreeId = "wt-1";
    const term = panel("term", { worktreeId: "wt-1", kind: "terminal" });
    const browser = panel("browser", { worktreeId: "wt-1", kind: "browser" });
    const devPreview = panel("dev", { worktreeId: "wt-1", kind: "dev-preview" });
    mockPanelIds = ["term", "browser", "dev"];
    mockPanelsById = { term, browser, dev: devPreview };

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(1);
    expect(fullWakeMock).toHaveBeenCalledWith("term");
  });

  it("treats undefined kind as terminal", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1", kind: undefined });
    mockPanelIds = ["a"];
    mockPanelsById = { a };

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(1);
    expect(fullWakeMock).toHaveBeenCalledWith("a");
  });

  it("when no active worktree, only wakes terminals with no worktree affiliation", async () => {
    mockActiveWorktreeId = null;
    const a = panel("a", { worktreeId: undefined });
    const b = panel("b", { worktreeId: "wt-1" });
    mockPanelIds = ["a", "b"];
    mockPanelsById = { a, b };

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(1);
    expect(fullWakeMock).toHaveBeenCalledWith("a");
  });

  it("no-ops when there are no panels", async () => {
    mockActiveWorktreeId = "wt-1";
    mockPanelIds = [];
    mockPanelsById = {};

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).not.toHaveBeenCalled();
  });

  it("skips panels missing from panelsById", async () => {
    mockActiveWorktreeId = "wt-1";
    mockPanelIds = ["ghost"];
    mockPanelsById = {};

    await expect(wakeActiveWorktreeTerminals()).resolves.toBeUndefined();
    expect(fullWakeMock).not.toHaveBeenCalled();
  });

  it("isolates per-terminal failures so the fan-out continues", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const b = panel("b", { worktreeId: "wt-1" });
    const c = panel("c", { worktreeId: "wt-1" });
    mockPanelIds = ["a", "b", "c"];
    mockPanelsById = { a, b, c };

    fullWakeMock.mockImplementation(async (id: string) => {
      if (id === "b") throw new Error("broken xterm");
    });

    await expect(wakeActiveWorktreeTerminals()).resolves.toBeUndefined();

    expect(fullWakeMock).toHaveBeenCalledTimes(3);
    expect(fullWakeMock).toHaveBeenCalledWith("a");
    expect(fullWakeMock).toHaveBeenCalledWith("b");
    expect(fullWakeMock).toHaveBeenCalledWith("c");
    expect(logWarnMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock).toHaveBeenCalledWith(
      "[wakeActiveWorktreeTerminals] wake failed",
      expect.objectContaining({ id: "b" })
    );
  });

  it("runs the focused panel before the rest", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const b = panel("b", { worktreeId: "wt-1" });
    const c = panel("c", { worktreeId: "wt-1" });
    mockPanelIds = ["a", "b", "c"];
    mockPanelsById = { a, b, c };

    // "c" is focused — must be invoked first
    isFocusedMock.mockImplementation((id: string) => id === "c");

    const callOrder: string[] = [];
    fullWakeMock.mockImplementation(async (id: string) => {
      callOrder.push(id);
    });

    await wakeActiveWorktreeTerminals();

    expect(callOrder[0]).toBe("c");
    expect(callOrder).toHaveLength(3);
  });

  it("caps concurrent wakes at 2 and actually runs them in parallel", async () => {
    mockActiveWorktreeId = "wt-1";
    const ids = ["a", "b", "c", "d", "e", "f"];
    mockPanelIds = ids;
    mockPanelsById = Object.fromEntries(
      ids.map((id) => [id, panel(id, { worktreeId: "wt-1" })])
    ) as Record<string, PanelInstance>;

    let inFlight = 0;
    let maxInFlight = 0;
    const deferreds = new Map<string, () => void>();

    fullWakeMock.mockImplementation((id: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<void>((resolve) => {
        deferreds.set(id, () => {
          inFlight--;
          resolve();
        });
      });
    });

    const done = wakeActiveWorktreeTerminals();

    // After the workers have spawned, the pool should have exactly 2 wakes
    // in-flight (proving fan-out, not just serial execution).
    await Promise.resolve();
    await Promise.resolve();
    expect(inFlight).toBe(2);

    let safety = 50;
    while (safety-- > 0) {
      await Promise.resolve();
      await Promise.resolve();
      if (deferreds.size === 0 && inFlight === 0) {
        break;
      }
      const toResolve = [...deferreds.values()];
      deferreds.clear();
      for (const r of toResolve) r();
    }

    await done;

    expect(fullWakeMock).toHaveBeenCalledTimes(6);
    expect(maxInFlight).toBe(2);
  });

  it("a hung focused-panel wake does not block the other panels", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const b = panel("b", { worktreeId: "wt-1" });
    const c = panel("c", { worktreeId: "wt-1" });
    mockPanelIds = ["a", "b", "c"];
    mockPanelsById = { a, b, c };

    // Focused panel "a" never resolves
    isFocusedMock.mockImplementation((id: string) => id === "a");

    let resolveB!: () => void;
    let resolveC!: () => void;
    fullWakeMock.mockImplementation((id: string) => {
      if (id === "a") return new Promise<void>(() => {}); // hangs forever
      if (id === "b") return new Promise<void>((r) => (resolveB = () => r()));
      if (id === "c") return new Promise<void>((r) => (resolveC = () => r()));
      return Promise.resolve();
    });

    const done = wakeActiveWorktreeTerminals();

    // After microtask flushes, the pool has started a + b (cap=2); c waits.
    await Promise.resolve();
    await Promise.resolve();
    expect(fullWakeMock).toHaveBeenCalledWith("a");
    expect(fullWakeMock).toHaveBeenCalledWith("b");

    // Resolve b → c starts. a is still hung.
    resolveB();
    await Promise.resolve();
    await Promise.resolve();
    expect(fullWakeMock).toHaveBeenCalledWith("c");

    resolveC();
    // done never resolves because a hangs — but b and c made progress.
    // Drop reference; vitest cleanup will handle the pending promise.
    void done;
  });

  // #9637 — the Daintree Assistant terminal is a `location: "dock"` panel but
  // is rendered persistently in HelpPanel, so it must be woken on project
  // return even though ordinary dock terminals are excluded.
  it("wakes the help-panel assistant terminal even though it is dock-located", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const assistant = panel("assistant", { worktreeId: "wt-1", location: "dock" });
    mockPanelIds = ["a", "assistant"];
    mockPanelsById = { a, assistant };
    mockHelpTerminalId = "assistant";

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(2);
    expect(fullWakeMock).toHaveBeenCalledWith("a");
    expect(fullWakeMock).toHaveBeenCalledWith("assistant");
  });

  it("still excludes dock terminals that are not the assistant terminal", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const assistant = panel("assistant", { worktreeId: "wt-1", location: "dock" });
    const otherDock = panel("other-dock", { worktreeId: "wt-1", location: "dock" });
    mockPanelIds = ["a", "assistant", "other-dock"];
    mockPanelsById = { a, assistant, "other-dock": otherDock };
    mockHelpTerminalId = "assistant";

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(2);
    expect(fullWakeMock).toHaveBeenCalledWith("a");
    expect(fullWakeMock).toHaveBeenCalledWith("assistant");
    expect(fullWakeMock).not.toHaveBeenCalledWith("other-dock");
  });

  it("ignores a stale assistant terminal id with no matching panel", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    mockPanelIds = ["a"];
    mockPanelsById = { a };
    mockHelpTerminalId = "gone";

    await expect(wakeActiveWorktreeTerminals()).resolves.toBeUndefined();
    expect(fullWakeMock).toHaveBeenCalledTimes(1);
    expect(fullWakeMock).toHaveBeenCalledWith("a");
    expect(fullWakeMock).not.toHaveBeenCalledWith("gone");
  });

  it("does not double-wake when the assistant id is already a grid target", async () => {
    mockActiveWorktreeId = "wt-1";
    // The assistant id resolves to a grid-located panel that the main loop
    // already picked up — the inclusion guard must not push it a second time.
    const assistant = panel("assistant", { worktreeId: "wt-1", location: "grid" });
    mockPanelIds = ["assistant"];
    mockPanelsById = { assistant };
    mockHelpTerminalId = "assistant";

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(1);
    expect(fullWakeMock).toHaveBeenCalledWith("assistant");
  });

  it("wakes the assistant terminal when it is the only terminal to wake", async () => {
    mockActiveWorktreeId = "wt-1";
    const assistant = panel("assistant", { worktreeId: "wt-1", location: "dock" });
    mockPanelIds = ["assistant"];
    mockPanelsById = { assistant };
    mockHelpTerminalId = "assistant";

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(1);
    expect(fullWakeMock).toHaveBeenCalledWith("assistant");
  });
});

describe("repaintActiveWorktreeTerminals (#10362)", () => {
  // Unique ids passed to revealTerminal, preserving first-seen order — the sweep
  // paints each paintable pane more than once (the confirm pass), so behavioural
  // assertions key off the set/ordering, not raw call counts.
  function revealedIds(): string[] {
    const seen: string[] = [];
    for (const call of revealTerminalMock.mock.calls) {
      const id = String(call[0]);
      if (!seen.includes(id)) seen.push(id);
    }
    return seen;
  }

  it("reveals every visible terminal in the active worktree", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const b = panel("b", { worktreeId: "wt-1" });
    mockPanelIds = ["a", "b"];
    mockPanelsById = { a, b };

    await repaintActiveWorktreeTerminals();

    expect(revealedIds().sort()).toEqual(["a", "b"]);
  });

  it("targets the same set as wake — folds in the assistant, excludes dock/other-worktree", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const assistant = panel("assistant", { worktreeId: "wt-1", location: "dock" });
    const otherDock = panel("other-dock", { worktreeId: "wt-1", location: "dock" });
    const otherWt = panel("z", { worktreeId: "wt-2" });
    mockPanelIds = ["a", "assistant", "other-dock", "z"];
    mockPanelsById = { a, assistant, "other-dock": otherDock, z: otherWt };
    mockHelpTerminalId = "assistant";

    await repaintActiveWorktreeTerminals();

    expect(revealedIds().sort()).toEqual(["a", "assistant"]);
    expect(revealTerminalMock).not.toHaveBeenCalledWith("other-dock");
    expect(revealTerminalMock).not.toHaveBeenCalledWith("z");
  });

  it("reveals the focused pane first", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const b = panel("b", { worktreeId: "wt-1" });
    const c = panel("c", { worktreeId: "wt-1" });
    mockPanelIds = ["a", "b", "c"];
    mockPanelsById = { a, b, c };
    isFocusedMock.mockImplementation((id: string) => id === "c");

    const callOrder: string[] = [];
    revealTerminalMock.mockImplementation((id: string) => {
      callOrder.push(id);
      return Promise.resolve(true);
    });

    await repaintActiveWorktreeTerminals();

    expect(callOrder[0]).toBe("c");
    expect(revealedIds().sort()).toEqual(["a", "b", "c"]);
  });

  it("reasserts the focused terminal's service focus before reveal so DOM-mode WebGL can pin it", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const b = panel("b", { worktreeId: "wt-1" });
    mockPanelIds = ["a", "b"];
    mockPanelsById = { a, b };
    mockFocusedId = "b";
    isFocusedMock.mockImplementation((id: string) => id === "b");

    const callOrder: string[] = [];
    setFocusedMock.mockImplementation((id: string, isFocused: boolean) => {
      callOrder.push(`focus:${id}:${isFocused}`);
    });
    revealTerminalMock.mockImplementation((id: string) => {
      callOrder.push(`reveal:${id}`);
      return Promise.resolve(true);
    });

    await repaintActiveWorktreeTerminals();

    expect(setFocusedMock).toHaveBeenCalledTimes(1);
    expect(setFocusedMock).toHaveBeenCalledWith("b", true);
    expect(callOrder[0]).toBe("focus:b:true");
    expect(callOrder[1]).toBe("reveal:b");
  });

  it("does not reassert service focus for a focused id outside the reveal target set", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const other = panel("other", { worktreeId: "wt-2" });
    mockPanelIds = ["a", "other"];
    mockPanelsById = { a, other };
    mockFocusedId = "other";

    await repaintActiveWorktreeTerminals();

    expect(setFocusedMock).not.toHaveBeenCalled();
    expect(revealedIds()).toEqual(["a"]);
  });

  it("retries a terminal that isn't paintable yet, then settles once it is", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    mockPanelIds = ["a"];
    mockPanelsById = { a };

    // Not paintable for the first two frames (layout still settling), then yes.
    revealTerminalMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    await repaintActiveWorktreeTerminals();

    // Two not-paintable attempts + the confirm pass means it kept trying past
    // the first paintable frame rather than giving up on the initial `false`.
    expect(revealTerminalMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(revealedIds()).toEqual(["a"]);
  });

  it("aborts the whole reveal sweep when the view is switched away (hidden) mid-sweep", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const b = panel("b", { worktreeId: "wt-1" });
    const c = panel("c", { worktreeId: "wt-1" });
    const d = panel("d", { worktreeId: "wt-1" });
    mockPanelIds = ["a", "b", "c", "d"];
    mockPanelsById = { a, b, c, d };

    let visibility: "visible" | "hidden" = "visible";
    let visibilityHandler: (() => void) | null = null;
    vi.stubGlobal("document", {
      get visibilityState() {
        return visibility;
      },
      addEventListener: (evt: string, h: () => void) => {
        if (evt === "visibilitychange") visibilityHandler = h;
      },
      removeEventListener: () => {},
    });
    // rAF fires synchronously; the timeout fallback is a no-op for this test.
    vi.stubGlobal("requestAnimationFrame", (cb: (time: number) => void) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("setTimeout", () => 1);

    revealTerminalMock.mockImplementation((id: string) => {
      // The project is switched away during the first terminal's first attempt.
      if (id === "a") {
        visibility = "hidden";
        visibilityHandler?.();
      }
      return Promise.resolve(false); // never paintable → would otherwise retry
    });

    await repaintActiveWorktreeTerminals();

    // The hidden event latches sweep-wide: the next worker sees it before taking
    // another target, so the rest of the grid ("b"/"c"/"d") is skipped entirely
    // rather than each getting one hidden reveal.
    expect(revealedIds()).toEqual(["a"]);

    vi.unstubAllGlobals();
  });

  it("does not hang the sweep when requestAnimationFrame never fires (paused view)", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    mockPanelIds = ["a"];
    mockPanelsById = { a };

    // Paused rAF: registered but its callback is never invoked (backgrounded
    // WebContentsView). Without the timeout fallback the worker would hang here.
    vi.stubGlobal("requestAnimationFrame", () => 1);
    // The timeout fallback (fired synchronously for the test) unblocks the frame.
    vi.stubGlobal("setTimeout", (cb: () => void) => {
      cb();
      return 1;
    });
    revealTerminalMock.mockResolvedValue(true);

    await expect(repaintActiveWorktreeTerminals()).resolves.toBeUndefined();
    expect(revealTerminalMock).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("isolates a per-terminal reveal rejection so the sweep continues", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const b = panel("b", { worktreeId: "wt-1" });
    const c = panel("c", { worktreeId: "wt-1" });
    mockPanelIds = ["a", "b", "c"];
    mockPanelsById = { a, b, c };

    revealTerminalMock.mockImplementation((id: string) =>
      id === "b" ? Promise.reject(new Error("broken xterm")) : Promise.resolve(true)
    );

    await expect(repaintActiveWorktreeTerminals()).resolves.toBeUndefined();

    expect(revealedIds().sort()).toEqual(["a", "b", "c"]);
    expect(logWarnMock).toHaveBeenCalledWith(
      "[repaintActiveWorktreeTerminals] reveal failed",
      expect.objectContaining({ id: "b" })
    );
  });

  it("no-ops with zero targets and never touches the warm gate", async () => {
    mockActiveWorktreeId = "wt-1";
    mockPanelIds = [];
    mockPanelsById = {};

    await repaintActiveWorktreeTerminals();

    expect(revealTerminalMock).not.toHaveBeenCalled();
    // Reveal is a pure render pass — it must not re-fire the warm reactivation
    // gate (that's the wake fan-out's job).
    expect(notifyWarmReactivationCompleteMock).not.toHaveBeenCalled();
  });
});
