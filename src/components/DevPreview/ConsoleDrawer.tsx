import { Suspense, useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { ChevronUp, MoreHorizontal, RotateCw, CircleStop } from "lucide-react";
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
import { usePanelStore } from "@/store/panelStore";
import { ConsolePanel } from "./ConsolePanel";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { TabErrorCount, UnderlineTabs } from "@/components/ui/UnderlineTabs";
import {
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_ICON_CLASS,
} from "@/components/ui/paneToolbarStyles";

export type ConsoleDrawerTab = "output" | "console" | "diagnostics";

interface ConsoleDrawerProps {
  terminalId: string;
  /** Panel ID — keys the guest-page console-capture store. */
  paneId: string;
  /** Project ID — required by the diagnostics IPC query. */
  projectId?: string;
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
  /**
   * False while the host panel is parked (docked with its popover closed). The
   * drawer stays mounted there, so without this the Output terminal would keep
   * its visible refresh tier behind a closed popover.
   */
  isPanelVisible?: boolean;
}

const STATUS_LABEL: Record<
  DevPreviewStatus,
  { label: string; textClass: string; dotClass: string }
> = {
  stopped: {
    label: "Stopped",
    textClass: "text-text-secondary",
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
  "restored-stopped": {
    label: "Stopped",
    textClass: "text-text-secondary",
    dotClass: "bg-daintree-text/40",
  },
};

const DRAWER_HEIGHT = 300;

export function ConsoleDrawer({
  terminalId,
  paneId,
  projectId,
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
  isPanelVisible = true,
}: ConsoleDrawerProps) {
  const [uncontrolledIsOpen, setUncontrolledIsOpen] = useState(defaultOpen);
  const isOpen = controlledIsOpen ?? uncontrolledIsOpen;

  const [uncontrolledTab, setUncontrolledTab] = useState<ConsoleDrawerTab>("output");
  const activeTab = controlledActiveTab ?? uncontrolledTab;

  const regionRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

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

  // Closing makes the region inert, and focus inside an inert subtree falls to
  // <body>. Hand it to the toggle before paint, whoever closed the drawer.
  useLayoutEffect(() => {
    if (!isOpen && regionRef.current?.contains(document.activeElement)) {
      toggleRef.current?.focus();
    }
  }, [isOpen]);

  const selectTab = useCallback(
    (tab: ConsoleDrawerTab) => {
      if (controlledActiveTab === undefined) {
        setUncontrolledTab(tab);
      }
      onTabChange?.(tab);
    },
    [controlledActiveTab, onTabChange]
  );

  const isOutputVisible = isPanelVisible && isOpen && activeTab === "output";

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
    "inline-flex min-h-8 items-center px-3 text-3xs font-semibold uppercase tracking-wide",
    (hasRestartControls || stopVisible) && "border-r border-overlay",
    statusLabel.textClass
  );

  const drawerRegionId = `console-drawer-${terminalId}`;
  const outputPanelId = `dev-preview-output-panel-${terminalId}`;
  const consolePanelId = `dev-preview-console-panel-${terminalId}`;
  const diagnosticsPanelId = `dev-preview-diagnostics-panel-${terminalId}`;
  const panelIds: Record<ConsoleDrawerTab, string> = {
    output: outputPanelId,
    console: consolePanelId,
    diagnostics: diagnosticsPanelId,
  };

  return (
    <div className="flex flex-col border-t border-overlay bg-surface">
      <div className="flex items-stretch bg-overlay-soft">
        <button
          ref={toggleRef}
          type="button"
          onClick={toggleDrawer}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-2 border-r border-overlay px-3 py-1.5 text-xs font-semibold text-text-primary transition-colors duration-150 ease-out hover:bg-overlay-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
          aria-expanded={isOpen}
          aria-controls={drawerRegionId}
          aria-label="Toggle output drawer"
        >
          <ChevronUp
            data-animated-chevron
            className={cn(
              "h-4 w-4 shrink-0 transition-transform duration-150 ease-out",
              isOpen && "rotate-180"
            )}
            aria-hidden="true"
          />
          <span className="truncate">Output drawer</span>
        </button>

        <div className={statusClass} role="status" aria-live="polite">
          <span
            className={cn(
              "status-mark mr-2 h-1.5 w-1.5 shrink-0 rounded-full",
              statusLabel.dotClass
            )}
          />
          {statusLabel.label}
        </div>

        {(stopVisible || hasRestartControls) && (
          <div className="flex items-center gap-0.5 px-1">
            {stopVisible && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <button
                      type="button"
                      onClick={onStop}
                      disabled={stopDisabled}
                      className={cn(
                        PANE_TOOLBAR_ICON_BUTTON_CLASS,
                        status === "stopping" && "animate-pulse-immediate"
                      )}
                      aria-label="Stop dev server"
                      aria-busy={status === "stopping"}
                    >
                      <CircleStop className={PANE_TOOLBAR_ICON_CLASS} />
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
                        className={PANE_TOOLBAR_ICON_BUTTON_CLASS}
                        aria-label={restartTooltip}
                        aria-busy={isRestarting}
                      >
                        <SpinningIcon
                          icon={RotateCw}
                          active={isRestarting}
                          className={PANE_TOOLBAR_ICON_CLASS}
                        />
                      </button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{restartTooltip}</TooltipContent>
                </Tooltip>
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {/* The span carries the tooltip, so it still answers hover
                          while the button is disabled; the menu trigger sits on
                          the button itself, where focus and aria-expanded are. */}
                      <span className="inline-flex">
                        <DropdownMenuTrigger asChild disabled={chevronDisabled}>
                          <button
                            type="button"
                            className={PANE_TOOLBAR_ICON_BUTTON_CLASS}
                            aria-label="More restart options"
                          >
                            <MoreHorizontal className={PANE_TOOLBAR_ICON_CLASS} />
                          </button>
                        </DropdownMenuTrigger>
                      </span>
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
        )}
      </div>

      <div
        ref={regionRef}
        id={drawerRegionId}
        className="console-drawer-region overflow-hidden"
        style={{ height: isOpen ? DRAWER_HEIGHT : 0 }}
        data-state={isOpen ? "open" : "closed"}
        aria-hidden={!isOpen}
        // Collapsed to zero height is not enough on its own: the tabs and the
        // console toolbar would still be tab stops nobody can see.
        inert={!isOpen}
      >
        <div className="flex h-full flex-col bg-surface-canvas">
          <div className="flex h-8 shrink-0 items-stretch border-b border-overlay bg-surface px-2">
            <UnderlineTabs
              tabs={[
                { id: "output", label: "Output" },
                {
                  id: "console",
                  label: "Console",
                  trailing: errorCount > 0 ? <TabErrorCount count={errorCount} /> : undefined,
                },
                { id: "diagnostics", label: "Diagnostics" },
              ]}
              activeId={activeTab}
              onChange={selectTab}
              aria-label="Dev preview console tabs"
              tabId={(id) => `${panelIds[id]}-tab`}
              panelId={(id) => panelIds[id]}
              density="strip"
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
                  // The console runs its own PTY inside this panel, so a drop
                  // has to select the panel rather than the terminal it landed
                  // in — `terminalId` names nothing the grid can select
                  // (#11809). Without this the drop would move DOM focus here
                  // while the selection stayed on whatever pane had it.
                  onDropSelect={() => usePanelStore.getState().setFocused(paneId)}
                  className="!rounded-none !px-0 !pt-0 !pb-0"
                />
              </Suspense>
            </div>
            {/* The panels stay in the tree so every tab's aria-controls resolves;
                only their content mounts on demand. */}
            <div
              id={consolePanelId}
              role="tabpanel"
              aria-labelledby={`${consolePanelId}-tab`}
              hidden={activeTab !== "console"}
              className="absolute inset-0"
            >
              {activeTab === "console" && (
                <ConsolePanel paneId={paneId} webContentsId={webContentsId} />
              )}
            </div>
            <div
              id={diagnosticsPanelId}
              role="tabpanel"
              aria-labelledby={`${diagnosticsPanelId}-tab`}
              hidden={activeTab !== "diagnostics"}
              className="absolute inset-0"
            >
              {activeTab === "diagnostics" && (
                <DiagnosticsPanel paneId={paneId} projectId={projectId} status={status} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
