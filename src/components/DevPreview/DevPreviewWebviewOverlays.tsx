import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  Download,
  Eraser,
  ExternalLink,
  RotateCcw,
  RotateCw,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/Spinner";
import { PaneState, PaneStateActions } from "@/components/ui/PaneState";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InlineStatusBanner } from "../Terminal/InlineStatusBanner";
import { BannerOverflowMenu } from "../Terminal/BannerOverflowMenu";
import { BlockedNavBanner, type BlockedNavState, type BlockedNavAction } from "./BlockedNavBanner";
import { PaneLoadingState } from "@/components/ui/PaneLoadingState";
import { webviewLoadErrorHeading, type WebviewLoadError } from "./useDevPreviewLoadLifecycle";
import { FindBar } from "../Browser/FindBar";
import type { FindInPageState } from "@/hooks/useFindInPage";
import { WebviewDialog, type WebviewDialogRequest } from "../Browser/WebviewDialog";
import { SpinningIcon } from "@/components/ui/SpinningIcon";

interface DevPreviewWebviewOverlaysProps {
  reconnectAttempt: number;
  webviewLoadError: WebviewLoadError | null;
  certCopied: boolean;
  onCopyMkcert: () => void;
  isRestarting: boolean;
  onRestartDevServer: () => void;
  onHardReload: () => void;
  onRequestRestartAndClearCache: () => void;
  onRequestReinstallAndRestart: () => void;
  onRetryWebviewLoad: () => void;
  currentUrl: string;
  onOpenExternal: () => void;
  blockedNav: BlockedNavState | null;
  panelId: string;
  webviewElement: Electron.WebviewTag | null;
  onDispatchBlockedNav: (action: BlockedNavAction) => void;
  crashState: "none" | "crashed" | "unresponsive";
  crashDetails: { reason: string; exitCode: number } | null;
  onCloseCrash: () => void;
  onCloseUnresponsive: () => void;
  isLoading: boolean;
  onCancelLoad: () => void;
  showRecoverySpinner: boolean;
  isRecoveringFromEviction: boolean;
  isDragging: boolean;
  findInPage: FindInPageState;
  currentDialog: WebviewDialogRequest | null;
  onDialogRespond: (confirmed: boolean, response?: string) => void;
  /** The scale-wrapper div + `<webview>` element. Kept out of this component
   * so the ref callback wiring (`setWebviewNode`) and the webview node's
   * lifetime stay entirely in the parent — see the issue's "Watch" note on
   * preserving ref lifetimes across this split. */
  children: React.ReactNode;
}

/**
 * Renders every overlay layered on top of the live webview: the reconnect
 * toast, the load-error recovery panel, the blocked-navigation banner, the
 * crash/unresponsive banners, the loading and eviction-recovery spinners,
 * the drag veil, and find-in-page. The webview itself is passed in as
 * `children` by the parent.
 */
export function DevPreviewWebviewOverlays({
  reconnectAttempt,
  webviewLoadError,
  certCopied,
  onCopyMkcert,
  isRestarting,
  onRestartDevServer,
  onHardReload,
  onRequestRestartAndClearCache,
  onRequestReinstallAndRestart,
  onRetryWebviewLoad,
  currentUrl,
  onOpenExternal,
  blockedNav,
  panelId,
  webviewElement,
  onDispatchBlockedNav,
  crashState,
  crashDetails,
  onCloseCrash,
  onCloseUnresponsive,
  isLoading,
  onCancelLoad,
  showRecoverySpinner,
  isRecoveringFromEviction,
  isDragging,
  findInPage,
  currentDialog,
  onDialogRespond,
  children,
}: DevPreviewWebviewOverlaysProps) {
  return (
    <>
      {reconnectAttempt > 0 && !webviewLoadError && (
        <div
          role="status"
          className="absolute bottom-0 left-0 right-0 z-20 flex items-center justify-center gap-2 px-3 py-1.5 text-xs bg-surface-panel-elevated border-t border-border-default text-text-secondary"
        >
          <Spinner size="xs" />
          <span>Reconnecting (attempt {reconnectAttempt} of 5)…</span>
        </div>
      )}
      {webviewLoadError && (
        <PaneState
          live="alert"
          className="z-20"
          icon={<AlertTriangle className="text-status-warning" />}
          title={webviewLoadErrorHeading(webviewLoadError.code)}
          description={webviewLoadError.message}
        >
          <PaneStateActions>
            {webviewLoadError.code === "cert" && (
              <Button onClick={onCopyMkcert} variant="ghost" size="sm">
                {certCopied ? <Check /> : <Copy />}
                {certCopied ? "Copied" : "Copy `mkcert -install`"}
              </Button>
            )}
            {webviewLoadError.code === "connection_refused" ||
            webviewLoadError.code === "proxy_error" ? (
              <div className="flex items-center">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      onClick={onRestartDevServer}
                      variant="subtle"
                      size="sm"
                      disabled={isRestarting}
                      className="rounded-r-none"
                    >
                      <SpinningIcon icon={RotateCw} active={isRestarting} />
                      Restart dev server
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Restart dev server</TooltipContent>
                </Tooltip>
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="subtle"
                          size="sm"
                          disabled={isRestarting}
                          className="rounded-l-none border-l border-border-default px-1.5"
                          aria-label="More restart options"
                        >
                          <ChevronDown />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">More restart options</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent
                    align="end"
                    sideOffset={4}
                    className="min-w-[14rem] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
                  >
                    <DropdownMenuItem onSelect={onHardReload}>
                      <RotateCw data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                      Reload preview
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={onRestartDevServer}>
                      <RotateCcw data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                      Restart dev server
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={onRequestRestartAndClearCache}>
                      <Eraser data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                      Restart and clear cache
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={onRequestReinstallAndRestart}>
                      <Download data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                      Reinstall dependencies
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : (
              <Button onClick={onRetryWebviewLoad} variant="subtle" size="sm">
                <RotateCw />
                Retry
              </Button>
            )}
            {currentUrl && (
              <Button onClick={onOpenExternal} variant="ghost" size="sm">
                <ExternalLink />
                Open in external browser
              </Button>
            )}
          </PaneStateActions>
        </PaneState>
      )}
      <BlockedNavBanner
        state={blockedNav}
        panelId={panelId}
        webviewElement={webviewElement}
        onDispatch={onDispatchBlockedNav}
      />
      {crashState === "crashed" && (
        <InlineStatusBanner
          icon={XCircle}
          title="Preview process crashed"
          description={
            crashDetails
              ? `Reason: ${crashDetails.reason} (exit code ${crashDetails.exitCode})`
              : "The renderer process terminated unexpectedly."
          }
          severity="error"
          animated={false}
          action={{
            id: "reload",
            label: "Reload",
            icon: RotateCw,
            variant: "dangerFilled",
            onClick: onHardReload,
            ariaLabel: "Reload preview page",
          }}
          trailingSlot={
            <BannerOverflowMenu
              ariaLabel="More preview recovery options"
              actions={[
                {
                  id: "hard-restart",
                  label: "Hard restart",
                  icon: RotateCw,
                  onClick: onRestartDevServer,
                  ariaLabel: "Hard restart preview",
                },
              ]}
            />
          }
          onClose={onCloseCrash}
        />
      )}
      {crashState === "unresponsive" && (
        <InlineStatusBanner
          icon={AlertTriangle}
          title="Preview is not responding"
          description="The page may be stuck in a long-running operation."
          severity="warning"
          animated={false}
          actions={[
            {
              id: "hard-restart",
              label: "Hard restart",
              icon: RotateCw,
              variant: "danger",
              onClick: onRestartDevServer,
              ariaLabel: "Hard restart preview",
            },
          ]}
          onClose={onCloseUnresponsive}
        />
      )}
      {isLoading && (
        <PaneLoadingState
          variant="overlay"
          isLoading={isLoading}
          phaseLabel="Loading preview"
          onCancel={onCancelLoad}
        />
      )}
      {showRecoverySpinner && !webviewLoadError && (
        <PaneLoadingState
          variant="overlay"
          isLoading={isRecoveringFromEviction}
          phaseLabel="Rehydrating preview"
        />
      )}
      {isDragging && <div className="absolute inset-0 z-10 bg-transparent" />}
      {findInPage.isOpen && <FindBar find={findInPage} />}
      {/* Only the webview is scaled by zoom-to-fit; overlays above
            stay at full size relative to the outer container so
            their action buttons remain readable and clickable. */}
      {children}
      <WebviewDialog dialog={currentDialog} onRespond={onDialogRespond} />
    </>
  );
}
