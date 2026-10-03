// @vitest-environment jsdom
/**
 * The triage panel mounts a second composer for a terminal that may also be
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

import { HybridInputBar } from "../HybridInputBar";

const WT_ID = "/repo/wt";

beforeEach(() => {
  registry.register.mockClear();
  registry.unregister.mockClear();
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

afterEach(cleanup);

function mount(isolated: boolean) {
  return render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar
          terminalId="term-1"
          cwd={WT_ID}
          agentId="claude"
          onSend={() => {}}
          isolated={isolated}
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

  it("leaves the pane's controller alone from the triage panel", async () => {
    const view = mount(true);
    await act(async () => {});
    view.unmount();
    expect(registry.register).not.toHaveBeenCalled();
    expect(registry.unregister).not.toHaveBeenCalled();
  });
});
