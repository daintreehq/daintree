import { useEffect, createContext, useContext, useCallback, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore, useWorktreeSelectionStore } from "@/store";
import { DockedPanel } from "@/components/Terminal/DockedPanel";

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
  const portalTargetsRef = useRef(new Map<string, HTMLElement>());
  const [, forceUpdate] = useState(0);

  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  const dockTerminals = useTerminalStore(
    useShallow((s) =>
      s.terminals.filter(
        (t) =>
          t.location === "dock" && (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      )
    )
  );

  const closeDockTerminal = useTerminalStore((s) => s.closeDockTerminal);

  const handlePopoverClose = useCallback(() => {
    closeDockTerminal();
  }, [closeDockTerminal]);

  // Cleanup portal targets for removed terminals
  useEffect(() => {
    const currentIds = new Set(dockTerminals.map((t) => t.id));
    const targetsToRemove: string[] = [];

    portalTargetsRef.current.forEach((_, id) => {
      if (!currentIds.has(id)) {
        targetsToRemove.push(id);
      }
    });

    if (targetsToRemove.length > 0) {
      targetsToRemove.forEach((id) => {
        portalTargetsRef.current.delete(id);
      });
      forceUpdate((n) => n + 1);
    }
  }, [dockTerminals]);

  const portalTarget = useCallback((terminalId: string, target: HTMLElement | null) => {
    const prev = portalTargetsRef.current.get(terminalId);
    if (prev === target) return;

    if (target) {
      portalTargetsRef.current.set(terminalId, target);
    } else {
      portalTargetsRef.current.delete(terminalId);
    }
    forceUpdate((n) => n + 1);
  }, []);

  const contextValue: DockPanelContextValue = {
    portalTarget,
  };

  return (
    <DockPanelContext.Provider value={contextValue}>
      {children}

      {/* Hidden container for dock panels - keeps them mounted */}
      <div
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
      >
        {dockTerminals.map((terminal) => {
          const target = portalTargetsRef.current.get(terminal.id);

          // Always use portal to avoid remounting when switching between offscreen and popover
          // If no target is set, portal to a stable slot in the offscreen container
          const portalContainer = target || (() => {
            // Create or get stable offscreen slot for this terminal
            let slot = document.querySelector(`[data-offscreen-slot="${terminal.id}"]`);
            if (!slot) {
              slot = document.createElement("div");
              slot.setAttribute("data-offscreen-slot", terminal.id);
              slot.className = "offscreen-panel-slot";
              const hiddenContainer = document.querySelector(".dock-panel-offscreen-container");
              hiddenContainer?.appendChild(slot);
            }
            return slot;
          })();

          const content = (
            <div
              key={terminal.id}
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

          return createPortal(content, portalContainer, `dock-panel-${terminal.id}`);
        })}
      </div>
    </DockPanelContext.Provider>
  );
}
