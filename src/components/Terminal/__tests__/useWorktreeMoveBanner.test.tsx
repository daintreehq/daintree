// @vitest-environment jsdom
/**
 * The banner's state has to survive a worktree switch unmounting and remounting
 * the pane — that is why it lives in the panel store rather than in
 * `TerminalPane` (#11853, same reasoning as #11589). These tests drive both
 * outcomes through a real store-connected render and then remount.
 *
 * They also pin #11867's contract: the bar is cleared when the terminal *took*
 * the text, not when a scheduler accepted a job, and every other outcome leaves
 * the bar up saying so.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { isPtyPanel, type PanelInstance, type PtyPanelData } from "@shared/types/panel";
import type { HybridInputBarHandle } from "../HybridInputBar";
import type { WorktreeMoveDeliveryRoute } from "../useWorktreeMoveBanner";

const mockDispatch = vi.fn();

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => mockDispatch(...args) },
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
  },
  agentSettingsClient: { get: vi.fn().mockResolvedValue({}) },
  systemClient: { getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }) },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
  },
}));

const worktrees = new Map<string, { id: string; path: string }>();
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: { worktrees: typeof worktrees }) => unknown) =>
    selector({ worktrees }),
}));
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStoreOrNull: () => ({ getState: () => ({ worktrees }) }),
}));

vi.mock("../../../store/slices/panelRegistry/persistence", async () => {
  const actual = await vi.importActual<
    typeof import("../../../store/slices/panelRegistry/persistence")
  >("../../../store/slices/panelRegistry/persistence");
  return { ...actual, saveNormalized: vi.fn() };
});

const { usePanelStore } = await import("@/store/panelStore");
const { useWorktreeMoveBanner, resolveWorktreeMoveRoute } =
  await import("../useWorktreeMoveBanner");

function panel(id: string, overrides: Partial<PtyPanelData> = {}): PanelInstance {
  return {
    id,
    kind: "terminal",
    title: id,
    cwd: "/repo",
    cols: 80,
    rows: 24,
    location: "grid",
    ...overrides,
  } as PanelInstance;
}

function seed(...panels: PanelInstance[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
  });
}

function ptyOf(id: string): PtyPanelData | undefined {
  const p = usePanelStore.getState().panelsById[id];
  return p && isPtyPanel(p) ? p : undefined;
}

function noticeOf(id: string): string | undefined {
  return ptyOf(id)?.worktreeMoveNotice?.destinationWorktreeId;
}

const NOTICE = { worktreeMoveNotice: { destinationWorktreeId: "wt-b" } };

/** A stand-in for the mounted bar. `submit` is the hook's own guarded callback. */
function stubBar(behaviour: (submit: (text: string) => Promise<boolean>) => Promise<boolean>) {
  const submitWithInstruction = vi.fn(
    async (_instruction: string, submit: (text: string) => Promise<boolean>) => behaviour(submit)
  );
  const ref = createRef<HybridInputBarHandle>() as RefObject<HybridInputBarHandle | null>;
  ref.current = {
    focus: vi.fn(),
    focusWithCursorAtEnd: vi.fn().mockReturnValue(true),
    cancelPendingFocus: vi.fn(),
    submitWithInstruction,
  };
  return { ref, submitWithInstruction };
}

/** A bar that just forwards the composed text, the way the real one does. */
const forwardingBar = (draft = "") =>
  stubBar(async (submit) => submit(draft ? `${draft}\n\nINSTRUCTION` : "INSTRUCTION"));

const nullBarRef = { current: null } as RefObject<HybridInputBarHandle | null>;

function render(
  panelId: string,
  route: WorktreeMoveDeliveryRoute,
  inputBarRef: RefObject<HybridInputBarHandle | null> = nullBarRef
) {
  return renderHook(() => useWorktreeMoveBanner(panelId, { route, inputBarRef }));
}

/** Every `tell` is async now; settle it inside `act` so store writes are seen. */
async function tell(result: { current: { tell: () => Promise<void> } }) {
  await act(async () => {
    await result.current.tell();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDispatch.mockResolvedValue({ ok: true, result: { sent: true } });
  worktrees.clear();
  worktrees.set("wt-b", { id: "wt-b", path: "/repo/wt-b" });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
});

describe("resolveWorktreeMoveRoute", () => {
  const route = (over: Partial<Parameters<typeof resolveWorktreeMoveRoute>[0]> = {}) =>
    resolveWorktreeMoveRoute({
      isHybridInputDisabled: false,
      hasHybridInputBar: true,
      isFleetComposing: false,
      ...over,
    });

  it("refuses to pick a delivery route while the pane cannot take input", () => {
    // Whatever else is true, a locked / recovering / restarting pane is blocked.
    for (const over of [{ hasHybridInputBar: true }, { hasHybridInputBar: false }]) {
      expect(route({ ...over, isHybridInputDisabled: true })).toBe("blocked");
      expect(route({ ...over, isHybridInputDisabled: true, isFleetComposing: true })).toBe(
        "blocked"
      );
    }
  });

  it("uses the bar only when one is actually rendered", () => {
    expect(route({ hasHybridInputBar: true })).toBe("hybrid");
    expect(route({ hasHybridInputBar: false })).toBe("direct");
  });

  it("leaves a fleet's shared draft alone", () => {
    // Submitting it would mirror the cleared value into every armed pane.
    expect(route({ hasHybridInputBar: true, isFleetComposing: true })).toBe("direct");
  });
});

describe("useWorktreeMoveBanner", () => {
  it("is hidden for a pane with no pending move", () => {
    seed(panel("t-1"));
    expect(render("t-1", "direct").result.current.visible).toBe(false);
  });

  it("is hidden for an unknown or non-PTY pane", () => {
    seed({ id: "b-1", kind: "browser", title: "b-1", location: "grid" } as PanelInstance);
    expect(render("nope", "direct").result.current.visible).toBe(false);
    expect(render("b-1", "direct").result.current.visible).toBe(false);
  });

  it("shows the destination's current path", () => {
    seed(panel("t-1", NOTICE));
    const { result } = render("t-1", "direct");

    expect(result.current.visible).toBe(true);
    expect(result.current.destinationPath).toBe("/repo/wt-b");
  });

  it("stays visible with no path when the destination worktree is gone", () => {
    // No fallback path: guessing one is how a destructive default ships (#7880).
    seed(panel("t-1", NOTICE));
    worktrees.clear();
    const { result } = render("t-1", "direct");

    expect(result.current.visible).toBe(true);
    expect(result.current.destinationPath).toBeUndefined();
  });

  describe("direct route", () => {
    it("submits through the action layer with no agent-state gate", async () => {
      seed(panel("t-1", NOTICE));
      const { result } = render("t-1", "direct");

      await tell(result);

      expect(mockDispatch).toHaveBeenCalledTimes(1);
      const [actionId, args] = mockDispatch.mock.calls[0]!;
      expect(actionId).toBe("terminal.sendCommand");
      expect(args).toMatchObject({ terminalId: "t-1" });
      expect((args as { command: string }).command).toContain("/repo/wt-b");
      expect(noticeOf("t-1")).toBeUndefined();
    });

    it("sends only the instruction, never a draft it cannot see", async () => {
      seed(panel("t-1", NOTICE));
      const { result } = render("t-1", "direct");

      await tell(result);

      const { command } = mockDispatch.mock.calls[0]![1] as { command: string };
      expect(command.includes("\n")).toBe(false);
    });
  });

  describe("hybrid route", () => {
    it("delegates to the mounted bar and dispatches what the bar composed", async () => {
      seed(panel("t-1", NOTICE));
      const { ref, submitWithInstruction } = forwardingBar("look at this");
      const { result } = render("t-1", "hybrid", ref);

      await tell(result);

      expect(submitWithInstruction).toHaveBeenCalledTimes(1);
      expect(submitWithInstruction.mock.calls[0]![0]).toContain("/repo/wt-b");
      // Exactly one: delegating to the bar and *then* dispatching directly
      // would put the sentence in front of the agent twice.
      expect(mockDispatch).toHaveBeenCalledTimes(1);
      const { command } = mockDispatch.mock.calls[0]![1] as { command: string };
      expect(command).toContain("look at this");
      expect(noticeOf("t-1")).toBeUndefined();
    });

    it("keeps the bar up and does not fall through when the editor is not mounted", async () => {
      // A second send could duplicate the sentence; one more click cannot.
      seed(panel("t-1", NOTICE));
      const { result } = render("t-1", "hybrid", nullBarRef);

      await tell(result);

      expect(mockDispatch).not.toHaveBeenCalled();
      expect(noticeOf("t-1")).toBe("wt-b");
      expect(ptyOf("t-1")?.worktreeMoveNotice?.deliveryFailed).toBe(true);
    });

    it("does not fall through when the bar refuses the send", async () => {
      seed(panel("t-1", NOTICE));
      const { ref } = stubBar(async () => false);
      const { result } = render("t-1", "hybrid", ref);

      await tell(result);

      expect(mockDispatch).not.toHaveBeenCalled();
      expect(ptyOf("t-1")?.worktreeMoveNotice?.deliveryFailed).toBe(true);
    });
  });

  describe("blocked route", () => {
    it("submits nothing while the pane cannot take input, and says so", async () => {
      // Backend recovery, a restart or an input lock: submitting behind any of
      // them is exactly the silent loss #11867 exists to end.
      seed(panel("t-1", NOTICE));
      const { ref } = forwardingBar();
      const { result } = render("t-1", "blocked", ref);

      await tell(result);

      expect(mockDispatch).not.toHaveBeenCalled();
      expect(noticeOf("t-1")).toBe("wt-b");
      expect(result.current.deliveryFailed).toBe(true);
    });
  });

  describe("delivery failure", () => {
    it("keeps the bar up and marks it when the terminal rejects the text", async () => {
      mockDispatch.mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", message: "gone" } });
      seed(panel("t-1", NOTICE));
      const { result } = render("t-1", "direct");

      await tell(result);

      expect(noticeOf("t-1")).toBe("wt-b");
      expect(result.current.deliveryFailed).toBe(true);
    });

    it("clears the bar when a retry finally lands", async () => {
      mockDispatch.mockResolvedValueOnce({ ok: false, error: { code: "X", message: "no" } });
      seed(panel("t-1", NOTICE));
      const { result } = render("t-1", "direct");

      await tell(result);
      expect(result.current.deliveryFailed).toBe(true);

      await tell(result);

      expect(noticeOf("t-1")).toBeUndefined();
      expect(mockDispatch).toHaveBeenCalledTimes(2);
    });

    it("survives an unmount and remount, and stays on its own pane", async () => {
      mockDispatch.mockResolvedValue({ ok: false, error: { code: "X", message: "no" } });
      seed(panel("t-1", NOTICE), panel("t-2", NOTICE));
      const first = render("t-1", "direct");

      await tell(first.result);
      first.unmount();

      expect(render("t-1", "direct").result.current.deliveryFailed).toBe(true);
      expect(render("t-2", "direct").result.current.deliveryFailed).toBe(false);
    });
  });

  describe("staleness", () => {
    it("resolves the destination path at click time, not at render time", async () => {
      seed(panel("t-1", NOTICE));
      const { result } = render("t-1", "direct");
      worktrees.set("wt-b", { id: "wt-b", path: "/repo/moved-since" });

      await tell(result);

      const { command } = mockDispatch.mock.calls[0]![1] as { command: string };
      expect(command).toContain("/repo/moved-since");
      expect(command).not.toContain("/repo/wt-b");
    });

    it("aborts before dispatching when the destination moves mid-send", async () => {
      // The bar's own token resolution is a round trip; the world can change.
      seed(panel("t-1", NOTICE));
      const { ref } = stubBar(async (submit) => {
        worktrees.set("wt-b", { id: "wt-b", path: "/repo/somewhere-else" });
        return submit("INSTRUCTION");
      });
      const { result } = render("t-1", "hybrid", ref);

      await tell(result);

      expect(mockDispatch).not.toHaveBeenCalled();
      expect(noticeOf("t-1")).toBe("wt-b");
    });

    it("aborts before dispatching when the notice is answered mid-send", async () => {
      seed(panel("t-1", NOTICE));
      const { ref } = stubBar(async (submit) => {
        usePanelStore.getState().setWorktreeMoveNotice("t-1", undefined);
        return submit("INSTRUCTION");
      });
      const { result } = render("t-1", "hybrid", ref);

      await tell(result);

      expect(mockDispatch).not.toHaveBeenCalled();
      expect(noticeOf("t-1")).toBeUndefined();
    });

    it("does not answer a newer notice raised for the same destination", async () => {
      // Identity, not destination id: a move away and back leaves the same id
      // on a notice this attempt was never allowed to speak for.
      let resolveDispatch!: (v: unknown) => void;
      mockDispatch.mockReturnValue(
        new Promise((resolve) => {
          resolveDispatch = resolve;
        })
      );
      seed(panel("t-1", NOTICE));
      const { result } = render("t-1", "direct");

      let pending!: Promise<void>;
      act(() => {
        pending = result.current.tell();
      });
      act(() => {
        const store = usePanelStore.getState();
        store.setWorktreeMoveNotice("t-1", undefined);
        store.setWorktreeMoveNotice("t-1", { destinationWorktreeId: "wt-b" });
      });
      await act(async () => {
        resolveDispatch({ ok: true, result: { sent: true } });
        await pending;
      });

      expect(noticeOf("t-1")).toBe("wt-b");
    });

    it("dispatches once when the button is clicked twice", async () => {
      let resolveDispatch!: (v: unknown) => void;
      mockDispatch.mockReturnValue(
        new Promise((resolve) => {
          resolveDispatch = resolve;
        })
      );
      seed(panel("t-1", NOTICE));
      const { result } = render("t-1", "direct");

      let first!: Promise<void>;
      let second!: Promise<void>;
      act(() => {
        first = result.current.tell();
        second = result.current.tell();
      });
      await act(async () => {
        resolveDispatch({ ok: true, result: { sent: true } });
        await Promise.all([first, second]);
      });

      expect(mockDispatch).toHaveBeenCalledTimes(1);
    });

    it("answers the notice that is current at click time, not at render time", async () => {
      seed(panel("t-1", NOTICE));
      const { result } = render("t-1", "direct");
      worktrees.set("wt-c", { id: "wt-c", path: "/repo/wt-c" });
      act(() => {
        usePanelStore.getState().setWorktreeMoveNotice("t-1", { destinationWorktreeId: "wt-c" });
      });

      await tell(result);

      const { command } = mockDispatch.mock.calls[0]![1] as { command: string };
      expect(command).toContain("/repo/wt-c");
      expect(noticeOf("t-1")).toBeUndefined();
    });

    it("does not dispatch for a notice replaced before the send begins", async () => {
      // Identity, not destination id: a same-destination replacement is still a
      // different question from the one this click answered.
      seed(panel("t-1", NOTICE));
      const { ref } = stubBar(async (submit) => {
        const store = usePanelStore.getState();
        store.setWorktreeMoveNotice("t-1", undefined);
        store.setWorktreeMoveNotice("t-1", { destinationWorktreeId: "wt-b" });
        return submit("INSTRUCTION");
      });
      const { result } = render("t-1", "hybrid", ref);

      await tell(result);

      expect(mockDispatch).not.toHaveBeenCalled();
      expect(noticeOf("t-1")).toBe("wt-b");
    });

    it("says so rather than sending to a path that moved mid-send", async () => {
      seed(panel("t-1", NOTICE));
      const { ref } = stubBar(async (submit) => {
        worktrees.set("wt-b", { id: "wt-b", path: "/repo/elsewhere" });
        return submit("INSTRUCTION");
      });
      const { result } = render("t-1", "hybrid", ref);

      await tell(result);

      expect(mockDispatch).not.toHaveBeenCalled();
      expect(ptyOf("t-1")?.worktreeMoveNotice?.deliveryFailed).toBe(true);
    });

    it("refuses to submit once the pane has been blocked mid-send", async () => {
      // Resolving `@diff` is a round trip; a lock or a restart can land inside
      // it, and the route decided at click time must not outlive that. The bar
      // is parked mid-resolution here, the pane re-renders blocked, and only
      // then does the submit get its chance.
      seed(panel("t-1", NOTICE));
      let release!: () => void;
      const parked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { ref } = stubBar(async (submit) => {
        await parked;
        return submit("INSTRUCTION");
      });
      let route: WorktreeMoveDeliveryRoute = "hybrid";
      const hook = renderHook(() => useWorktreeMoveBanner("t-1", { route, inputBarRef: ref }));

      let pending!: Promise<void>;
      act(() => {
        pending = hook.result.current.tell();
      });

      route = "blocked";
      hook.rerender();

      await act(async () => {
        release();
        await pending;
      });

      expect(mockDispatch).not.toHaveBeenCalled();
      expect(noticeOf("t-1")).toBe("wt-b");
    });

    it("refuses once the pane has joined a fleet mid-send", async () => {
      // Committing now would clear a draft that has become the fleet's, and
      // `useFleetMirror` would push the empty value into every armed pane.
      seed(panel("t-1", NOTICE));
      let release!: () => void;
      const parked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { ref } = stubBar(async (submit) => {
        await parked;
        return submit("INSTRUCTION");
      });
      let route: WorktreeMoveDeliveryRoute = "hybrid";
      const hook = renderHook(() => useWorktreeMoveBanner("t-1", { route, inputBarRef: ref }));

      let pending!: Promise<void>;
      act(() => {
        pending = hook.result.current.tell();
      });

      route = "direct";
      hook.rerender();

      await act(async () => {
        release();
        await pending;
      });

      expect(mockDispatch).not.toHaveBeenCalled();
      expect(noticeOf("t-1")).toBe("wt-b");
    });

    it("sends nothing when the destination vanished between render and click", async () => {
      seed(panel("t-1", NOTICE));
      const { result } = render("t-1", "direct");
      worktrees.clear();

      await tell(result);

      expect(mockDispatch).not.toHaveBeenCalled();
      expect(noticeOf("t-1")).toBe("wt-b");
    });
  });

  // The bug itself (#11867): the bar used to go the moment a job was accepted,
  // long before anything reached the terminal.
  it("keeps the bar up for the whole send, and drops it only once it lands", async () => {
    let resolveDispatch!: (v: unknown) => void;
    mockDispatch.mockReturnValue(
      new Promise((resolve) => {
        resolveDispatch = resolve;
      })
    );
    seed(panel("t-1", NOTICE));
    const { result } = render("t-1", "direct");
    const before = ptyOf("t-1")?.worktreeMoveNotice;

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.tell();
    });

    expect(result.current.visible).toBe(true);
    expect(ptyOf("t-1")?.worktreeMoveNotice).toBe(before);

    await act(async () => {
      resolveDispatch({ ok: true, result: { sent: true } });
      await pending;
    });

    expect(noticeOf("t-1")).toBeUndefined();
  });

  it("hides the bar on dismiss without sending anything", () => {
    seed(panel("t-1", NOTICE));
    const { result } = render("t-1", "direct");

    act(() => result.current.dismiss());

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(noticeOf("t-1")).toBeUndefined();
  });

  it("leaves nothing on the panel after a delivered tell", async () => {
    // Compliance is undetectable, so any surviving marker would sit lit forever
    // on total success. Both outcomes consume the same field.
    seed(panel("t-1", NOTICE));
    const { result } = render("t-1", "direct");

    await tell(result);

    expect(ptyOf("t-1")?.worktreeMoveNotice).toBeUndefined();
  });

  // The bug this shape exists to prevent: a worktree switch does exactly this.
  it("keeps the answer across an unmount and remount", () => {
    seed(panel("t-1", NOTICE));

    const first = render("t-1", "direct");
    expect(first.result.current.visible).toBe(true);
    act(() => first.result.current.dismiss());
    first.unmount();

    expect(render("t-1", "direct").result.current.visible).toBe(false);
  });

  it("keeps an unanswered bar across an unmount and remount", () => {
    seed(panel("t-1", NOTICE));
    render("t-1", "direct").unmount();

    const second = render("t-1", "direct");
    expect(second.result.current.visible).toBe(true);
    expect(second.result.current.destinationPath).toBe("/repo/wt-b");
  });

  it("answers each pane of a moved group independently", async () => {
    seed(panel("t-1", NOTICE), panel("t-2", NOTICE));
    const first = render("t-1", "direct");

    await tell(first.result);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(noticeOf("t-1")).toBeUndefined();
    expect(noticeOf("t-2")).toBe("wt-b");
  });
});
