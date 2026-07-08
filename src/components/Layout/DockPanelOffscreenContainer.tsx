import { useEffect, useLayoutEffect, useCallback, useMemo, useState, useRef } from "react";
import { canDuplicatePanelKind } from "@/services/terminal/panelDuplicationService";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore, useWorktreeSelectionStore } from "@/store";
import { isDockPanel, type DockPanelData } from "@shared/types/panel";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { DockedPanel } from "@/components/Terminal/DockedPanel";
import { buildPanelDuplicateOptions } from "@/services/terminal/panelDuplicationService";
import { logError } from "@/utils/logger";
import { DockPopoverChildProvider } from "@/components/ui/DockPopoverChildContext";
import {
  DragHandleProvider,
  type DragHandleContextValue,
} from "@/components/DragDrop/DragHandleContext";
import { DockPanelContext, type DockPanelContextValue } from "./dockPanelPortalContext";

// Stable "no drag handle" value. The portaled dock panel body is ALWAYS wrapped
// in a DragHandleProvider (so the provider element type never toggles and the
// xterm-hosting subtree never remounts); parked/inactive panels receive this
// shared empty value so their PanelHeader renders exactly as before — no
// listeners, no keyboard activator, no spurious tab stop.
const EMPTY_DRAG_HANDLE: DragHandleContextValue = {
  listeners: undefined,
  setActivatorNodeRef: undefined,
};

interface DockPanelOffscreenContainerProps {
  children: React.ReactNode;
}

export function DockPanelOffscreenContainer({ children }: DockPanelOffscreenContainerProps) {
  // One stable wrapper <div> per dock panel. Each wrapper is created once and
  // is the permanent createPortal container for that panel — React never sees
  // it change identity, so opening/closing a popover (or switching tabs) never
  // unmounts the panel subtree. The wrapper lives in the offscreen container
  // when parked and is imperatively relocated into the popover via moveBefore.
  const wrappersRef = useRef<Map<string, HTMLElement>>(new Map());
  const offscreenContainerRef = useRef<HTMLDivElement>(null);
  // Mirror into state so JSX doesn't read the ref during render (React Compiler).
  // The ref remains the authoritative source; state snapshots it for render.
  const [wrappers, setWrappers] = useState<Map<string, HTMLElement>>(() => new Map());

  // Drag-handle bridge (#10990). SortableDockItem publishes its dnd-kit handle
  // here (keyed by panel id, or every member id for a group) so the portaled
  // panel body — a React sibling of the sortable — can consume it. Same ref +
  // state-snapshot shape as `wrappers` above: the ref is authoritative, state
  // snapshots it so render never reads the ref. SortableDockItem registers a
  // STABLE handle proxy (see its comment), so this map mutates only on dock-item
  // mount/unmount — never on drag frames despite dnd-kit churning listeners.
  const dragHandlesRef = useRef<Map<string, DragHandleContextValue>>(new Map());
  const [dragHandles, setDragHandles] = useState<Map<string, DragHandleContextValue>>(
    () => new Map()
  );

  const registerDragHandle = useCallback((panelIds: string[], handle: DragHandleContextValue) => {
    for (const id of panelIds) dragHandlesRef.current.set(id, handle);
    setDragHandles(new Map(dragHandlesRef.current));
    return () => {
      let changed = false;
      for (const id of panelIds) {
        // Only clear our own entry — a newer registration for the same id
        // (e.g. a remounted chip) must win over this stale disposer.
        if (dragHandlesRef.current.get(id) === handle) {
          dragHandlesRef.current.delete(id);
          changed = true;
        }
      }
      if (changed) setDragHandles(new Map(dragHandlesRef.current));
    };
  }, []);

  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  const activeDockTerminalId = usePanelStore((s) => s.activeDockTerminalId);
  const helpTerminalId = useHelpPanelStore((s) => s.terminalId);
  const dockTerminals = usePanelStore(
    useShallow((s) => {
      const result: DockPanelData[] = [];
      for (const id of s.panelIds) {
        const t = s.panelsById[id];
        if (
          t &&
          isDockPanel(t) &&
          t.location === "dock" &&
          !s.trashedTerminals.has(t.id) &&
          t.id !== helpTerminalId &&
          // Show terminals that match active worktree OR have no worktree (global terminals)
          (t.worktreeId == null || t.worktreeId === activeWorktreeId)
        ) {
          result.push(t);
        }
      }
      return result;
    })
  );

  const closeDockTerminal = usePanelStore((s) => s.closeDockTerminal);
  const addPanel = usePanelStore((s) => s.addPanel);
  const trashPanel = usePanelStore((s) => s.trashPanel);
  const getPanelGroup = usePanelStore((s) => s.getPanelGroup);
  const createTabGroup = usePanelStore((s) => s.createTabGroup);
  const addPanelToGroup = usePanelStore((s) => s.addPanelToGroup);
  const deleteTabGroup = usePanelStore((s) => s.deleteTabGroup);
  const setActiveTab = usePanelStore((s) => s.setActiveTab);

  const handlePopoverClose = useCallback(() => {
    closeDockTerminal();
  }, [closeDockTerminal]);

  useEffect(() => {
    if (!activeDockTerminalId) return;
    if (dockTerminals.some((terminal) => terminal.id === activeDockTerminalId)) return;
    // Harden against transient states where the panel exists in the canonical
    // store but hasn't yet landed in the filtered dockTerminals view (#7278).
    if (usePanelStore.getState().panelsById[activeDockTerminalId]) return;
    closeDockTerminal();
  }, [activeDockTerminalId, dockTerminals, closeDockTerminal]);

  // Handler for adding a new tab to a single panel (creates a tab group)
  const handleAddTabForPanel = useCallback(
    async (panel: DockPanelData) => {
      let groupId: string;
      let createdNewGroup = false;
      let newPanelId: string | null = null;

      try {
        const existingGroup = getPanelGroup(panel.id);
        if (existingGroup) {
          groupId = existingGroup.id;
        } else {
          groupId = createTabGroup("dock", panel.worktreeId, [panel.id], panel.id);
          createdNewGroup = true;
        }

        const options = await buildPanelDuplicateOptions(panel, "dock");
        // `activateDockOnCreate` folds dock activation into the panel commit so
        // the watchdog effect cannot collapse the just-created tab. See #6590.
        newPanelId = await addPanel({ ...options, activateDockOnCreate: true });
        if (!newPanelId) {
          if (createdNewGroup && groupId!) deleteTabGroup(groupId);
          return;
        }

        // On a rejected add (worktree mismatch, group vanished), the freshly
        // created panel would otherwise be orphaned outside any group — and the
        // dock watchdog effect above could read it as a stray and tear down the
        // dock pointer (#6596). Trash it first, then delete the group this call
        // created, and skip activation since the panel never joined the group.
        if (!addPanelToGroup(groupId, newPanelId)) {
          trashPanel(newPanelId);
          if (createdNewGroup && groupId!) deleteTabGroup(groupId);
          return;
        }
        setActiveTab(groupId, newPanelId);
      } catch (error) {
        logError("Failed to add tab", error);
        // Mirror the rejection path: trash a created-but-unjoined panel before
        // deleting a group this call created, so a mid-flight throw can't orphan
        // it for the dock watchdog to find (#10441, #6596).
        if (newPanelId) trashPanel(newPanelId);
        if (createdNewGroup && groupId!) {
          deleteTabGroup(groupId);
        }
      }
    },
    [
      getPanelGroup,
      createTabGroup,
      addPanelToGroup,
      deleteTabGroup,
      addPanel,
      trashPanel,
      setActiveTab,
    ]
  );

  // Create the stable wrapper for each panel eagerly after the container mounts,
  // so the wrapper exists (and createPortal can target it) before a popover
  // tries to relocate it. Wrappers stay parked in the offscreen container until
  // a popover opens.
  useLayoutEffect(() => {
    if (!offscreenContainerRef.current) return;

    const container = offscreenContainerRef.current;
    const currentIds = new Set(dockTerminals.map((t) => t.id));
    let changed = false;

    // Create wrappers for new terminals
    for (const terminal of dockTerminals) {
      if (!wrappersRef.current.has(terminal.id)) {
        const wrapper = document.createElement("div");
        wrapper.setAttribute("data-dock-panel-wrapper", terminal.id);
        wrapper.style.width = "100%";
        wrapper.style.height = "100%";
        wrapper.style.display = "flex";
        wrapper.style.flexDirection = "column";
        container.appendChild(wrapper);
        wrappersRef.current.set(terminal.id, wrapper);
        changed = true;
      }
    }

    // Remove wrappers for removed terminals (the portal content for them has
    // already been unmounted by React, so the wrapper is empty).
    for (const [id, wrapper] of wrappersRef.current) {
      if (!currentIds.has(id)) {
        wrapper.remove();
        wrappersRef.current.delete(id);
        changed = true;
      }
    }

    if (changed) {
      setWrappers(new Map(wrappersRef.current));
    }
  }, [dockTerminals]);

  // Relocate a panel's stable wrapper into the popover container (or back to the
  // offscreen parking container when destination is null). Uses moveBefore so
  // the move is atomic — xterm's canvas/WebGL context and focus survive without
  // a React remount. Guards both nodes' connectedness because moveBefore throws
  // HierarchyRequestError on disconnected/cross-document moves (e.g. while Radix
  // is tearing down PopoverContent); appendChild is the reconnecting fallback.
  const moveToDestination = useCallback((panelId: string, destination: HTMLElement | null) => {
    const wrapper = wrappersRef.current.get(panelId);
    if (!wrapper) return;
    const dest = destination ?? offscreenContainerRef.current;
    if (!dest || wrapper.parentElement === dest) return;

    // Capture focus so we can restore it on the appendChild fallback path
    // (moveBefore preserves focus itself; appendChild does not) and to work
    // around the Cr148 quirk where moving a focused field drops it.
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const hadFocus = !!active && wrapper.contains(active);

    if (wrapper.isConnected && dest.isConnected && typeof dest.moveBefore === "function") {
      try {
        dest.moveBefore(wrapper, null);
      } catch {
        dest.appendChild(wrapper);
      }
    } else {
      dest.appendChild(wrapper);
    }

    if (hadFocus && active && active.isConnected && document.activeElement !== active) {
      active.focus();
    }
  }, []);

  // Both callbacks are referentially stable, so the context value stays stable
  // across renders — consumers (SortableDockItem, dock chips) never re-run their
  // effects just because this container re-rendered.
  const contextValue = useMemo<DockPanelContextValue>(
    () => ({ moveToDestination, registerDragHandle }),
    [moveToDestination, registerDragHandle]
  );

  return (
    <DockPanelContext.Provider value={contextValue}>
      {children}

      {/* Hidden parking container for dock panel wrappers. Each panel's stable
          wrapper lives here while its popover is closed and is moved into the
          popover (via moveBefore) on open — never unmounted. */}
      {/* IMPORTANT: Size must be large enough for xterm to initialize (MIN_CONTAINER_SIZE = 50px) */}
      {/* content-visibility:hidden skips render work while preserving layout geometry */}
      <div
        ref={offscreenContainerRef}
        className="dock-panel-offscreen-container"
        style={
          {
            contentVisibility: "hidden",
            position: "fixed",
            left: 0,
            top: 0,
            width: "800px",
            height: "600px",
            overflow: "hidden",
            zIndex: -1,
          } as React.CSSProperties
        }
        aria-hidden="true"
      />

      {/* Render each panel into its stable wrapper. The wrapper is always the
          portal container — its DOM position changes (offscreen ↔ popover) via
          moveBefore, but its identity never does, so React never remounts. */}
      {dockTerminals.map((terminal) => {
        const wrapper = wrappers.get(terminal.id);

        // Skip until the wrapper exists (created in the layout effect; renders
        // on the next update once setWrappers commits).
        if (!wrapper) {
          return null;
        }

        // Only provide onAddTab for single panels (not in an explicit group)
        // Multi-panel groups handle tabs via DockedTabGroup
        const existingGroup = getPanelGroup(terminal.id);
        const isSinglePanel = !existingGroup || existingGroup.panelIds.length <= 1;

        // Re-provide the dock sortable's drag handle across the portal boundary
        // (#10990) so this panel's PanelHeader becomes a drag handle, matching
        // the grid. Gate on the active dock panel: only the one open popover's
        // header receives live listeners + the keyboard activator ref, so parked
        // headers never claim a group's shared setActivatorNodeRef and no
        // offscreen header becomes a stray drag/tab target. The provider is
        // ALWAYS present (empty value when inactive) so its element type never
        // toggles — the xterm-hosting DockedPanel subtree is never remounted.
        const bridgedDragHandle =
          terminal.id === activeDockTerminalId
            ? (dragHandles.get(terminal.id) ?? EMPTY_DRAG_HANDLE)
            : EMPTY_DRAG_HANDLE;

        // Wrap the portaled panel body in DockPopoverChildProvider so any
        // Radix overlay opened from inside the docked panel (e.g.
        // TerminalContextMenu via ContentPanel, panel header dropdowns,
        // tooltips on action buttons) inherits the context. Without this,
        // those overlays would not be stamped with data-dock-popover-child
        // and the dock popover would dismiss when the user clicks a menu
        // item — see #8161.
        const content = (
          <DockPopoverChildProvider>
            <DragHandleProvider value={bridgedDragHandle}>
              <div
                data-dock-panel-id={terminal.id}
                className="dock-panel-slot"
                style={{
                  width: "100%",
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <DockedPanel
                  terminal={terminal}
                  onPopoverClose={handlePopoverClose}
                  onAddTab={
                    isSinglePanel && canDuplicatePanelKind(terminal.kind)
                      ? () => handleAddTabForPanel(terminal)
                      : undefined
                  }
                  showRestoreControl={isSinglePanel}
                />
              </div>
            </DragHandleProvider>
          </DockPopoverChildProvider>
        );

        // Portal into the stable wrapper. Because the wrapper identity never
        // changes, React keeps the same fiber across open/close — the wrapper is
        // simply relocated in the DOM by moveToDestination.
        return createPortal(content, wrapper, `dock-panel-${terminal.id}`);
      })}
    </DockPanelContext.Provider>
  );
}
