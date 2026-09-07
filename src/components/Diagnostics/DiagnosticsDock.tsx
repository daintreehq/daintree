import { useCallback, useRef, useState, useEffect, useLayoutEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  useDiagnosticsStore,
  type DiagnosticsTab,
  DIAGNOSTICS_MIN_HEIGHT,
  DIAGNOSTICS_MAX_HEIGHT_RATIO,
  DIAGNOSTICS_DEFAULT_HEIGHT,
} from "@/store/diagnosticsStore";
import { useErrorStore } from "@/store";
import { ProblemsContent } from "./ProblemsContent";
import { LogsContent } from "./LogsContent";
import { EventsContent } from "./EventsContent";
import { TelemetryContent } from "./TelemetryContent";
import { PerfContent } from "./PerfContent";
import { WhySlowContent } from "./WhySlowContent";
import {
  ProblemsActions,
  LogsActions,
  EventsActions,
  TelemetryActions,
  PerfActions,
} from "./DiagnosticsActions";
import type { RetryAction } from "@/store";
import { appClient } from "@/clients";
import { logError } from "@/utils/logger";

import { signalDiagnosticsDockLayoutChange } from "@/lib/diagnosticsDockLayout";

import { DIAGNOSTICS_DOCK_REGION_ID } from "./regionIds";

export { DIAGNOSTICS_DOCK_REGION_ID };

interface TabButtonProps {
  tab: DiagnosticsTab;
  label: string;
  isActive: boolean;
  onClick: () => void;
  badge?: number;
}

function TabButton({ tab, label, isActive, onClick, badge }: TabButtonProps) {
  return (
    <button
      id={`diagnostics-${tab}-tab`}
      data-tab={tab}
      onClick={onClick}
      tabIndex={isActive ? 0 : -1}
      className={cn(
        "px-3 py-1.5 text-sm font-medium transition-colors relative rounded",
        "hover:text-text-primary hover:bg-overlay-soft",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-sidebar",
        isActive ? "text-text-primary" : "text-text-secondary"
      )}
      role="tab"
      aria-selected={isActive}
      aria-controls={`diagnostics-${tab}-panel`}
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="ml-1.5 px-1.5 py-0.5 text-xs tabular-nums bg-status-error/15 text-status-error rounded-full">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      {isActive && <div className="absolute bottom-0 left-0 right-0 h-px bg-daintree-text/30" />}
    </button>
  );
}

interface DiagnosticsDockProps {
  onRetry?: (id: string, action: RetryAction, args?: Record<string, unknown>) => void;
  onCancelRetry?: (id: string) => void;
  className?: string;
}

const RESIZE_STEP = 10;
const RESIZE_STEP_LARGE = 50;

export function DiagnosticsDock({ onRetry, onCancelRetry, className }: DiagnosticsDockProps) {
  const { isOpen, activeTab, height, maxHeight, closeDock, setActiveTab, setHeight, setMaxHeight } =
    useDiagnosticsStore(
      useShallow((s) => ({
        isOpen: s.isOpen,
        activeTab: s.activeTab,
        height: s.height,
        maxHeight: s.maxHeight,
        closeDock: s.closeDock,
        setActiveTab: s.setActiveTab,
        setHeight: s.setHeight,
        setMaxHeight: s.setMaxHeight,
      }))
    );
  const errorCount = useErrorStore((state) => state.errors.filter((e) => !e.dismissed).length);
  // The Perf tab carries no badge. The tab-badge style is the error tone shared
  // with Problems, and a perf number drifting past a reference value is not an
  // error — the suite gates nothing. Wearing that tone made every 2% drift look
  // like a fault and diluted the one badge that does mean something.
  // Auto-open on new errors lives in useDiagnosticsAutoOpen (always mounted in
  // AppLayout) — the dock is lazy-mounted, so a watcher here would never see
  // the first error.

  const [isResizing, setIsResizing] = useState(false);
  const resizeStartY = useRef(0);
  const resizeStartHeight = useRef(0);
  const outerRef = useRef<HTMLDivElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      resizeStartY.current = e.clientY;
      resizeStartHeight.current = height;
    },
    [height]
  );

  const handleResetHeight = useCallback(() => {
    setHeight(DIAGNOSTICS_DEFAULT_HEIGHT);
  }, [setHeight]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP;
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          setHeight(height + step);
          break;
        case "ArrowDown":
          e.preventDefault();
          setHeight(height - step);
          break;
        case "PageUp":
          e.preventDefault();
          setHeight(height + RESIZE_STEP_LARGE);
          break;
        case "PageDown":
          e.preventDefault();
          setHeight(height - RESIZE_STEP_LARGE);
          break;
        case "Home":
          e.preventDefault();
          setHeight(DIAGNOSTICS_MIN_HEIGHT);
          break;
        case "End":
          e.preventDefault();
          setHeight(maxHeight);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          setHeight(DIAGNOSTICS_DEFAULT_HEIGHT);
          break;
        default:
          return;
      }
    },
    [height, maxHeight, setHeight]
  );

  const handleTablistKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const container = tablistRef.current;
      if (!container) return;

      const tabButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
      const focusedIndex = tabButtons.indexOf(document.activeElement as HTMLButtonElement);
      if (focusedIndex === -1) return;

      let nextIndex: number | null = null;
      switch (e.key) {
        case "ArrowRight":
          nextIndex = (focusedIndex + 1) % tabButtons.length;
          break;
        case "ArrowLeft":
          nextIndex = (focusedIndex - 1 + tabButtons.length) % tabButtons.length;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = tabButtons.length - 1;
          break;
        default:
          return;
      }

      e.preventDefault();
      const nextTab = tabButtons[nextIndex];
      if (!nextTab) return;
      nextTab.focus();
      const tabId = nextTab.dataset.tab as DiagnosticsTab | undefined;
      if (tabId) setActiveTab(tabId);
    },
    [setActiveTab]
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = resizeStartY.current - e.clientY;
      const newHeight = resizeStartHeight.current + deltaY;
      setHeight(newHeight);
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

  // Track the available container height so aria-valuemax and the in-store
  // clamp stay accurate when the viewport or sidebars resize. Observe the
  // dock's parent (a flex column whose height is bounded by the viewport,
  // not by our own height) to avoid Chromium's ResizeObserver loop guard.
  useEffect(() => {
    if (!isOpen) return;
    const node = outerRef.current;
    const parent = node?.parentElement;
    if (!parent) return;

    const apply = (containerHeight: number) => {
      const next = Math.max(
        Math.floor(containerHeight * DIAGNOSTICS_MAX_HEIGHT_RATIO),
        DIAGNOSTICS_MIN_HEIGHT
      );
      setMaxHeight(next);
    };

    apply(parent.getBoundingClientRect().height);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const blockSize = entry.contentBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      apply(blockSize);
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [isOpen, setMaxHeight]);

  // #12264: the dock claims (or releases) its height from the same flex column
  // that holds the panel grid, so every commit that changes it is a reflow of
  // `<main>` and owes the grid the same protocol a sidebar transition does.
  // Published from a layout effect, not the store, for two reasons: the first
  // open resolves a lazy chunk, so `isOpen` flips a frame or more before any
  // dock DOM exists to measure against; and running post-commit means
  // subscribers read the settled box rather than the one before it. `activeTab`
  // is deliberately not a dependency — switching tabs moves nothing.
  useLayoutEffect(() => {
    signalDiagnosticsDockLayoutChange();
  }, [isOpen, height]);

  useEffect(() => {
    if (!isResizing && isOpen) {
      const timer = setTimeout(async () => {
        try {
          await appClient.setState({ diagnosticsHeight: height });
        } catch (error) {
          logError("Failed to persist diagnostics height", error);
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
        logError("Failed to restore diagnostics height", error);
      }
    };
    restoreHeight();
  }, [setHeight]);

  if (!isOpen) return null;

  const tabs: { id: DiagnosticsTab; label: string; badge?: number }[] = [
    { id: "problems", label: "Problems", badge: errorCount },
    { id: "logs", label: "Logs" },
    { id: "events", label: "Events" },
    { id: "telemetry", label: "Telemetry" },
    { id: "perf", label: "Perf" },
    { id: "whySlow", label: "Why slow?" },
  ];

  return (
    <div
      ref={outerRef}
      id={DIAGNOSTICS_DOCK_REGION_ID}
      className={cn(
        "diagnostics-dock flex flex-col border-t border-[var(--dock-border)] bg-[var(--dock-bg)]/95 backdrop-blur-sm shadow-[var(--dock-shadow)]",
        isResizing && "select-none",
        className
      )}
      style={{ height }}
      data-resizing={isResizing ? "true" : undefined}
      role="region"
      aria-label="Diagnostics dock"
    >
      <div
        className={cn(
          "group h-3 cursor-ns-resize transition-colors flex items-center justify-center",
          "hover:bg-overlay-soft focus-visible:outline-hidden focus-visible:bg-overlay-medium focus-visible:ring-1 focus-visible:ring-daintree-accent/50",
          isResizing && "bg-overlay-medium"
        )}
        onMouseDown={handleResizeStart}
        onDoubleClick={handleResetHeight}
        onKeyDown={handleKeyDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize diagnostics dock (double-click to reset)"
        aria-valuenow={Math.round(height)}
        aria-valuemin={DIAGNOSTICS_MIN_HEIGHT}
        aria-valuemax={Math.round(maxHeight)}
        tabIndex={0}
      >
        <div
          className={cn(
            "w-10 h-px rounded-full transition-[height] duration-150 delay-100 group-hover:h-0.5",
            "bg-daintree-text/15",
            "group-hover:bg-daintree-text/30 group-focus-visible:bg-accent-primary",
            isResizing && "bg-daintree-text/50"
          )}
        />
      </div>

      <div className="flex items-center justify-between px-4 h-10 border-b border-[var(--dock-border)] bg-daintree-sidebar/50 shrink-0">
        <div
          ref={tablistRef}
          className="flex items-center gap-2"
          role="tablist"
          aria-label="Diagnostics tabs"
          onKeyDown={handleTablistKeyDown}
        >
          {tabs.map((tab) => (
            <TabButton
              key={tab.id}
              tab={tab.id}
              label={tab.label}
              isActive={activeTab === tab.id}
              onClick={() => {
                if (tab.id === "problems" && activeTab !== "problems") {
                  useErrorStore.getState().promoteErrors();
                }
                setActiveTab(tab.id);
              }}
              badge={tab.badge}
            />
          ))}
        </div>

        <div className="flex items-center gap-2">
          {activeTab === "problems" && <ProblemsActions />}
          {activeTab === "logs" && <LogsActions />}
          {activeTab === "events" && <EventsActions />}
          {activeTab === "telemetry" && <TelemetryActions />}
          {activeTab === "perf" && <PerfActions />}

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={closeDock}
                className="p-1.5 hover:bg-tint/[0.06] rounded-[var(--radius-md)] transition-colors text-daintree-text/60 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                aria-label="Close diagnostics dock"
              >
                <X className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Close diagnostics dock</TooltipContent>
          </Tooltip>
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
            <ProblemsContent onRetry={onRetry} onCancelRetry={onCancelRetry} />
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
        {activeTab === "telemetry" && (
          <div
            id="diagnostics-telemetry-panel"
            role="tabpanel"
            aria-labelledby="diagnostics-telemetry-tab"
            className="h-full"
          >
            <TelemetryContent />
          </div>
        )}
        {activeTab === "perf" && (
          <div
            id="diagnostics-perf-panel"
            role="tabpanel"
            aria-labelledby="diagnostics-perf-tab"
            className="h-full"
          >
            <PerfContent />
          </div>
        )}
        {activeTab === "whySlow" && (
          <div
            id="diagnostics-whySlow-panel"
            role="tabpanel"
            aria-labelledby="diagnostics-whySlow-tab"
            className="h-full"
          >
            <WhySlowContent />
          </div>
        )}
      </div>
    </div>
  );
}
