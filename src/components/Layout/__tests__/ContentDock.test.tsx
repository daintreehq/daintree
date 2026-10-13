// @vitest-environment jsdom
import { createPortal } from "react-dom";
import { readFileSync } from "fs";
import { resolve } from "path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

// Issue #11156 — a docked terminal's Radix Popover content is portaled to
// document.body, so it sits outside the dock rail's DOM tree while its keydowns
// still arrive at the rail's roving-tabindex handler through React. Typing an
// arrow in a docked terminal roved the rail and yanked focus onto the next chip.
//
// This is a handler-level test of that contract, not a replica of the production
// panel topology (which relocates the panel through DockPanelOffscreenContainer
// into the popover). It asserts what the rail owes its portaled children: a key
// whose target is outside the rail's DOM is none of the rail's business.
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
      // The rail reads the worktree index alongside `panelIds` so a panel
      // committed mid-spawn-batch still paints (#9649). These fixtures are all
      // worktree-less, so they live in the `__none__` bucket.
      panelIdsByWorktreeId: { __none__: dockPanels.map((panel) => panel.id) },
      trashedTerminals: new Map<string, never>(),
      tabGroups: new Map<string, never>(),
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
  // #12108: the dock filters against every lane, so it reads this selector.
  selectSlotTerminalIds: () => [],
  selectSlot: (s: unknown) => s,
  selectActiveSlot: (s: unknown) => s,
  selectOpenSlots: () => [0],
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
  useToolbarPreferencesStore: (
    selector: (s: { layout: { leftButtons: string[]; rightButtons: string[] } }) => unknown
  ) => selector({ layout: { leftButtons: [], rightButtons: [] } }),
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
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
}));
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
  useDndMonitor: () => {},
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
  ContextMenuMeta: fixture.passthrough,
  ContextMenuLabel: fixture.passthrough,
  ContextMenuRadioGroup: fixture.passthrough,
  ContextMenuRadioItem: fixture.passthrough,
  ContextMenuSeparator: () => null,
  ContextMenuSub: fixture.passthrough,
  ContextMenuSubContent: fixture.passthrough,
  ContextMenuSubTrigger: fixture.passthrough,
}));

// Stands in for the real Radix Popover trigger plus its portaled panel content.
// Two inputs, because production has two kinds of key-cancelling behaviour and
// the guard must be blind to both:
//   - "cancelled": xterm in its default mode stops propagation on keys it
//     handles. This is the benign case.
//   - "uncancelled": xterm in screenReaderMode deliberately does NOT cancel
//     arrows (see CoreBrowserTerminal's keydown handler), and the CodeMirror
//     input bar preventDefaults without stopping propagation. These are the
//     events that actually escape into the rail — the real #11156 trigger.
// A guard keyed on `defaultPrevented` would pass the cancelled case and still
// let the uncancelled one steal focus, so both are asserted.
vi.mock("../DockedTerminalItem", () => ({
  DockedTerminalItem: ({ terminal }: { terminal: PtyPanelData }) => (
    <>
      <button type="button" data-dock-item="" data-testid={`chip-${terminal.id}`}>
        {terminal.title}
      </button>
      {terminal.id === fixture.PORTAL_TERMINAL_ID
        ? createPortal(
            <>
              <textarea
                aria-label="Cancelled terminal input"
                onKeyDown={(event) => event.preventDefault()}
              />
              <textarea aria-label="Uncancelled terminal input" />
            </>,
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

  const inputs = {
    cancelled: screen.getByRole("textbox", { name: "Cancelled terminal input" }),
    uncancelled: screen.getByRole("textbox", { name: "Uncancelled terminal input" }),
  };
  return { rail, chips, inputs };
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

  const KEYS = ["ArrowLeft", "ArrowRight", "Home", "End"] as const;
  const SURFACES = ["cancelled", "uncancelled"] as const;

  it.each(SURFACES.flatMap((surface) => KEYS.map((key) => [surface, key] as const)))(
    "leaves focus and rail tab stops untouched for %s %s typed into the portaled terminal",
    (surface, key) => {
      const { rail, chips, inputs } = renderDock();
      const input = inputs[surface];

      chips[0]!.focus();
      const stopsBefore = tabStops(chips);

      input.focus();
      // The terminal reaches this handler through the React tree while sitting
      // outside the rail's DOM tree. That divergence is the whole bug.
      expect(rail.contains(input)).toBe(false);

      fireEvent.keyDown(input, { key });

      expect(document.activeElement).toBe(input);
      expect(tabStops(chips)).toEqual(stopsBefore);
    }
  );

  it("does not adopt the portaled terminal as the rail's active chip on focus", () => {
    const { chips, inputs } = renderDock();

    chips[0]!.focus();
    inputs.uncancelled.focus();

    // Focus events bubble the fiber tree too. The rail must not treat the
    // terminal as one of its chips: ArrowRight from the first chip still lands
    // on the second, proving the active index survived the terminal's focus.
    fireEvent.keyDown(chips[0]!, { key: "ArrowRight" });

    expect(document.activeElement).toBe(chips[1]);
  });
});

describe("ContentDock regression test", () => {
  it("does not import or render ClusterAttentionPill", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).not.toContain("ClusterAttentionPill");
    expect(content).not.toContain('from "@/components/Fleet"');
  });

  // Issue #11332 — dock membership must follow the registry so plugin panels can
  // dock. The dock selectors read `getRenderablePanel` (which keeps plugin
  // kinds), NOT `getNarrowPanel` (which drops them, so plugin panels would never
  // reach `isDockPanel`). Reverting either call site silently strands every
  // dockable plugin panel, so pin the selector here.
  it("reads dock panels through getRenderablePanel so plugin kinds are not dropped", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    // Target the call sites (not prose) so a doc mention can't mask a revert.
    expect(content).toContain("getRenderablePanel(state.panelsById");
    expect(content).not.toContain("getNarrowPanel(state.panelsById");
  });

  // Issue #11332 — the single-panel chip renders through the generic
  // `DockedNonPtyPanelItem` with a kind-aware `dockChipTitle`, replacing the old
  // three-way ternary whose `else` branch assumed browser and would mislabel a
  // plugin panel's chip.
  it("renders non-PTY dock chips through the generic dockChipTitle path", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).toContain("displayTitle={dockChipTitle(terminal)}");
    // The removed branch fed browserChipTitle to the ternary's non-file else.
    expect(content).not.toMatch(/:\s*isFilePanel\(terminal\)\s*\?/);
  });

  it("offscreen dock container closes stale active dock state", () => {
    const content = readFileSync(resolve(__dirname, "../DockPanelOffscreenContainer.tsx"), "utf-8");

    expect(content).toContain("activeDockTerminalId");
    expect(content).toContain("closeDockTerminal(activeDockTerminalId)");
    expect(content).toContain("!s.trashedTerminals.has(t.id)");
  });

  it("renders the visible DockLaunchButton wired to handleAddTerminal", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).toContain("DockLaunchButton");
    expect(content).toContain("agents={launchAgents}");
    expect(content).toMatch(/onLaunchAgent=\{[^}]*handleAddTerminal/);
    // #11521 — the dock creates panels in the dock, so both of its launcher
    // surfaces must declare that. A grid surface here would offer dock
    // destinations the dock's own callback would then contradict.
    expect(content).toContain('surface="dock"');
    expect(content).not.toContain('surface="grid"');
  });

  it("places the launch button on the left side of the dock", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    const launchIdx = content.indexOf("<DockLaunchButton");
    const trashIdx = content.indexOf("<TrashContainer");

    expect(launchIdx).toBeGreaterThan(0);
    expect(launchIdx).toBeLessThan(trashIdx);
  });

  // Issue #6428 — accent ring on isOver was a restraint violation; the armed
  // rail now draws the shared neutral drop-target frame.
  it("draws the shared drop-target frame on dock isOver state (no accent)", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).not.toContain("ring-accent-primary");
    // Armed across the rail's own chips, and never for a refused drag.
    expect(content).toMatch(/isDropTarget\s*&&\s*cn\(DROP_TARGET_FRAME/);
    expect(content).toMatch(/useArmedDropTarget\(\{[^]*?disabled:\s*isDockDropRejected/);
  });

  // Issue #8162 — drop the ambient in-flight rail tint; the only drag-state cue
  // is the armed isOver treatment, plus a cursor-no-drop rejection signal.
  // Issue #11054 — the rejection cue also fires for a drag whose panel kind the
  // dock can't render, not just worktree-card sort drags, via the shared
  // `isDockDropRejected` gate. Both cases suppress the armed isOver treatment.
  // Issue #11375 — the non-dockable check is now GROUP-AWARE: it reads
  // `activeDragRejectsDock` off the placeholder context (which resolves every
  // group member's kind), not the lone representative kind, so the cue matches
  // what cancelDrop/collisionDetection enforce for a mixed group.
  it("removes ambient panel-drag tint and rejects non-dockable drags with cursor feedback", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).not.toContain("useIsDragging");
    expect(content).not.toContain('isPanelDragging && "bg-overlay-subtle"');
    expect(content).toContain('isDockDropRejected && "cursor-no-drop"');
    // The reject gate folds in the group-aware dock-reject flag from the context.
    expect(content).toContain("activeDragRejectsDock");
    expect(content).toMatch(/isDockDropRejected\s*=\s*isWorktreeSortDragging\s*\|\|/);
    // Rejection is the one drag state the cursor carries; an accepted drop is a
    // move, so the rail never promises a copy.
    expect(content).not.toContain("cursor-copy");
  });

  // Issue #6590 — handleAddTerminal must rely on the atomic dock activation
  // flag instead of a follow-up openDockTerminal() call, otherwise the
  // watchdog effect collapses the freshly created panel.
  it("handleAddTerminal passes activateDockOnCreate and does not call openDockTerminal", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).toContain("activateDockOnCreate: true");
    expect(content).not.toContain("openDockTerminal(result.result.terminalId)");
    expect(content).not.toMatch(/openDockTerminal\(result\.result\?\.terminalId\)/);
  });

  // Issue #6590 — DockPanelOffscreenContainer.handleAddTabForPanel must use
  // the atomic flag too. The same race that collapses dock-launched agents
  // also collapses the just-created tab in a single-panel-to-tab-group flow.
  it("DockPanelOffscreenContainer add-tab flow uses atomic dock activation", () => {
    const content = readFileSync(resolve(__dirname, "../DockPanelOffscreenContainer.tsx"), "utf-8");

    expect(content).toContain("activateDockOnCreate: true");
    expect(content).not.toContain("openDockTerminal(newPanelId)");
  });

  // Issue #7979 — dock context menu must surface a "Dock density" submenu
  // wired to the same preference store the Settings dialog uses, so users
  // can switch density in place without leaving the dock.
  it("renders a Dock density submenu wired to setDockDensity", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).toContain("ContextMenuSub");
    expect(content).toContain("ContextMenuSubTrigger");
    expect(content).toContain("ContextMenuSubContent");
    expect(content).toContain("ContextMenuRadioGroup");
    expect(content).toContain("ContextMenuRadioItem");
    expect(content).toContain("Dock density");
  });

  it("subscribes to setDockDensity from usePreferencesStore", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).toMatch(/usePreferencesStore\(\(s\)\s*=>\s*s\.setDockDensity\)/);
  });

  it("places the density submenu after DockLaunchMenuItems with a separator", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    const launchIdx = content.indexOf("<DockLaunchMenuItems");
    const separatorIdx = content.indexOf("<ContextMenuSeparator />", launchIdx);
    const subIdx = content.indexOf("<ContextMenuSub>", launchIdx);

    expect(launchIdx).toBeGreaterThan(0);
    expect(separatorIdx).toBeGreaterThan(launchIdx);
    expect(subIdx).toBeGreaterThan(separatorIdx);
  });

  // Issue #7278 — the watchdog effect in DockPanelOffscreenContainer must
  // check panelsById before firing closeDockTerminal, so that a panel that
  // exists in canonical storage but hasn't landed in the filtered
  // dockTerminals view yet isn't spuriously collapsed.
  it("DockPanelOffscreenContainer watchdog guards with panelsById before closing", () => {
    const content = readFileSync(resolve(__dirname, "../DockPanelOffscreenContainer.tsx"), "utf-8");

    expect(content).toContain("usePanelStore.getState().panelsById[activeDockTerminalId]");
    // The panelsById guard must appear before the close call inside the
    // same useEffect block.
    const effectStart = content.indexOf("if (!activeDockTerminalId) return;");
    const panelsByIdGuard = content.indexOf("panelsById[activeDockTerminalId]");
    const closeCall = content.indexOf("closeDockTerminal(activeDockTerminalId)", effectStart);

    expect(effectStart).toBeGreaterThan(0);
    expect(panelsByIdGuard).toBeGreaterThan(effectStart);
    expect(panelsByIdGuard).toBeLessThan(closeCall);
  });

  // Issue #8170 — the scrollable chip rail is an ARIA toolbar with a single
  // tab stop and roving tabindex Arrow/Home/End navigation. dnd-kit's
  // KeyboardSensor owns the keys during an active drag; the rail handler
  // must early-return when useDndContext().active != null. Focusing an
  // off-screen chip scrolls it into view with behavior:"instant".
  describe("keyboard navigation — issue #8170", () => {
    it("marks the scrollable rail as an ARIA toolbar", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      expect(content).toContain('role="toolbar"');
      expect(content).toContain('aria-label="Docked panels"');
      expect(content).toContain('aria-orientation="horizontal"');
    });

    it("flips aria-busy on the rail while a dnd-kit drag is active", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      expect(content).toMatch(/const\s+\{\s*active:\s*dndActive\s*\}\s*=\s*useDndContext\(\)/);
      expect(content).toContain("const isDndActive = dndActive !== null");
      expect(content).toContain("aria-busy={isDndActive || undefined}");
    });

    it("early-returns the key handler when dnd-kit has an active drag", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      // The guard must appear inside handleDockKeyDown, before any
      // preventDefault or arrow-key handling.
      const handlerStart = content.indexOf("handleDockKeyDown = useCallback");
      const guard = content.indexOf("if (dndActive !== null) return", handlerStart);
      const switchStart = content.indexOf("switch (e.key)", handlerStart);

      expect(handlerStart).toBeGreaterThan(0);
      expect(guard).toBeGreaterThan(handlerStart);
      expect(guard).toBeLessThan(switchStart);
    });

    it("handles Arrow/Home/End with wrap and preventDefault inside the switch", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      expect(content).toContain('case "ArrowRight"');
      expect(content).toContain('case "ArrowLeft"');
      expect(content).toContain('case "Home"');
      expect(content).toContain('case "End"');
      // Wrap arithmetic on both ends.
      expect(content).toMatch(/\(currentIdx \+ 1\) % items\.length/);
      expect(content).toMatch(/\(currentIdx - 1 \+ items\.length\) % items\.length/);
    });

    it("focuses then scrolls instantly — focus must precede scrollIntoView", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      expect(content).toContain('scrollIntoView({ behavior: "instant"');
      expect(content).toContain('block: "nearest"');
      expect(content).toContain('inline: "nearest"');

      // .focus() must come before scrollIntoView in handleDockKeyDown so the
      // browser's own scroll-on-focus does not override the explicit call.
      const handlerStart = content.indexOf("handleDockKeyDown = useCallback");
      const focusCall = content.indexOf("target.focus()", handlerStart);
      const scrollCall = content.indexOf("target.scrollIntoView", handlerStart);

      expect(focusCall).toBeGreaterThan(0);
      expect(scrollCall).toBeGreaterThan(focusCall);
    });

    it("preserves data-dock-item attribute on chip buttons", () => {
      const terminalItem = readFileSync(resolve(__dirname, "../DockedTerminalItem.tsx"), "utf-8");
      const tabGroup = readFileSync(resolve(__dirname, "../DockedTabGroup.tsx"), "utf-8");

      expect(terminalItem).toContain('data-dock-item=""');
      expect(tabGroup).toContain('data-dock-item=""');
    });
  });

  // Issue #9681 — when the focused chip unmounts, the roving-tabindex
  // useLayoutEffect re-homes the tab stop but focus has already dropped to
  // <body>, killing keyboard navigation. The dock mirrors Toolbar.tsx's
  // prevFocusedToolbarItemRef recovery: track the focused chip, and on
  // eviction redirect focus onto the promoted chip — but only when focus
  // genuinely fell to <body> (not into a Radix portal). Two further fixes:
  // the scroll chevrons are decorative pointer-only controls and must leave
  // the tab order, and the scroll container needs scroll-padding so focused
  // edge chips are not parked behind the gradient scrim.
  describe("focus recovery — issue #9681", () => {
    it("records the focused chip in handleDockFocusCapture", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      // The assignment must live inside handleDockFocusCapture's idx-found
      // branch so the ref always reflects the live focused chip.
      const handlerStart = content.indexOf("handleDockFocusCapture = useCallback");
      const assign = content.indexOf("prevFocusedDockItemRef.current = target", handlerStart);
      const handlerEnd = content.indexOf("handleDockKeyDown = useCallback", handlerStart);

      expect(handlerStart).toBeGreaterThan(0);
      expect(assign).toBeGreaterThan(handlerStart);
      expect(assign).toBeLessThan(handlerEnd);
    });

    it("redirects focus to the promoted chip only when focus fell to <body>", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      // Eviction detection: prev focused chip no longer in the live list.
      expect(content).toMatch(/if\s*\(prevFocused\s*&&\s*!items\.includes\(prevFocused\)\)/);
      // The portal guard must gate the .focus() call.
      const guard = content.indexOf("document.activeElement === document.body");
      const focusCall = content.indexOf("items[clamped]?.focus()");
      expect(guard).toBeGreaterThan(0);
      expect(focusCall).toBeGreaterThan(guard);
    });

    it("clears the recovery ref unconditionally on eviction (before the body guard)", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      // A stale ref would trigger a phantom redirect on a later unrelated
      // render, so the clear must precede the activeElement guard.
      const clear = content.indexOf("prevFocusedDockItemRef.current = null");
      const guard = content.indexOf("document.activeElement === document.body");
      expect(clear).toBeGreaterThan(0);
      expect(guard).toBeGreaterThan(clear);
    });

    it("renders both scroll chevrons through DockScrollChevron", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      // Pointer-only semantics (aria-hidden, tabIndex -1) and the boundary fade
      // live in DockScrollChevron and are pinned by its own render tests.
      expect(content).toMatch(/<DockScrollChevron\s+side="left"[^>]*onClick=\{scrollLeft\}/);
      expect(content).toMatch(/<DockScrollChevron\s+side="right"[^>]*onClick=\{scrollRight\}/);
    });

    it("applies scroll-padding so focused edge chips clear the gradient scrim", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      expect(content).toContain("scroll-px-4");
    });
  });
});
