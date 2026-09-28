import { useCallback, useRef, useState, useEffect, useLayoutEffect, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { TabErrorCount, UnderlineTabs } from "@/components/ui/UnderlineTabs";
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
} from "./DiagnosticsActions";
import type { RetryAction } from "@/store";
import { appClient } from "@/clients";
import { logError } from "@/utils/logger";

import { signalDiagnosticsDockLayoutChange } from "@/lib/diagnosticsDockLayout";

import { DIAGNOSTICS_DOCK_REGION_ID } from "./regionIds";

export { DIAGNOSTICS_DOCK_REGION_ID };

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

  // Pointer and keyboard activation share one path, so promoting errors when
  // Problems opens can't depend on how the tab was reached.
  const selectTab = useCallback(
    (tab: DiagnosticsTab) => {
      if (tab === "problems" && useDiagnosticsStore.getState().activeTab !== "problems") {
        useErrorStore.getState().promoteErrors();
      }
      setActiveTab(tab);
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

  const renderPanel = (tab: DiagnosticsTab) => {
    switch (tab) {
      case "problems":
        return <ProblemsContent onRetry={onRetry} onCancelRetry={onCancelRetry} />;
      case "logs":
        return <LogsContent />;
      case "events":
        return <EventsContent />;
      case "telemetry":
        return <TelemetryContent />;
      case "perf":
        return <PerfContent />;
      case "whySlow":
        return <WhySlowContent />;
    }
  };

  const tabs: { id: DiagnosticsTab; label: string; trailing?: ReactNode }[] = [
    {
      id: "problems",
      label: "Problems",
      trailing: errorCount > 0 ? <TabErrorCount count={errorCount} /> : undefined,
    },
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
          "outline-hidden focus-visible:bg-overlay-medium focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
          // Hover styling is off while resizing, or it outranks the drag state.
          isResizing ? "bg-overlay-medium" : "hover:bg-overlay-soft"
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
            "w-10 rounded-full transition-[height] duration-150 delay-100",
            // The focus outline is the accent; the grip stays neutral.
            isResizing
              ? "h-0.5 bg-text-primary/50"
              : "h-px bg-text-primary/15 group-hover:h-0.5 group-hover:bg-text-primary/30 group-focus-visible:h-0.5 group-focus-visible:bg-text-primary/50"
          )}
        />
      </div>

      <div className="flex h-8 shrink-0 items-stretch justify-between border-b border-overlay bg-daintree-sidebar/50 px-2">
        <UnderlineTabs
          tabs={tabs}
          activeId={activeTab}
          onChange={selectTab}
          aria-label="Diagnostics tabs"
          tabId={(id) => `diagnostics-${id}-tab`}
          panelId={(id) => `diagnostics-${id}-panel`}
          density="strip"
        />

        <div className="flex items-center gap-2">
          {activeTab === "problems" && <ProblemsActions />}
          {activeTab === "logs" && <LogsActions />}
          {activeTab === "events" && <EventsActions />}
          {activeTab === "telemetry" && <TelemetryActions />}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={closeDock}
                className="[&_svg]:size-3.5"
                aria-label="Close diagnostics dock"
              >
                <X />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Close diagnostics dock</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {tabs.map(({ id }) =>
          id === activeTab ? (
            <div
              key={id}
              id={`diagnostics-${id}-panel`}
              role="tabpanel"
              tabIndex={0}
              aria-labelledby={`diagnostics-${id}-tab`}
              className="h-full focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
            >
              {renderPanel(id)}
            </div>
          ) : (
            // Every tab's aria-controls has to resolve, so the inactive panels
            // stay as empty hidden stubs rather than disappearing.
            <div
              key={id}
              id={`diagnostics-${id}-panel`}
              role="tabpanel"
              aria-labelledby={`diagnostics-${id}-tab`}
              hidden
            />
          )
        )}
      </div>
    </div>
  );
}
