// @vitest-environment jsdom
/**
 * The panel menu opened from a row that stands for a pane the user cannot see:
 * a backgrounded panel (the dock's Background popover) or a pane in another
 * worktree (the dock's Waiting popover). Every item must still act on that
 * panel correctly from there.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type React from "react";

vi.mock("@/components/ui/context-menu", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Item = ({ children, onSelect }: { children?: React.ReactNode; onSelect?: () => void }) => (
    <button onClick={() => onSelect?.()}>{children}</button>
  );
  return {
    ContextMenu: Passthrough,
    ContextMenuTrigger: Passthrough,
    ContextMenuContent: Passthrough,
    ContextMenuItem: Item,
    ContextMenuActionItem: Item,
    ContextMenuCheckboxItem: Item,
    ContextMenuRadioGroup: Passthrough,
    ContextMenuRadioItem: Item,
    ContextMenuSeparator: () => null,
    ContextMenuLabel: Passthrough,
    ContextMenuShortcut: Passthrough,
    ContextMenuGroup: Passthrough,
    ContextMenuPortal: Passthrough,
    ContextMenuSub: Passthrough,
    ContextMenuSubContent: Passthrough,
    ContextMenuSubTrigger: Passthrough,
  };
});

const dispatch = vi.hoisted(() => vi.fn());

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch, get: () => undefined, list: () => [] },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: { getTerminal: () => undefined, getSelection: () => "" },
}));

vi.mock("@/hooks/useSidebarWorktreeOrder", () => ({
  useSidebarWorktreeOrder: () => [
    { id: "wt-1", name: "one", path: "/one", branch: "one" },
    { id: "wt-2", name: "two", path: "/two", branch: "two" },
  ],
}));
vi.mock("@/hooks/useIsHibernated", () => ({ useIsHibernated: () => false }));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({ usePluginContextMenuItems: () => [] }));

vi.mock("@/store/voiceRecordingStore", () => ({
  useVoiceRecordingStore: (selector: (s: unknown) => unknown) =>
    selector({ lockedTarget: null, recentTargets: [] }),
}));

vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: (selector: (s: { armedIds: Set<string> }) => unknown) =>
    selector({ armedIds: new Set<string>() }),
  isFleetArmEligible: () => false,
}));

vi.mock("@/store/fleetSnapshotStore", () => ({
  useFleetSnapshotStore: (selector: (s: { snapshot: unknown }) => unknown) =>
    selector({ snapshot: null }),
}));

const selectWorktree = vi.hoisted(() => vi.fn());
const trackTerminalFocus = vi.hoisted(() => vi.fn());

vi.mock("@/store/worktreeStore", () => {
  const state = () => ({ activeWorktreeId: "wt-1", selectWorktree, trackTerminalFocus });
  const useWorktreeSelectionStore = (selector: (s: ReturnType<typeof state>) => unknown) =>
    selector(state());
  useWorktreeSelectionStore.getState = state;
  return { useWorktreeSelectionStore };
});

const panelsById = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const restoreBackgroundTerminal = vi.hoisted(() => vi.fn());
const activateTerminal = vi.hoisted(() => vi.fn());
const pingTerminal = vi.hoisted(() => vi.fn());

vi.mock("@/store", () => {
  const state = () => ({
    panelsById: panelsById.current,
    maximizeTarget: null,
    getPanelGroup: () => undefined,
    watchedPanels: new Set<string>(),
    restoreBackgroundTerminal,
    activateTerminal,
    pingTerminal,
  });
  const usePanelStore = (selector: (s: ReturnType<typeof state>) => unknown) => selector(state());
  usePanelStore.getState = state;
  return { usePanelStore };
});

import { TerminalContextMenu } from "../TerminalContextMenu";

function renderMenu(panel: { id: string } & Record<string, unknown>) {
  panelsById.current = { [panel.id]: panel };
  return render(
    <TerminalContextMenu terminalId={panel.id}>
      <div>Row</div>
    </TerminalContextMenu>
  );
}

const terminal = {
  id: "panel-1",
  title: "npm run storybook",
  kind: "terminal",
  worktreeId: "wt-1",
  hasPty: true,
};

afterEach(() => {
  cleanup();
  dispatch.mockReset();
  restoreBackgroundTerminal.mockReset();
  activateTerminal.mockReset();
  pingTerminal.mockReset();
  selectWorktree.mockReset();
  trackTerminalFocus.mockReset();
});

describe("TerminalContextMenu — a backgrounded panel", () => {
  it("offers its way back instead of moves that would strand its background bookkeeping", () => {
    renderMenu({ ...terminal, location: "background" });

    expect(screen.queryByText("Send to background")).toBeNull();
    expect(screen.queryByText("Move to grid")).toBeNull();
    expect(screen.queryByText("Move to dock")).toBeNull();
    expect(screen.queryByText("Move to worktree")).toBeNull();

    fireEvent.click(screen.getByText("Restore from background"));
    expect(restoreBackgroundTerminal).toHaveBeenCalledWith("panel-1");
    expect(dispatch).not.toHaveBeenCalledWith(
      "terminal.moveToGrid",
      expect.anything(),
      expect.anything()
    );
  });

  it("restores like the row's own Restore: to the pane's worktree, focused", () => {
    renderMenu({ ...terminal, location: "background", worktreeId: "wt-2" });
    fireEvent.click(screen.getByText("Restore from background"));
    expect(selectWorktree).toHaveBeenCalledWith("wt-2");
    expect(trackTerminalFocus).toHaveBeenCalledWith("wt-2", "panel-1");
    expect(restoreBackgroundTerminal).toHaveBeenCalledWith("panel-1");
    expect(activateTerminal).toHaveBeenCalledWith("panel-1");
  });

  it("keeps the ordinary layout items for a panel that is not backgrounded", () => {
    renderMenu({ ...terminal, location: "grid" });
    expect(screen.queryByText("Restore from background")).toBeNull();
    expect(screen.getByText("Send to background")).toBeTruthy();
    expect(screen.getByText("Move to dock")).toBeTruthy();
  });
});

describe("TerminalContextMenu — a pane in another worktree", () => {
  it("does not offer to maximize a pane the grid in front of the user is not showing", () => {
    renderMenu({ ...terminal, location: "grid", worktreeId: "wt-2" });
    expect(screen.queryByText("Maximize")).toBeNull();
  });

  it("offers maximize for the same pane in the active worktree", () => {
    renderMenu({ ...terminal, location: "grid", worktreeId: "wt-1" });
    expect(screen.getByText("Maximize")).toBeTruthy();
  });
});
