import {
  useEffect,
  useLayoutEffect,
  createContext,
  useContext,
  useCallback,
  useState,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore, useWorktreeSelectionStore, type TerminalInstance } from "@/store";
import { DockedPanel } from "@/components/Terminal/DockedPanel";
import { buildPanelDuplicateOptions } from "@/services/terminal/panelDuplicationService";

interface DockPanelContextValue {
  portalTarget: (terminalId: string, target: HTMLElement | null) => void;
}

const DockPanelContext = createContext<DockPanelContextValue | null>(null);

export function useDockPanelPortal() {
  const context = useContext(DockPanelContext);
  if (!context) {
    throw new Error("useDockPanelPortal must be used within DockPanelOffscreenContainer");
  }
  return context.portalTarget;
}

interface DockPanelOffscreenContainerProps {
  children: React.ReactNode;
}

export function DockPanelOffscreenContainer({ children }: DockPanelOffscreenContainerProps) {
  // Track portal targets (popover containers) for each terminal
  const [portalTargets, setPortalTargets] = useState<Map<string, HTMLElement>>(new Map());
  // Track offscreen slots (stable DOM elements in the hidden container)
  const offscreenSlotsRef = useRef<Map<string, HTMLElement>>(new Map());
  const offscreenContainerRef = useRef<HTMLDivElement>(null);
  const [, forceUpdate] = useState(0);

  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  const dockTerminals = useTerminalStore(
    useShallow((s) =>
      s.terminals.filter(
        (t) =>
          t.location === "dock" &&
          // Show terminals that match active worktree OR have no worktree (global terminals)
          (t.worktreeId == null || t.worktreeId === activeWorktreeId)
      )
    )
  );

  const closeDockTerminal = useTerminalStore((s) => s.closeDockTerminal);
  const addTerminal = useTerminalStore((s) => s.addTerminal);
  const getPanelGroup = useTerminalStore((s) => s.getPanelGroup);
  const createTabGroup = useTerminalStore((s) => s.createTabGroup);
  const addPanelToGroup = useTerminalStore((s) => s.addPanelToGroup);
  const deleteTabGroup = useTerminalStore((s) => s.deleteTabGroup);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const openDockTerminal = useTerminalStore((s) => s.openDockTerminal);

  const handlePopoverClose = useCallback(() => {
    closeDockTerminal();
  }, [closeDockTerminal]);

  // Handler for adding a new tab to a single panel (creates a tab group)
  const handleAddTabForPanel = useCallback(
    async (panel: TerminalInstance) => {
      let groupId: string;
      let createdNewGroup = false;

      try {
        const existingGroup = getPanelGroup(panel.id);
        if (existingGroup) {
          groupId = existingGroup.id;
        } else {
          groupId = createTabGroup("dock", panel.worktreeId, [panel.id], panel.id);
          createdNewGroup = true;
        }

        const options = await buildPanelDuplicateOptions(panel, "dock");
        const newPanelId = await addTerminal(options);

        addPanelToGroup(groupId, newPanelId);
        setActiveTab(groupId, newPanelId);
        openDockTerminal(newPanelId);
      } catch (error) {
        console.error("Failed to add tab:", error);
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
      addTerminal,
      setActiveTab,
      openDockTerminal,
    ]
  );

  // Create offscreen slots eagerly after container mounts
  // This ensures slots exist before terminals try to portal to them
  useLayoutEffect(() => {
    if (!offscreenContainerRef.current) return;

    const container = offscreenContainerRef.current;
    const currentIds = new Set(dockTerminals.map((t) => t.id));

    // Create slots for new terminals
    for (const terminal of dockTerminals) {
      if (!offscreenSlotsRef.current.has(terminal.id)) {
        const slot = document.createElement("div");
        slot.setAttribute("data-offscreen-slot", terminal.id);
        slot.className = "offscreen-panel-slot";
        slot.style.width = "100%";
        slot.style.height = "100%";
        container.appendChild(slot);
        offscreenSlotsRef.current.set(terminal.id, slot);
      }
    }

    // Remove slots for removed terminals
    for (const [id, slot] of offscreenSlotsRef.current) {
      if (!currentIds.has(id)) {
        slot.remove();
        offscreenSlotsRef.current.delete(id);
      }
    }

    // Force update to ensure portals render with new slots
    forceUpdate((n) => n + 1);
  }, [dockTerminals]);

  // Cleanup portal targets for removed terminals
  useEffect(() => {
    const currentIds = new Set(dockTerminals.map((t) => t.id));
    setPortalTargets((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of prev.keys()) {
        if (!currentIds.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [dockTerminals]);

  const portalTarget = useCallback((terminalId: string, target: HTMLElement | null) => {
    setPortalTargets((prev) => {
      const prevTarget = prev.get(terminalId);
      if (prevTarget === target) return prev;

      const next = new Map(prev);
      if (target) {
        next.set(terminalId, target);
      } else {
        next.delete(terminalId);
      }
      return next;
    });
  }, []);

  const contextValue: DockPanelContextValue = {
    portalTarget,
  };

  return (
    <DockPanelContext.Provider value={contextValue}>
      {children}

      {/* Hidden container for dock panels - keeps them mounted */}
      {/* IMPORTANT: Size must be large enough for xterm to initialize (MIN_CONTAINER_SIZE = 50px) */}
      {/* Do NOT use visibility:hidden - it can cause xterm rendering issues */}
      <div
        ref={offscreenContainerRef}
        className="dock-panel-offscreen-container"
        style={{
          position: "fixed",
          left: "-20000px",
          top: 0,
          width: "800px",
          height: "600px",
          overflow: "hidden",
          opacity: 0,
          pointerEvents: "none",
        }}
        aria-hidden="true"
      />

      {/* Render panels via portal - ALWAYS use portal to avoid unmount/remount */}
      {dockTerminals.map((terminal) => {
        // Use popover target if available, otherwise use offscreen slot
        const target = portalTargets.get(terminal.id);
        const offscreenSlot = offscreenSlotsRef.current.get(terminal.id);
        const portalContainer = target || offscreenSlot;

        // Skip if no container yet (will render on next update after slots are created)
        if (!portalContainer) {
          return null;
        }

        // Only provide onAddTab for single panels (not in an explicit group)
        // Multi-panel groups handle tabs via DockedTabGroup
        const existingGroup = getPanelGroup(terminal.id);
        const isSinglePanel = !existingGroup || existingGroup.panelIds.length <= 1;

        const content = (
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
              onAddTab={isSinglePanel ? () => handleAddTabForPanel(terminal) : undefined}
            />
          </div>
        );

        // Always use createPortal with same key to prevent unmount/remount
        return createPortal(content, portalContainer, `dock-panel-${terminal.id}`);
      })}
    </DockPanelContext.Provider>
  );
}
