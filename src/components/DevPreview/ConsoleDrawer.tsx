import { Suspense, useState, useCallback, useEffect, useRef } from "react";
import { ChevronUp, ChevronDown, RotateCw, CircleStop } from "lucide-react";
import { cn } from "@/lib/utils";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { XtermAdapter } from "../Terminal/XtermAdapter";
import { terminalInstanceService } from "../../services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import type { DevPreviewStatus } from "@/hooks/useDevServer";
import { useConsoleCaptureStore, ZERO_COUNTS } from "@/store/consoleCaptureStore";
import { ConsolePanel } from "./ConsolePanel";

export type ConsoleDrawerTab = "output" | "console";

interface ConsoleDrawerProps {
  terminalId: string;
  /** Panel ID — keys the guest-page console-capture store. */
  paneId: string;
  /** webContentsId of the live guest webview, for lazy object inspection. */
  webContentsId?: number;
  status?: DevPreviewStatus;
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  defaultOpen?: boolean;
  activeTab?: ConsoleDrawerTab;
  onTabChange?: (tab: ConsoleDrawerTab) => void;
  isRestarting?: boolean;
  onReloadPreview?: () => void;
  onRestartDevServer?: () => void;
  onRequestRestartAndClearCache?: () => void;
  onRequestReinstallAndRestart?: () => void;
  onStop?: () => void;
}

const STATUS_LABEL: Record<
  DevPreviewStatus,
  { label: string; textClass: string; dotClass: string }
> = {
  stopped: {
    label: "Stopped",
    textClass: "text-daintree-text/50",
    dotClass: "bg-daintree-text/40",
  },
  starting: {
    label: "Starting",
    textClass: "text-server-starting",
    dotClass: "bg-server-starting",
  },
  installing: {
    label: "Installing",
    textClass: "text-server-starting",
    dotClass: "bg-server-starting",
  },
  running: {
    label: "Running",
    textClass: "text-server-running",
    dotClass: "bg-server-running",
  },
  stopping: {
    label: "Stopping",
    textClass: "text-server-starting",
    dotClass: "bg-server-starting",
  },
  error: {
    label: "Error",
    textClass: "text-server-error",
    dotClass: "bg-server-error",
  },
};

const DRAWER_HEIGHT = 300;

interface DrawerTabButtonProps {
  tab: ConsoleDrawerTab;
  label: string;
  isActive: boolean;
  controlsId: string;
  onSelect: () => void;
  badge?: number;
}

function DrawerTabButton({
  tab,
  label,
  isActive,
  controlsId,
  onSelect,
  badge,
}: DrawerTabButtonProps) {
  return (
    <button
      type="button"
      id={`${controlsId}-tab`}
      data-tab={tab}
      onClick={onSelect}
      tabIndex={isActive ? 0 : -1}
      role="tab"
      aria-selected={isActive}
      aria-controls={controlsId}
      className={cn(
        "relative px-3 py-1.5 text-xs font-medium rounded transition-colors",
        "hover:text-daintree-text hover:bg-overlay-soft",
        "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-status-info",
        isActive ? "text-daintree-text" : "text-daintree-text/65"
      )}
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="ml-1.5 px-1.5 py-0.5 text-xs tabular-nums bg-status-error/15 text-status-error rounded-full">
          {badge}
        </span>
      )}
      {isActive && <div className="absolute bottom-0 left-0 right-0 h-px bg-daintree-text/70" />}
    </button>
  );
}

export function ConsoleDrawer({
  terminalId,
  paneId,
  webContentsId,
  status = "stopped",
  isOpen: controlledIsOpen,
  onOpenChange,
  defaultOpen = false,
  activeTab: controlledActiveTab,
  onTabChange,
  isRestarting = false,
  onReloadPreview,
  onRestartDevServer,
  onRequestRestartAndClearCache,
  onRequestReinstallAndRestart,
  onStop,
}: ConsoleDrawerProps) {
  const [uncontrolledIsOpen, setUncontrolledIsOpen] = useState(defaultOpen);
  const isOpen = controlledIsOpen ?? uncontrolledIsOpen;

  const [uncontrolledTab, setUncontrolledTab] = useState<ConsoleDrawerTab>("output");
  const activeTab = controlledActiveTab ?? uncontrolledTab;

  const tablistRef = useRef<HTMLDivElement>(null);

  const errorCount = useConsoleCaptureStore(
    (state) => (state.counters.get(paneId) ?? ZERO_COUNTS).errorCount
  );

  const toggleDrawer = useCallback(() => {
    const nextIsOpen = !isOpen;
    if (controlledIsOpen === undefined) {
      setUncontrolledIsOpen(nextIsOpen);
    }
    onOpenChange?.(nextIsOpen);
  }, [isOpen, controlledIsOpen, onOpenChange]);

  const selectTab = useCallback(
    (tab: ConsoleDrawerTab) => {
      if (controlledActiveTab === undefined) {
        setUncontrolledTab(tab);
      }
      onTabChange?.(tab);
    },
    [controlledActiveTab, onTabChange]
  );

  const handleTablistKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const container = tablistRef.current;
      if (!container) return;

      const tabButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
      const active = document.activeElement;
      const focusedIndex = active instanceof HTMLButtonElement ? tabButtons.indexOf(active) : -1;
      if (focusedIndex === -1) return;

      let nextIndex: number;
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
      const tabId = nextTab.dataset.tab;
      if (tabId === "output" || tabId === "console") selectTab(tabId);
    },
    [selectTab]
  );

  const isOutputVisible = isOpen && activeTab === "output";

  useEffect(() => {
    terminalInstanceService.setVisible(terminalId, isOutputVisible);
  }, [terminalId, isOutputVisible]);

  const getRefreshTier = useCallback(() => {
    return isOutputVisible ? TerminalRefreshTier.VISIBLE : TerminalRefreshTier.BACKGROUND;
  }, [isOutputVisible]);

  const statusLabel = isRestarting
    ? { label: "Restarting", textClass: "text-server-starting", dotClass: "bg-server-starting" }
    : (STATUS_LABEL[status] ?? STATUS_LABEL.stopped);
  const hasRestartControls = !!onRestartDevServer;
  const restartDisabled = !hasRestartControls || isRestarting || status === "starting";
  const chevronDisabled = restartDisabled;
  const restartTooltip =
    status === "installing"
      ? "Restart dev server (may interrupt installation)"
      : "Restart dev server";
  const stopVisible =
    onStop &&
    (status === "starting" ||
      status === "installing" ||
      status === "running" ||
      status === "stopping");
  const stopDisabled = isRestarting || status === "stopping";
  const statusClass = cn(
    "inline-flex min-h-8 items-center px-3 text-[10px] font-semibold uppercase tracking-wide",
    (hasRestartControls || stopVisible) && "border-r border-overlay/70",
    statusLabel.textClass
  );

  const drawerRegionId = `console-drawer-${terminalId}`;
  const outputPanelId = `dev-preview-output-panel-${terminalId}`;
  const consolePanelId = `dev-preview-console-panel-${terminalId}`;

  return (
    <div className="flex flex-col border-t border-overlay bg-surface">
      <div className="flex items-stretch bg-overlay-soft">
        <button
          type="button"
          onClick={toggleDrawer}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-2 border-r border-overlay/70 px-3 py-1.5 text-xs font-semibold text-daintree-text/80 transition-colors hover:bg-overlay-medium focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-status-info"
          aria-expanded={isOpen}
          aria-controls={drawerRegionId}
          aria-label="Toggle output drawer"
        >
          <ChevronUp
            className={cn("h-4 w-4 shrink-0 transition-transform", isOpen && "rotate-180")}
            aria-hidden="true"
          />
          <span className="truncate">Output drawer</span>
        </button>

        <div className={statusClass} role="status" aria-live="polite">
          <span className={cn("mr-2 h-1.5 w-1.5 shrink-0 rounded-full", statusLabel.dotClass)} />
          {statusLabel.label}
        </div>

        {stopVisible && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <button
                  type="button"
                  onClick={onStop}
                  disabled={stopDisabled}
                  className={cn(
                    "p-1.5 rounded hover:bg-overlay-medium disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none transition-colors",
                    status === "stopping" && "animate-pulse-immediate"
                  )}
                  aria-label="Stop dev server"
                  aria-busy={status === "stopping"}
                >
                  <CircleStop className="h-3.5 w-3.5" />
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">Stop dev server</TooltipContent>
          </Tooltip>
        )}

        {hasRestartControls && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <button
                    type="button"
                    onClick={onRestartDevServer}
                    disabled={restartDisabled}
                    className={cn(
                      "p-1.5 rounded-r-none hover:bg-overlay-medium disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none transition-colors",
                      isRestarting && "animate-spin"
                    )}
                    aria-label={restartTooltip}
                    aria-busy={isRestarting}
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                  </button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{restartTooltip}</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <span className="inline-flex">
                      <button
                        type="button"
                        disabled={chevronDisabled}
                        className={cn(
                          "p-1 rounded-l-none hover:bg-overlay-medium disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none transition-colors"
                        )}
                        aria-label="More restart options"
                        aria-disabled={chevronDisabled || undefined}
                        onClick={(e) => {
                          if (chevronDisabled) e.preventDefault();
                        }}
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">More restart options</TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                align="end"
                sideOffset={4}
                className="min-w-[14rem] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
              >
                <DropdownMenuItem onSelect={onReloadPreview}>Reload preview</DropdownMenuItem>
                <DropdownMenuItem onSelect={onRestartDevServer}>
                  Restart dev server
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={isRestarting || status === "installing"}
                  onSelect={onRequestRestartAndClearCache}
                >
                  Restart and clear cache
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={isRestarting || status === "installing"}
                  onSelect={onRequestReinstallAndRestart}
                >
                  Reinstall dependencies
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      <div
        id={drawerRegionId}
        className="overflow-hidden transition-[height]"
        style={{ height: isOpen ? DRAWER_HEIGHT : 0 }}
        aria-hidden={!isOpen}
      >
        <div className="flex h-full flex-col bg-surface-canvas">
          <div
            ref={tablistRef}
            role="tablist"
            aria-label="Dev preview console tabs"
            onKeyDown={handleTablistKeyDown}
            className="flex shrink-0 items-center gap-1 border-b border-overlay/70 bg-overlay-soft px-2"
          >
            <DrawerTabButton
              tab="output"
              label="Output"
              isActive={activeTab === "output"}
              controlsId={outputPanelId}
              onSelect={() => selectTab("output")}
            />
            <DrawerTabButton
              tab="console"
              label="Console"
              isActive={activeTab === "console"}
              controlsId={consolePanelId}
              onSelect={() => selectTab("console")}
              badge={errorCount}
            />
          </div>

          <div className="relative min-h-0 flex-1">
            <div
              id={outputPanelId}
              role="tabpanel"
              aria-labelledby={`${outputPanelId}-tab`}
              hidden={activeTab !== "output"}
              className="absolute inset-0"
            >
              <Suspense fallback={null}>
                <XtermAdapter
                  terminalId={terminalId}
                  getRefreshTier={getRefreshTier}
                  restoreOnAttach={true}
                  className="!rounded-none !px-0 !pt-0 !pb-0"
                />
              </Suspense>
            </div>
            {activeTab === "console" && (
              <div
                id={consolePanelId}
                role="tabpanel"
                aria-labelledby={`${consolePanelId}-tab`}
                className="absolute inset-0"
              >
                <ConsolePanel paneId={paneId} webContentsId={webContentsId} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
