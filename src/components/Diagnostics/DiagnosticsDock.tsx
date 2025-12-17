import { useCallback, useRef, useState, useEffect, memo } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useDiagnosticsStore,
  type DiagnosticsTab,
  DIAGNOSTICS_MIN_HEIGHT,
  DIAGNOSTICS_MAX_HEIGHT_RATIO,
} from "@/store/diagnosticsStore";
import { useErrorStore } from "@/store";
import { ProblemsContent } from "./ProblemsContent";
import { LogsContent } from "./LogsContent";
import { EventsContent } from "./EventsContent";
import { ProblemsActions, LogsActions, EventsActions } from "./DiagnosticsActions";
import type { RetryAction } from "@/store";
import { appClient } from "@/clients";

interface TabButtonProps {
  tab: DiagnosticsTab;
  label: string;
  isActive: boolean;
  onClick: () => void;
  badge?: number;
}

const TabButton = memo(function TabButton({
  tab,
  label,
  isActive,
  onClick,
  badge,
}: TabButtonProps) {
  return (
    <button
      id={`diagnostics-${tab}-tab`}
      onClick={onClick}
      className={cn(
        "px-3 py-1.5 text-sm font-medium transition-colors relative rounded",
        "hover:text-canopy-text",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canopy-sidebar",
        isActive ? "text-canopy-text" : "text-canopy-text/60"
      )}
      role="tab"
      aria-selected={isActive}
      aria-controls={`diagnostics-${tab}-panel`}
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-red-900/50 text-red-300 rounded-full">
          {badge}
        </span>
      )}
      {isActive && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-canopy-accent" />}
    </button>
  );
});

interface DiagnosticsDockProps {
  onRetry?: (id: string, action: RetryAction, args?: Record<string, unknown>) => void;
  className?: string;
}

export function DiagnosticsDock({ onRetry, className }: DiagnosticsDockProps) {
  const { isOpen, activeTab, height, openDock, closeDock, setActiveTab, setHeight } =
    useDiagnosticsStore();
  const errorCount = useErrorStore((state) => state.errors.filter((e) => !e.dismissed).length);
  const prevErrorCountRef = useRef(0);

  useEffect(() => {
    if (errorCount > 0 && prevErrorCountRef.current === 0 && !isOpen) {
      openDock("problems");
    }
    prevErrorCountRef.current = errorCount;
  }, [errorCount, isOpen, openDock]);

  const [isResizing, setIsResizing] = useState(false);
  const resizeStartY = useRef(0);
  const resizeStartHeight = useRef(0);

  const RESIZE_STEP = 10;

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      resizeStartY.current = e.clientY;
      resizeStartHeight.current = height;
    },
    [height]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const maxHeight = window.innerHeight * DIAGNOSTICS_MAX_HEIGHT_RATIO;
        const newHeight = Math.min(height + RESIZE_STEP, maxHeight);
        setHeight(newHeight);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const newHeight = Math.max(height - RESIZE_STEP, DIAGNOSTICS_MIN_HEIGHT);
        setHeight(newHeight);
      }
    },
    [height, setHeight]
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = resizeStartY.current - e.clientY;
      const newHeight = resizeStartHeight.current + deltaY;
      const maxHeight = window.innerHeight * DIAGNOSTICS_MAX_HEIGHT_RATIO;
      const clampedHeight = Math.min(Math.max(newHeight, DIAGNOSTICS_MIN_HEIGHT), maxHeight);
      setHeight(clampedHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, setHeight]);

  useEffect(() => {
    if (!isResizing && isOpen) {
      const timer = setTimeout(async () => {
        try {
          await appClient.setState({ diagnosticsHeight: height });
        } catch (error) {
          console.error("Failed to persist diagnostics height:", error);
        }
      }, 300);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [height, isResizing, isOpen]);

  useEffect(() => {
    const restoreHeight = async () => {
      try {
        const appState = await appClient.getState();
        if (appState?.diagnosticsHeight) {
          setHeight(appState.diagnosticsHeight);
        }
      } catch (error) {
        console.error("Failed to restore diagnostics height:", error);
      }
    };
    restoreHeight();
  }, [setHeight]);

  if (!isOpen) return null;

  const tabs: { id: DiagnosticsTab; label: string; badge?: number }[] = [
    { id: "problems", label: "Problems", badge: errorCount },
    { id: "logs", label: "Logs" },
    { id: "events", label: "Events" },
  ];

  return (
    <div
      className={cn(
        "flex flex-col border-t border-white/[0.08] bg-canopy-bg/95 backdrop-blur-sm shadow-[0_-2px_8px_rgba(0,0,0,0.2)]",
        "transition-[height] duration-200 ease-out",
        isResizing && "select-none",
        className
      )}
      style={{ height }}
      role="region"
      aria-label="Diagnostics dock"
    >
      <div
        className={cn(
          "group h-1.5 cursor-ns-resize transition-colors flex items-center justify-center",
          "hover:bg-canopy-accent/30 focus-visible:outline-none focus-visible:bg-canopy-accent/50",
          isResizing && "bg-canopy-accent/50"
        )}
        onMouseDown={handleResizeStart}
        onKeyDown={handleKeyDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize diagnostics dock"
        aria-valuenow={Math.round(height)}
        aria-valuemin={DIAGNOSTICS_MIN_HEIGHT}
        aria-valuemax={Math.round(window.innerHeight * DIAGNOSTICS_MAX_HEIGHT_RATIO)}
        tabIndex={0}
      >
        <div
          className={cn(
            "w-8 h-0.5 rounded-full transition-colors",
            "bg-canopy-text/20",
            "group-hover:bg-canopy-accent/70 group-focus:bg-canopy-accent",
            isResizing && "bg-canopy-accent"
          )}
        />
      </div>

      <div className="flex items-center justify-between px-4 h-9 border-b border-white/[0.06] bg-canopy-sidebar shrink-0">
        <div className="flex items-center gap-2" role="tablist" aria-label="Diagnostics tabs">
          {tabs.map((tab) => (
            <TabButton
              key={tab.id}
              tab={tab.id}
              label={tab.label}
              isActive={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              badge={tab.badge}
            />
          ))}
        </div>

        <div className="flex items-center gap-2">
          {activeTab === "problems" && <ProblemsActions />}
          {activeTab === "logs" && <LogsActions />}
          {activeTab === "events" && <EventsActions />}

          <button
            onClick={closeDock}
            className="p-1.5 hover:bg-canopy-border rounded transition-colors text-canopy-text/60 hover:text-canopy-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
            title="Close diagnostics dock"
            aria-label="Close diagnostics dock"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {activeTab === "problems" && (
          <div
            id="diagnostics-problems-panel"
            role="tabpanel"
            aria-labelledby="diagnostics-problems-tab"
            className="h-full"
          >
            <ProblemsContent onRetry={onRetry} />
          </div>
        )}
        {activeTab === "logs" && (
          <div
            id="diagnostics-logs-panel"
            role="tabpanel"
            aria-labelledby="diagnostics-logs-tab"
            className="h-full"
          >
            <LogsContent />
          </div>
        )}
        {activeTab === "events" && (
          <div
            id="diagnostics-events-panel"
            role="tabpanel"
            aria-labelledby="diagnostics-events-tab"
            className="h-full"
          >
            <EventsContent />
          </div>
        )}
      </div>
    </div>
  );
}
