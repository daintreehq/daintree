// @vitest-environment jsdom
/**
 * "More worktrees…" through the real overlays (#12446). The mocked suite pins
 * the handoff's ordering; only the real menu and popover show where focus
 * actually lands, and where each kind of dismissal hands it back.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@/types";
import { _resetTooltipFocusSuppressionForTests } from "@/lib/tooltipFocusSuppression";

const { dispatchMock, worktrees, panelsById } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  // Main plus eleven others, one past what the submenu shows.
  worktrees: [
    { id: "w-main", name: "daintree", branch: "main", isMainWorktree: true },
    ...Array.from({ length: 11 }, (_, i) => ({
      id: `w-${i}`,
      name: `feature-${i}`,
      branch: `feature/${i}`,
      isMainWorktree: false,
    })),
  ].map((overrides): WorktreeState => ({
    worktreeId: overrides.id,
    path: `/repo/${overrides.name}`,
    isCurrent: false,
    worktreeChanges: null,
    lastActivityTimestamp: null,
    ...overrides,
  })),
  panelsById: {
    current: {
      "panel-1": {
        id: "panel-1",
        title: "Shell",
        kind: "terminal",
        worktreeId: "w-main",
        cwd: "/repo",
      },
    } as Record<string, unknown>,
  },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatchMock(...args),
    get: () => undefined,
    list: () => [],
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    get: () => undefined,
    getTerminal: () => undefined,
    getSelection: () => "",
  },
}));

vi.mock("@/store", () => {
  const state = () => ({
    panelsById: panelsById.current,
    maximizeTarget: null,
    getPanelGroup: () => undefined,
    watchedPanels: new Set<string>(),
  });
  const usePanelStore = (selector: (s: unknown) => unknown) => selector(state());
  usePanelStore.getState = state;
  return { usePanelStore };
});

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

vi.mock("@/hooks/useSidebarWorktreeOrder", () => ({
  useSidebarWorktreeOrder: () => worktrees,
}));

vi.mock("@/hooks/useWorktreeColorMap", () => ({
  useWorktreeColorMap: () => null,
}));

vi.mock("@/store/worktreeFilterStore", () => ({
  useWorktreeFilterStore: (selector: (state: unknown) => unknown) =>
    selector({ orderBy: "alpha", pinnedWorktrees: [], manualOrder: [] }),
}));

import { primeRadix } from "@/components/ui/radix-loader";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
// Hand-over (#12490) is not what these suites are about, and its candidate
// query needs a preload bridge they do not install.
vi.mock("../TerminalHandOver", () => ({
  useOrchestratorCandidates: () => ({ candidateIds: [], refresh: () => {} }),
  TerminalHandOverMenuItems: () => null,
  TerminalHandOverDialog: () => null,
}));

import { TerminalContextMenu } from "../TerminalContextMenu";
import { getGenericPanelMenuGroups } from "@/components/Panel/genericPanelMenu";

// Radix schedules its focus return on a zero-delay timer after the content
// unmounts, and arms outside-press listeners a tick after mounting.
const RADIX_TICK_MS = 20;

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, RADIX_TICK_MS)));

function searchField(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[aria-label="Search worktrees"]');
}

function renderPane() {
  render(
    <TerminalContextMenu terminalId="panel-1">
      <div data-testid="pane" tabIndex={-1}>
        Panel body
      </div>
    </TerminalContextMenu>
  );
  return screen.getByTestId("pane");
}

/** Right-click `target`, then walk into the submenu and pick More from the keyboard. */
async function openPickerFromMenu(target: HTMLElement, submenuName = "Move to worktree") {
  act(() => target.focus());
  fireEvent.contextMenu(target, { clientX: 24, clientY: 24 });
  const submenu = await screen.findByRole("menuitem", { name: submenuName });
  act(() => submenu.focus());
  fireEvent.keyDown(submenu, { key: "ArrowRight" });
  const more = await screen.findByRole("menuitem", { name: "More worktrees…" });
  expect(more.getAttribute("aria-haspopup")).toBe("dialog");
  fireEvent.keyDown(more, { key: "Enter" });
  await waitFor(() => expect(searchField()).not.toBeNull());
}

beforeAll(async () => {
  await primeRadix();
});

const shellPanel = panelsById.current["panel-1"];

beforeEach(() => {
  dispatchMock.mockReset();
  _resetTooltipFocusSuppressionForTests();
  panelsById.current = { "panel-1": shellPanel };
});

// A picker or dock preview left open unmounts here, and Radix runs its focus
// return on a timer; let it land before the next test starts.
afterEach(async () => {
  cleanup();
  await settle();
});

describe("TerminalContextMenu More worktrees…, through the real overlays", () => {
  it("lands the caret in the picker's search field and dispatches nothing", async () => {
    const pane = renderPane();

    await openPickerFromMenu(pane);

    await waitFor(() => expect(document.activeElement).toBe(searchField()));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("returns an Escape to the pane", async () => {
    const pane = renderPane();
    await openPickerFromMenu(pane);
    await waitFor(() => expect(document.activeElement).toBe(searchField()));

    fireEvent.keyDown(searchField()!, { key: "Escape" });

    await waitFor(() => expect(searchField()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(pane));
  });

  it("returns a pointer dismissal nowhere", async () => {
    const pane = renderPane();
    await openPickerFromMenu(pane);
    await waitFor(() => expect(document.activeElement).toBe(searchField()));
    await settle();
    const paneFocus = vi.spyOn(pane, "focus");

    // The whole press: Radix holds a primary-button outside press until its
    // click, so the pointer-down alone dismisses nothing.
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    fireEvent.pointerUp(document.body);
    fireEvent.mouseUp(document.body);
    fireEvent.click(document.body);

    await waitFor(() => expect(searchField()).toBeNull());
    await settle();
    expect(paneFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("hands a plugin panel's worktree move to the picker (#12606)", async () => {
    panelsById.current = {
      "panel-1": {
        id: "panel-1",
        title: "Dashboard",
        kind: "acme.dashboard",
        pluginId: "acme",
        worktreeId: "w-main",
      },
    };
    const moveCommand = getGenericPanelMenuGroups({
      location: "grid",
      isMaximized: false,
      isDockable: false,
      canMoveToWorktree: true,
    })
      .flat()
      .find((command) => command.id === "move-to-worktree")!;
    const pane = renderPane();

    await openPickerFromMenu(pane, moveCommand.label);
    await waitFor(() => expect(document.activeElement).toBe(searchField()));
    fireEvent.keyDown(searchField()!, { key: "Enter" });

    expect(dispatchMock).toHaveBeenCalledWith(
      "terminal.moveToWorktree",
      { terminalId: "panel-1", worktreeId: "w-0" },
      { source: "menu" }
    );
  });

  it("moves the panel from the picker", async () => {
    await openPickerFromMenu(renderPane());
    await waitFor(() => expect(document.activeElement).toBe(searchField()));

    // Main is the panel's own worktree, so the cursor starts on the next row.
    fireEvent.keyDown(searchField()!, { key: "Enter" });

    expect(dispatchMock).toHaveBeenCalledWith(
      "terminal.moveToWorktree",
      { terminalId: "panel-1", worktreeId: "w-0" },
      { source: "menu" }
    );
    await waitFor(() => expect(searchField()).toBeNull());
  });

  // The dock's items hand this menu their own popover's trigger as children.
  it("leaves a dock item's own popover trigger with the dock", async () => {
    render(
      <Popover>
        <TerminalContextMenu terminalId="panel-1">
          <PopoverTrigger asChild>
            <button type="button">Dock item</button>
          </PopoverTrigger>
        </TerminalContextMenu>
        <PopoverContent>Dock preview</PopoverContent>
      </Popover>
    );
    const dockItem = screen.getByRole("button", { name: "Dock item" });

    await openPickerFromMenu(dockItem);
    fireEvent.keyDown(searchField()!, { key: "Escape" });
    await waitFor(() => expect(searchField()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(dockItem));

    fireEvent.click(dockItem);

    expect(await screen.findByText("Dock preview")).toBeTruthy();
    expect(searchField()).toBeNull();
  });
});
