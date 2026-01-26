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
import { useTerminalStore, useWorktreeSelectionStore } from "@/store";
import { DockedPanel } from "@/components/Terminal/DockedPanel";

const DEBUG_DOCK = true;
function dockLog(message: string, ...args: unknown[]) {
  if (DEBUG_DOCK) {
    console.log(`[DockOffscreen] ${message}`, ...args);
  }
}

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
  const allTerminals = useTerminalStore((s) => s.terminals);
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

  // Log terminal filtering
  useEffect(() => {
    const allDockTerminals = allTerminals.filter((t) => t.location === "dock");
    dockLog("Terminal filtering:", {
      totalTerminals: allTerminals.length,
      allDockTerminals: allDockTerminals.map((t) => ({
        id: t.id,
        kind: t.kind,
        worktreeId: t.worktreeId,
        title: t.title,
      })),
      activeWorktreeId,
      filteredDockTerminals: dockTerminals.map((t) => ({
        id: t.id,
        kind: t.kind,
        worktreeId: t.worktreeId,
        title: t.title,
      })),
    });
  }, [allTerminals, dockTerminals, activeWorktreeId]);

  const closeDockTerminal = useTerminalStore((s) => s.closeDockTerminal);

  const handlePopoverClose = useCallback(() => {
    closeDockTerminal();
  }, [closeDockTerminal]);

  // Create offscreen slots eagerly after container mounts
  // This ensures slots exist before terminals try to portal to them
  useLayoutEffect(() => {
    dockLog("useLayoutEffect running, container ref:", offscreenContainerRef.current);
    if (!offscreenContainerRef.current) {
      dockLog("Container ref is null, skipping slot creation");
      return;
    }

    const container = offscreenContainerRef.current;
    const currentIds = new Set(dockTerminals.map((t) => t.id));

    // Create slots for new terminals
    for (const terminal of dockTerminals) {
      if (!offscreenSlotsRef.current.has(terminal.id)) {
        dockLog("Creating offscreen slot for terminal:", terminal.id);
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
        dockLog("Removing offscreen slot for terminal:", id);
        slot.remove();
        offscreenSlotsRef.current.delete(id);
      }
    }

    dockLog("After slot creation, slots:", Array.from(offscreenSlotsRef.current.keys()));

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
    dockLog("portalTarget called:", { terminalId, hasTarget: !!target });
    setPortalTargets((prev) => {
      const prevTarget = prev.get(terminalId);
      if (prevTarget === target) {
        dockLog("portalTarget: no change for", terminalId);
        return prev;
      }

      const next = new Map(prev);
      if (target) {
        dockLog("portalTarget: registering popover target for", terminalId);
        next.set(terminalId, target);
      } else {
        dockLog("portalTarget: unregistering popover target for", terminalId);
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
      <div
        ref={offscreenContainerRef}
        className="dock-panel-offscreen-container"
        style={{
          position: "fixed",
          left: "-20000px",
          top: 0,
          width: "1px",
          height: "1px",
          overflow: "hidden",
          opacity: 0,
          pointerEvents: "none",
          visibility: "hidden",
        }}
        aria-hidden="true"
      />

      {/* Render panels via portal - ALWAYS use portal to avoid unmount/remount */}
      {dockTerminals.map((terminal) => {
        // Use popover target if available, otherwise use offscreen slot
        const target = portalTargets.get(terminal.id);
        const offscreenSlot = offscreenSlotsRef.current.get(terminal.id);
        const portalContainer = target || offscreenSlot;

        dockLog("Rendering terminal:", {
          id: terminal.id,
          kind: terminal.kind,
          hasPopoverTarget: !!target,
          hasOffscreenSlot: !!offscreenSlot,
          portalContainer: portalContainer ? "available" : "null",
        });

        // Skip if no container yet (will render on next update after slots are created)
        if (!portalContainer) {
          dockLog("Skipping terminal (no container):", terminal.id);
          return null;
        }

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
            <DockedPanel terminal={terminal} onPopoverClose={handlePopoverClose} />
          </div>
        );

        // Always use createPortal with same key to prevent unmount/remount
        return createPortal(content, portalContainer, `dock-panel-${terminal.id}`);
      })}
    </DockPanelContext.Provider>
  );
}
