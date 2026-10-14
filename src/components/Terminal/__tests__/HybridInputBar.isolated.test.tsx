// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { act, cleanup, render } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import {
  createWorktreeStore,
  setCurrentViewStore,
  type WorktreeViewStoreApi,
} from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { initBuiltInPanelKinds } from "@/panels/registry";

const registry = vi.hoisted(() => ({ register: vi.fn(), unregister: vi.fn() }));
vi.mock("@/store/terminalInputStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/terminalInputStore")>();
  return {
    ...actual,
    registerInputController: registry.register,
    unregisterInputController: registry.unregister,
  };
});

// The composer's own insertion has its suite; here only whether it takes the drop matters.
const insertFileAttachments = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../fileAttachments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fileAttachments")>();
  return { ...actual, insertFileAttachments };
});

import { HybridInputBar } from "../HybridInputBar";
import {
  _resetPaneDropRoutingForTests,
  registerPaneDropTarget,
  resolvePaneDropTarget,
  routePaneDrop,
} from "../uploads/paneDropRouting";

/**
 * The canopy panel mounts a second composer for a terminal that may also be
 * open in its own pane. That one must leave the pane's input controller alone:
 * registering would replace it, and unmounting would remove it.
 */
describe("HybridInputBar isolated", () => {
  const WT_ID = "/repo/wt";
  const DROPPED = [{ kind: "local", path: "/Users/me/a.md", name: "a.md", size: 0 }] as const;

  beforeEach(() => {
    registry.register.mockClear();
    registry.unregister.mockClear();
    insertFileAttachments.mockClear();
    initBuiltInPanelKinds();
    const store = createWorktreeStore();
    setCurrentViewStore(store);
    const panel = {
      id: "term-1",
      title: "claude",
      kind: "terminal",
      cwd: WT_ID,
      cols: 120,
      rows: 40,
      worktreeId: WT_ID,
      location: "grid",
      hasPty: true,
      detectedAgentId: "claude",
      launchAgentId: "claude",
      agentState: "waiting",
      runtimeStatus: "running",
    } as PtyPanelData;
    usePanelStore.setState({
      panelsById: { [panel.id]: panel },
      panelIds: [panel.id],
      panelIdsByWorktreeId: { [WT_ID]: [panel.id] },
      focusedId: panel.id,
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  });

  function mount(isolated: boolean, disabled = false) {
    return render(
      <TooltipProvider>
        <WorktreeStoreContext.Provider value={createWorktreeStore()}>
          <HybridInputBar
            terminalId="term-1"
            cwd={WT_ID}
            agentId="claude"
            onSend={() => {}}
            isolated={isolated}
            disabled={disabled}
          />
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    );
  }

  it("registers the terminal's input controller from its own pane", async () => {
    const view = mount(false);
    await act(async () => {});
    expect(registry.register).toHaveBeenCalledWith("term-1", expect.anything());
    view.unmount();
    expect(registry.unregister).toHaveBeenCalledWith("term-1");
  });

  it.each([
    ["local", false],
    ["remote", true],
  ])(
    "leaves a %s pane's drops with its own composer while the canopy panel opens and closes",
    async (_, remote) => {
      if (remote) window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
      const pane = mount(false);
      await act(async () => {});
      const canopy = mount(true);
      await act(async () => {});
      canopy.unmount();
      expect(routePaneDrop("term-1", "hybridInput", DROPPED)).toBe(true);
      expect(insertFileAttachments).toHaveBeenCalledTimes(1);
      pane.unmount();
      expect(routePaneDrop("term-1", "hybridInput", DROPPED)).toBe(false);
    }
  );

  it("declines a drop it has nothing to insert for", async () => {
    mount(false);
    await act(async () => {});
    expect(routePaneDrop("term-1", "hybridInput", [])).toBe(false);
    expect(insertFileAttachments).not.toHaveBeenCalled();
  });

  it("declines a drop while disabled, so the terminal takes it", async () => {
    const view = mount(false, true);
    await act(async () => {});
    expect(routePaneDrop("term-1", "hybridInput", DROPPED)).toBe(false);
    expect(insertFileAttachments).not.toHaveBeenCalled();

    view.rerender(
      <TooltipProvider>
        <WorktreeStoreContext.Provider value={createWorktreeStore()}>
          <HybridInputBar terminalId="term-1" cwd={WT_ID} agentId="claude" onSend={() => {}} />
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    );
    await act(async () => {});
    expect(routePaneDrop("term-1", "hybridInput", DROPPED)).toBe(true);
  });

  describe("as the terminal's partner in the pane's drops", () => {
    // A bar in the focused pane claims the keyboard a frame after mounting; these
    // tests start with nothing holding it, so that frame can't race their checks.
    beforeEach(() => {
      usePanelStore.setState({ focusedId: null });
    });

    afterEach(() => {
      act(() => _resetPaneDropRoutingForTests());
    });

    function registerTerminal() {
      registerPaneDropTarget("term-1", "xterm", {
        ownsFocus: () => false,
        canTake: () => true,
        take: () => true,
      });
    }

    it("claims the drop while its editor holds the keyboard, even with the window blurred", async () => {
      const view = mount(false);
      await act(async () => {});
      registerTerminal();
      expect(resolvePaneDropTarget("term-1", "xterm")).toBe("xterm");

      const editor = view.container.querySelector<HTMLElement>(".cm-content");
      editor!.focus();
      expect(document.activeElement).toBe(editor);
      const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
      try {
        expect(resolvePaneDropTarget("term-1", "xterm")).toBe("hybridInput");
      } finally {
        hasFocus.mockRestore();
      }
      view.unmount();
    });

    it("takes a click's drop only while it can take one", async () => {
      registerTerminal();
      const enabled = mount(false);
      await act(async () => {});
      expect(resolvePaneDropTarget("term-1", "xterm", "hybridInput")).toBe("hybridInput");
      enabled.unmount();

      mount(false, true);
      await act(async () => {});
      expect(resolvePaneDropTarget("term-1", "xterm", "hybridInput")).toBe("xterm");
    });
  });

  it("leaves the pane's controller alone from the canopy panel", async () => {
    const view = mount(true);
    await act(async () => {});
    view.unmount();
    expect(registry.register).not.toHaveBeenCalled();
    expect(registry.unregister).not.toHaveBeenCalled();
  });
});

/**
 * While an agent edits files, its own worktree's snapshot is replaced on every
 * git-status pass (modifiedCount, lastActivityTimestamp, ...). The composer only
 * draws the worktree's label, so that churn must not re-render it — it lands
 * exactly while the user is typing. Mounts the real HybridInputBar and counts
 * Profiler commits. Prints metrics with COMPOSER_WORKTREE_BENCH=1.
 */
describe("HybridInputBar under its worktree's git-status churn", () => {
  const UPDATES = 100;
  const WT_ID = "/repo/wt-feature";

  const stats = { commits: 0, ms: 0 };
  const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
    stats.commits++;
    stats.ms += actualDuration;
  };

  let worktreeStore: WorktreeViewStoreApi;

  function snapshot(overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
    return {
      id: WT_ID,
      worktreeId: WT_ID,
      path: WT_ID,
      name: "wt-feature",
      branch: "feature/composer",
      isCurrent: false,
      isMainWorktree: false,
      modifiedCount: 0,
      lastActivityTimestamp: 0,
      ...overrides,
    } as WorktreeSnapshot;
  }

  function setSnapshot(next: WorktreeSnapshot) {
    worktreeStore.setState((s) => {
      const worktrees = new Map(s.worktrees);
      worktrees.set(WT_ID, next);
      return { worktrees };
    });
  }

  beforeEach(async () => {
    initBuiltInPanelKinds();
    worktreeStore = createWorktreeStore();
    worktreeStore.setState({ worktrees: new Map([[WT_ID, snapshot()]]) });
    setCurrentViewStore(worktreeStore);
    const panel = {
      id: "term-1",
      title: "claude",
      kind: "terminal",
      cwd: WT_ID,
      cols: 120,
      rows: 40,
      worktreeId: WT_ID,
      location: "grid",
      hasPty: true,
      detectedAgentId: "claude",
      launchAgentId: "claude",
      agentState: "working",
      runtimeStatus: "running",
    } as PtyPanelData;
    usePanelStore.setState({
      panelsById: { [panel.id]: panel },
      panelIds: [panel.id],
      panelIdsByWorktreeId: { [WT_ID]: [panel.id] },
      focusedId: null,
    });

    render(
      <TooltipProvider>
        <WorktreeStoreContext.Provider value={worktreeStore}>
          <Profiler id="composer" onRender={onRender}>
            <HybridInputBar terminalId="term-1" cwd={WT_ID} agentId="claude" onSend={() => {}} />
          </Profiler>
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    );
    // Lets the previous describe's trailing store reactions land before counting.
    await settle(100);
    stats.commits = 0;
    stats.ms = 0;
  });

  afterEach(cleanup);

  async function settle(ms = 0): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }

  it("does not re-render when only unrelated snapshot fields change", async () => {
    const start = performance.now();
    for (let i = 1; i <= UPDATES; i++) {
      act(() => {
        setSnapshot(snapshot({ modifiedCount: i, lastActivityTimestamp: 1_000 + i }));
      });
    }
    const wallMs = performance.now() - start;
    await settle();

    if (process.env.COMPOSER_WORKTREE_BENCH) {
      process.stderr.write(
        `[composer-worktree-bench] updates=${UPDATES} commits=${stats.commits} ` +
          `renderMs=${stats.ms.toFixed(2)} wallMs=${wallMs.toFixed(2)}\n`
      );
    }
    expect(stats.commits).toBe(0);
  });

  // Proves the Profiler sees real renders, so the zero above is not vacuous.
  it("still re-renders when the drawn branch label changes", async () => {
    act(() => {
      setSnapshot(snapshot({ branch: "feature/renamed" }));
    });
    await settle();
    expect(stats.commits).toBeGreaterThan(0);
  });
});
