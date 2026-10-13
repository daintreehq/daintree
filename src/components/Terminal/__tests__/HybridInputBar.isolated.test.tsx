// @vitest-environment jsdom
/**
 * The canopy panel mounts a second composer for a terminal that may also be
 * open in its own pane. That one must leave the pane's input controller alone:
 * registering would replace it, and unmounting would remove it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
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
import { routeDropToComposer } from "../uploads/composerRouting";

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

describe("HybridInputBar isolated", () => {
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
      expect(routeDropToComposer("term-1", DROPPED)).toBe(true);
      expect(insertFileAttachments).toHaveBeenCalledTimes(1);
      pane.unmount();
      expect(routeDropToComposer("term-1", DROPPED)).toBe(false);
    }
  );

  it("declines a drop it has nothing to insert for", async () => {
    mount(false);
    await act(async () => {});
    expect(routeDropToComposer("term-1", [])).toBe(false);
    expect(insertFileAttachments).not.toHaveBeenCalled();
  });

  it("declines a drop while disabled, so the terminal takes it", async () => {
    const view = mount(false, true);
    await act(async () => {});
    expect(routeDropToComposer("term-1", DROPPED)).toBe(false);
    expect(insertFileAttachments).not.toHaveBeenCalled();

    view.rerender(
      <TooltipProvider>
        <WorktreeStoreContext.Provider value={createWorktreeStore()}>
          <HybridInputBar terminalId="term-1" cwd={WT_ID} agentId="claude" onSend={() => {}} />
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    );
    await act(async () => {});
    expect(routeDropToComposer("term-1", DROPPED)).toBe(true);
  });

  it("leaves the pane's controller alone from the canopy panel", async () => {
    const view = mount(true);
    await act(async () => {});
    view.unmount();
    expect(registry.register).not.toHaveBeenCalled();
    expect(registry.unregister).not.toHaveBeenCalled();
  });
});
