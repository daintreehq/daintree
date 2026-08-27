import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InlineStatusBanner } from "../Terminal/InlineStatusBanner";
import { BannerOverflowMenu } from "../Terminal/BannerOverflowMenu";
import { BlockedNavBanner, type BlockedNavState, type BlockedNavAction } from "./BlockedNavBanner";
import { DevPreviewLoadingState } from "./DevPreviewLoadingState";
import { webviewLoadErrorHeading, type WebviewLoadError } from "./useDevPreviewLoadLifecycle";
import { FindBar } from "../Browser/FindBar";
import type { FindInPageState } from "@/hooks/useFindInPage";
import { WebviewDialog, type WebviewDialogRequest } from "../Browser/WebviewDialog";
import { cn } from "@/lib/utils";

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
        <div className="absolute bottom-0 left-0 right-0 z-20 flex items-center justify-center gap-2 px-3 py-1.5 text-xs bg-status-info/10 border-t border-status-info/20 text-daintree-text/70">
          <Spinner size="xs" />
          <span>Reconnecting (attempt {reconnectAttempt} of 5)...</span>
        </div>
      )}
      {webviewLoadError && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-surface-canvas text-text-primary p-6">
          <AlertTriangle className="w-6 h-6 text-status-warning mb-3" />
          <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
            {webviewLoadErrorHeading(webviewLoadError.code)}
          </h3>
          <p className="text-xs text-daintree-text/50 text-center mb-3 max-w-md">
            {webviewLoadError.message}
          </p>
          <div className="flex items-center gap-1">
            {webviewLoadError.code === "cert" && (
              <Button
                onClick={onCopyMkcert}
                variant="ghost"
                size="sm"
                className="gap-1.5 px-2.5 py-1.5 group text-daintree-text/50 hover:text-daintree-text/70"
              >
                {certCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                <span className="text-xs">{certCopied ? "Copied" : "Copy `mkcert -install`"}</span>
              </Button>
            )}
            {webviewLoadError.code === "connection_refused" ||
            webviewLoadError.code === "proxy_error" ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      onClick={onRestartDevServer}
                      variant="ghost"
                      size="sm"
                      disabled={isRestarting}
                      className="gap-1.5 px-2.5 py-1.5 rounded-r-none group"
                    >
                      <RotateCw className={cn("h-3.5 w-3.5", isRestarting && "animate-spin")} />
                      <span className="text-xs">Restart dev server</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Restart dev server</TooltipContent>
                </Tooltip>
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isRestarting}
                          className="px-1.5 rounded-l-none group"
                          aria-label="More restart options"
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
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
                    <DropdownMenuItem onSelect={onHardReload}>Reload preview</DropdownMenuItem>
                    <DropdownMenuItem onSelect={onRestartDevServer}>
                      Restart dev server
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={onRequestRestartAndClearCache}>
                      Restart and clear cache
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={onRequestReinstallAndRestart}>
                      Reinstall dependencies
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
              <Button
                onClick={onRetryWebviewLoad}
                variant="ghost"
                size="sm"
                className="gap-1.5 px-2.5 py-1.5 group"
              >
                <RotateCw className="h-3.5 w-3.5" />
                <span className="text-xs">Retry</span>
              </Button>
            )}
            {currentUrl && (
              <Button
                onClick={onOpenExternal}
                variant="ghost"
                size="sm"
                className="gap-1.5 px-2.5 py-1.5 group text-daintree-text/50 hover:text-daintree-text/70"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span className="text-xs">Open external</span>
              </Button>
            )}
          </div>
        </div>
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
                  variant: "danger",
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
        <DevPreviewLoadingState
          variant="overlay"
          isLoading={isLoading}
          phaseLabel="Loading preview"
          onCancel={onCancelLoad}
        />
      )}
      {showRecoverySpinner && !webviewLoadError && (
        <DevPreviewLoadingState
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
