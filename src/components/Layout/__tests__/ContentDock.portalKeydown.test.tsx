// @vitest-environment jsdom
import { createPortal } from "react-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

// Issue #11156 — a docked terminal's Radix Popover content is portaled to
// document.body but stays a React descendant of the dock rail, so its keydowns
// bubble up the fiber tree into the rail's roving-tabindex handler. The chip
// stub below reproduces exactly that shape: a [data-dock-item] chip plus a
// portaled input that, like xterm, preventDefaults without stopping propagation.
//
// vi.mock factories are hoisted above the module body, so everything they read
// has to live in vi.hoisted or it is still in TDZ when they run.
const fixture = vi.hoisted(() => {
  const PORTAL_TERMINAL_ID = "dock-1";
  const dockPanels = [
    {
      id: PORTAL_TERMINAL_ID,
      kind: "terminal",
      title: "First panel",
      location: "dock",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    },
    {
      id: "dock-2",
      kind: "terminal",
      title: "Second panel",
      location: "dock",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    },
  ] satisfies PtyPanelData[];

  return {
    PORTAL_TERMINAL_ID,
    dockPanels,
    panelState: {
      panelsById: Object.fromEntries(dockPanels.map((panel) => [panel.id, panel])),
      panelIds: dockPanels.map((panel) => panel.id),
      trashedTerminals: new Map<string, never>(),
      tabGroups: new Map<string, never>(),
      getTabGroups: () => [],
      getTabGroupPanels: () => [],
    },
    // Returning children needs no JSX, which keeps this usable from vi.hoisted.
    passthrough: ({ children }: { children?: React.ReactNode }) => children,
  };
});

vi.mock("@/store", () => ({
  usePanelStore: (selector: (s: typeof fixture.panelState) => unknown) =>
    selector(fixture.panelState),
  useProjectStore: (selector: (s: { currentProject: null }) => unknown) =>
    selector({ currentProject: null }),
  useWorktreeSelectionStore: (selector: (s: { activeWorktreeId: null }) => unknown) =>
    selector({ activeWorktreeId: null }),
}));
vi.mock("@/store/scratchStore", () => ({
  useScratchStore: (selector: (s: { currentScratch: null }) => unknown) =>
    selector({ currentScratch: null }),
}));
vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: (selector: (s: { terminalId: null }) => unknown) =>
    selector({ terminalId: null }),
}));
vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: (selector: (s: { settings: null }) => unknown) =>
    selector({ settings: null }),
}));
vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: (selector: (s: { availability: null }) => unknown) =>
    selector({ availability: null }),
}));
vi.mock("@/store/toolbarPreferencesStore", () => ({
  useToolbarPreferencesStore: (selector: (s: { layout: { leftButtons: string[] } }) => unknown) =>
    selector({ layout: { leftButtons: [] } }),
}));
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (s: { setDockDensity: () => void }) => unknown) =>
    selector({ setDockDensity: () => {} }),
}));
vi.mock("@/hooks", () => ({
  useHorizontalScrollControls: () => ({
    canScrollLeft: false,
    canScrollRight: false,
    scrollLeft: vi.fn(),
    scrollRight: vi.fn(),
  }),
}));
vi.mock("@/hooks/useWorktrees", () => ({ useWorktrees: () => ({ worktrees: [] }) }));
vi.mock("@/hooks/useProjectSettings", () => ({ useProjectSettings: () => ({ settings: null }) }));
vi.mock("@/utils/workspaceCwd", () => ({ resolveWorkspaceCwd: () => "/tmp" }));
vi.mock("@/config/agents", () => ({ getAgentIds: () => [], getAgentConfig: () => undefined }));
vi.mock("@/lib/agentMenuOrder", () => ({
  sortAgentsByToolbarPin: () => ({ sorted: [], pinnedCount: 0 }),
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

vi.mock("@dnd-kit/core", () => ({
  useDndContext: () => ({ active: null }),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: fixture.passthrough,
  horizontalListSortingStrategy: vi.fn(),
}));
vi.mock("@/components/DragDrop", () => ({
  SortableDockItem: fixture.passthrough,
  SortableDockPlaceholder: () => null,
  DOCK_PLACEHOLDER_ID: "__dock-placeholder__",
  useIsWorktreeSortDragging: () => false,
  useDndPlaceholder: () => ({ activeTerminal: null, isDragging: false }),
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: fixture.passthrough,
  TooltipTrigger: fixture.passthrough,
  TooltipContent: () => null,
}));
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: fixture.passthrough,
  ContextMenuTrigger: fixture.passthrough,
  ContextMenuContent: () => null,
  ContextMenuItem: fixture.passthrough,
  ContextMenuLabel: fixture.passthrough,
  ContextMenuRadioGroup: fixture.passthrough,
  ContextMenuRadioItem: fixture.passthrough,
  ContextMenuSeparator: () => null,
  ContextMenuSub: fixture.passthrough,
  ContextMenuSubContent: fixture.passthrough,
  ContextMenuSubTrigger: fixture.passthrough,
}));

// Stands in for the real Radix Popover trigger + its portaled terminal content.
vi.mock("../DockedTerminalItem", () => ({
  DockedTerminalItem: ({ terminal }: { terminal: PtyPanelData }) => (
    <>
      <button type="button" data-dock-item="" data-testid={`chip-${terminal.id}`}>
        {terminal.title}
      </button>
      {terminal.id === fixture.PORTAL_TERMINAL_ID
        ? createPortal(
            <textarea
              aria-label="Docked terminal input"
              onKeyDown={(event) => event.preventDefault()}
            />,
            document.body
          )
        : null}
    </>
  ),
}));
vi.mock("../DockedNonPtyPanelItem", () => ({ DockedNonPtyPanelItem: () => null }));
vi.mock("../DockedTabGroup", () => ({ DockedTabGroup: () => null }));
vi.mock("../DockLaunchButton", () => ({ DockLaunchButton: () => null }));
vi.mock("../DockLaunchMenuItems", () => ({ DockLaunchMenuItems: () => null }));
vi.mock("../TrashContainer", () => ({ TrashContainer: () => null }));
vi.mock("../WaitingContainer", () => ({ WaitingContainer: () => null }));
vi.mock("../ErrorsContainer", () => ({ ErrorsContainer: () => null }));
vi.mock("../BackgroundContainer", () => ({ BackgroundContainer: () => null }));

import { ContentDock } from "../ContentDock";

function renderDock() {
  render(<ContentDock />);

  const rail = screen.getByRole("toolbar", { name: "Docked panels" });
  const chips = fixture.dockPanels.map((panel) => screen.getByTestId(`chip-${panel.id}`));

  // getDockItems() filters on `offsetParent !== null`, and jsdom has no layout,
  // so it reports null for every element. Without this the item list comes back
  // empty, the handler bails before the switch, and the regression below would
  // pass even with the guard removed — a worthless green.
  for (const chip of chips) {
    Object.defineProperty(chip, "offsetParent", { configurable: true, get: () => rail });
    chip.scrollIntoView = vi.fn();
  }

  const terminalInput = screen.getByRole("textbox", { name: "Docked terminal input" });
  return { rail, chips, terminalInput };
}

/** Roving tabindex keeps the active chip as the rail's only tab stop. */
const tabStops = (chips: HTMLElement[]) => chips.map((chip) => chip.tabIndex);

afterEach(cleanup);

describe("ContentDock — arrow keys from a docked terminal (issue #11156)", () => {
  it("roves focus across rail chips for arrows that originate on a chip", () => {
    const { chips } = renderDock();
    const [first, second] = chips as [HTMLElement, HTMLElement];

    first.focus();
    expect(tabStops(chips)).toEqual([0, -1]);

    fireEvent.keyDown(first, { key: "ArrowRight" });

    expect(document.activeElement).toBe(second);
    expect(tabStops(chips)).toEqual([-1, 0]);
  });

  it.each(["ArrowLeft", "ArrowRight", "Home", "End"] as const)(
    "leaves focus and rail tab stops untouched for %s typed into the portaled terminal",
    (key) => {
      const { rail, chips, terminalInput } = renderDock();

      chips[0]!.focus();
      const stopsBefore = tabStops(chips);

      terminalInput.focus();
      // The terminal is a React descendant of the rail but not a DOM one — that
      // divergence is the whole bug.
      expect(rail.contains(terminalInput)).toBe(false);

      fireEvent.keyDown(terminalInput, { key });

      expect(document.activeElement).toBe(terminalInput);
      expect(tabStops(chips)).toEqual(stopsBefore);
    }
  );

  it("does not adopt the portaled terminal as the rail's active chip on focus", () => {
    const { chips, terminalInput } = renderDock();

    chips[0]!.focus();
    terminalInput.focus();

    // Focus events bubble the fiber tree too. The rail must not treat the
    // terminal as one of its chips: ArrowRight from the first chip still lands
    // on the second, proving the active index survived the terminal's focus.
    fireEvent.keyDown(chips[0]!, { key: "ArrowRight" });

    expect(document.activeElement).toBe(chips[1]);
  });
});
