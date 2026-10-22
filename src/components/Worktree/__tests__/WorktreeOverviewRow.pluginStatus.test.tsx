/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorktreeState } from "@shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import {
  _resetPluginWorktreeCardStatusStoreForTest,
  usePluginWorktreeCardStatusStore,
} from "@/store/pluginWorktreeCardStatusStore";
import { publishRegisteredPluginActions } from "@/services/plugin/registeredPluginActions";
import { consumeDeferredPaletteFocusRestore } from "@/components/ui/paletteFocusRestore";
import { WorktreeOverviewRow } from "../WorktreeOverviewRow";

const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn() }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

const WT = "/repo-wt-1";

const worktree = {
  id: WT,
  worktreeId: WT,
  path: WT,
  name: "wt-1",
  branch: "feature/one",
  isCurrent: false,
  isMainWorktree: false,
  worktreeChanges: null,
  lastActivityTimestamp: 1_000,
} as WorktreeState;

beforeEach(() => {
  consumeDeferredPaletteFocusRestore();
  _resetPluginWorktreeCardStatusStoreForTest();
  publishRegisteredPluginActions([]);
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: true, result: undefined });
  Reflect.set(window, "electron", {
    plugin: { onWorktreeCardStatusesChanged: vi.fn(() => () => {}) },
  });
  usePluginRuntimeStore.setState({
    pluginMetaById: new Map([["acme.docker", { devMode: false, displayName: "Docker" }]]),
  });
  useProjectStore.setState({
    currentProject: { id: "proj-a", name: "App", path: "/repo", emoji: "", lastOpened: 0 },
  });
});

afterEach(() => {
  cleanup();
});

function renderRow() {
  const onActivate = vi.fn();
  const onBeforeMenuAction = vi.fn();
  const store = createWorktreeStore();
  store.setState({ worktrees: new Map([[WT, worktree]]) });
  setCurrentViewStore(store);
  render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={store}>
        <div role="grid">
          <WorktreeOverviewRow
            worktree={worktree}
            cellId="overview-cell"
            chipState={null}
            isCurrent={false}
            isSelected={false}
            isCursor={false}
            isSelecting={false}
            isLast
            onActivate={onActivate}
            onToggleSelect={vi.fn()}
            onBeforeMenuAction={onBeforeMenuAction}
            onFocusLost={vi.fn()}
          />
        </div>
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  return { onActivate, onBeforeMenuAction };
}

function showStatus(status: { label: string; command?: string }) {
  usePluginWorktreeCardStatusStore.setState({
    statusesByProject: { "proj-a": { "acme.docker": { [WT]: status } } },
  });
}

describe("WorktreeOverviewRow plugin statuses (#13776)", () => {
  it("shows the card's plugin chips, out of the tab order like the row's other controls", () => {
    showStatus({ label: "2 up" });
    renderRow();
    const chip = screen.getByRole("button", { name: "Docker: 2 up" });
    expect(chip.tabIndex).toBe(-1);
  });

  it("gets the overview out of the way as the chip's command starts, for this worktree", () => {
    publishRegisteredPluginActions([["acme.docker.show", "Show containers"]]);
    showStatus({ label: "2 up", command: "acme.docker.show" });
    // Never settles: the overview must not wait on the command to close.
    dispatchMock.mockReturnValue(new Promise(() => {}));
    const { onActivate, onBeforeMenuAction } = renderRow();

    fireEvent.click(screen.getByRole("button", { name: "Docker: 2 up" }));

    expect(dispatchMock).toHaveBeenCalledWith(
      "acme.docker.show",
      { worktreeId: WT },
      { source: "user" }
    );
    expect(onBeforeMenuAction).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();

    // The close hands its focus restore back, to run only if nothing took it.
    const receive = consumeDeferredPaletteFocusRestore();
    expect(receive).not.toBeNull();
    const restore = vi.fn();
    receive!(restore);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("keeps the overview up for a chip with nothing to run", () => {
    showStatus({ label: "2 up", command: "acme.docker.show" });
    const { onActivate, onBeforeMenuAction } = renderRow();

    fireEvent.click(screen.getByRole("button", { name: "Docker: 2 up" }));

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(onBeforeMenuAction).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
    expect(consumeDeferredPaletteFocusRestore()).toBeNull();
  });

  it("draws no chip line for a worktree no plugin marked", () => {
    renderRow();
    expect(screen.queryByRole("button", { name: /Docker/ })).toBeNull();
  });
});
