import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  Play,
  RotateCw,
  Settings,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineStatusBanner } from "../Terminal/InlineStatusBanner";
import { DevPreviewLoadingState } from "./DevPreviewLoadingState";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DevPreviewStatus } from "@/hooks/useDevServer";
import type { DevServerError } from "@shared/utils/devServerErrors";
import type { RunCommand } from "@shared/types";

interface DevPreviewEmptyStatesProps {
  isRestarting: boolean;
  status: DevPreviewStatus;
  isProxyUrlPending: boolean;
  phaseLabel?: "Compiling";
  error: DevServerError | null;
  handleRetry: () => void;
  setDevPreviewConsoleOpen: (id: string, open: boolean) => void;
  id: string;
  currentUrl: string;
  handleOpenExternal: () => void;
  isUnconfigured: boolean;
  primaryCandidate: RunCommand | undefined;
  isAutoDetecting: boolean;
  isSettingsLoading: boolean;
  handleAutoDetect: (candidateCommand?: string) => Promise<boolean>;
  autoDetectFailedCommand: string | null;
  candidates: RunCommand[];
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  handlePickCandidate: (candidate: { command: string }) => void;
  handleOpenSettings: () => void;
  commandInput: string;
  setCommandInput: (value: string) => void;
  handleSaveCommand: () => Promise<void>;
  commandInputError: string | null;
  devCommand: string;
  handleStartFromRestored: () => void;
  hasBeenVisible: boolean;
  isEvicted: boolean;
}

/**
 * Renders the non-webview states of the dev-preview surface: the full-pane
 * loading spinner, dev-server error, unconfigured/restored-stopped/waiting
 * placeholders, and the not-yet-visible/evicted placeholders. Callers gate
 * rendering this instead of the live webview via the same condition used
 * internally here, so the branch order below must stay in sync with that gate.
 */
export function DevPreviewEmptyStates({
  isRestarting,
  status,
  isProxyUrlPending,
  phaseLabel,
  error,
  handleRetry,
  setDevPreviewConsoleOpen,
  id,
  currentUrl,
  handleOpenExternal,
  isUnconfigured,
  primaryCandidate,
  isAutoDetecting,
  isSettingsLoading,
  handleAutoDetect,
  autoDetectFailedCommand,
  candidates,
  pickerOpen,
  setPickerOpen,
  handlePickCandidate,
  handleOpenSettings,
  commandInput,
  setCommandInput,
  handleSaveCommand,
  commandInputError,
  devCommand,
  handleStartFromRestored,
  hasBeenVisible,
  isEvicted,
}: DevPreviewEmptyStatesProps) {
  if (isRestarting || status === "starting" || status === "installing" || isProxyUrlPending) {
    return (
      <DevPreviewLoadingState
        variant="full"
        isLoading={true}
        phaseLabel={
          isRestarting
            ? "Restarting"
            : status === "installing"
              ? "Installing dependencies"
              : (phaseLabel ?? "Starting dev server")
        }
      />
    );
  }

  if (status === "error" && error) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6">
        <AlertTriangle className="w-6 h-6 text-status-warning mb-3" />
        <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
          {error.type === "port-conflict"
            ? "Port conflict"
            : error.type === "missing-dependencies"
              ? "Missing dependencies"
              : error.type === "permission"
                ? "Permission denied"
                : "Dev server error"}
        </h3>
        <p className="text-xs text-daintree-text/50 text-center mb-3 max-w-md">{error.message}</p>
        <div className="flex items-center gap-1">
          <Button
            onClick={handleRetry}
            variant="ghost"
            size="sm"
            className="gap-1.5 px-2.5 py-1.5 group"
          >
            <RotateCw className="h-3.5 w-3.5" />
            <span className="text-xs">
              {error.type === "missing-dependencies" ? "Retry install" : "Retry"}
            </span>
          </Button>
          {error.type === "missing-dependencies" || error.type === "permission" ? (
            <Button
              onClick={() => setDevPreviewConsoleOpen(id, true)}
              variant="ghost"
              size="sm"
              className="gap-1.5 px-2.5 py-1.5 group text-daintree-text/50 hover:text-daintree-text/70"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span className="text-xs">View terminal</span>
            </Button>
          ) : currentUrl ? (
            <Button
              onClick={handleOpenExternal}
              variant="ghost"
              size="sm"
              className="gap-1.5 px-2.5 py-1.5 group text-daintree-text/50 hover:text-daintree-text/70"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span className="text-xs">Open external</span>
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (!currentUrl || status !== "running") {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6">
        {isUnconfigured ? (
          <div className="flex flex-col items-center text-center max-w-md">
            {primaryCandidate ? (
              <>
                <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
                  Start the dev server
                </h3>
                <p className="text-xs text-daintree-text/50 mb-4 leading-relaxed">
                  We found a script in your package.json that looks like a dev server.
                </p>
                <div className="mb-3 px-3 py-1.5 rounded bg-overlay-subtle border border-overlay/30 inline-flex items-center gap-2">
                  <span className="text-[11px] text-daintree-text/40">Auto-detected</span>
                  <code className="text-xs text-daintree-text/70 font-mono">
                    {primaryCandidate.command}
                  </code>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <Button
                    onClick={() => void handleAutoDetect(primaryCandidate.command)}
                    disabled={isAutoDetecting || isSettingsLoading}
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 px-2.5 py-1.5 group text-accent-primary"
                  >
                    <Play className="h-3.5 w-3.5" />
                    <span className="text-xs">
                      {isAutoDetecting ? "Detecting..." : `Run \`${primaryCandidate.command}\``}
                    </span>
                  </Button>
                  {autoDetectFailedCommand !== null && (
                    <InlineStatusBanner
                      icon={XCircle}
                      severity="error"
                      title="Couldn't start preview"
                      description="The detected command couldn't be saved to project settings."
                      className="w-full rounded text-left"
                      action={{
                        id: "dev-preview-auto-detect-retry",
                        label: "Retry",
                        icon: RotateCw,
                        variant: "dangerFilled",
                        onClick: () =>
                          void handleAutoDetect(
                            autoDetectFailedCommand || primaryCandidate.command
                          ),
                      }}
                    />
                  )}
                  {candidates.length > 1 && (
                    <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-xs text-daintree-text/50 hover:text-daintree-text/70 transition-colors"
                        >
                          Use a different script...
                          <ChevronDown className="h-3 w-3" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent align="center" sideOffset={4} className="w-72 p-1">
                        <div className="flex flex-col max-h-64 overflow-y-auto">
                          {candidates.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => {
                                handlePickCandidate(c);
                                setPickerOpen(false);
                              }}
                              className="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-overlay-subtle transition-colors text-left"
                            >
                              <code className="text-daintree-text/70 font-mono text-[11px] flex-1 truncate">
                                {c.command}
                              </code>
                              <span className="text-daintree-text/40 shrink-0">{c.name}</span>
                            </button>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>
                  )}
                  <Button
                    onClick={handleOpenSettings}
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 px-2.5 py-1.5 group text-daintree-text/50 hover:text-daintree-text/70"
                  >
                    <Settings className="h-3.5 w-3.5" />
                    <span className="text-xs">Open project settings</span>
                  </Button>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
                  Set a dev command
                </h3>
                <p className="text-xs text-daintree-text/50 mb-4 leading-relaxed">
                  Configure a command to start a local development server.
                </p>
                <div className="flex flex-col items-center gap-2 w-full max-w-xs">
                  <input
                    type="text"
                    value={commandInput}
                    onChange={(e) => setCommandInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void handleSaveCommand();
                      }
                    }}
                    placeholder="npm run dev"
                    className="w-full px-2.5 py-1.5 text-xs font-mono bg-overlay-subtle border border-overlay/30 rounded text-daintree-text/70 placeholder:text-text-placeholder focus:outline-hidden focus:border-overlay/50 transition-[border-color,box-shadow]"
                  />
                  <Button
                    onClick={() => void handleSaveCommand()}
                    disabled={!commandInput.trim() || commandInputError !== null}
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 px-2.5 py-1.5 group text-accent-primary"
                  >
                    <Play className="h-3.5 w-3.5" />
                    <span className="text-xs">Run</span>
                  </Button>
                  {commandInput.trim() && commandInputError && (
                    <p className="text-[11px] text-status-warning">{commandInputError}</p>
                  )}
                </div>
                <Button
                  onClick={handleOpenSettings}
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 px-2.5 py-1.5 group text-daintree-text/50 hover:text-daintree-text/70 mt-3"
                >
                  <Settings className="h-3.5 w-3.5" />
                  <span className="text-xs">Open project settings</span>
                </Button>
              </>
            )}
          </div>
        ) : status === "restored-stopped" ? (
          <div className="flex flex-col items-center text-center max-w-md">
            <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
              Dev server was running
            </h3>
            <p className="text-xs text-daintree-text/50 mb-3 leading-relaxed">
              Daintree closed while this dev server was active. It wasn't reattached — restart to
              run it again.
            </p>
            {devCommand && (
              <div className="mb-3 px-3 py-1.5 rounded bg-overlay-subtle border border-overlay/30 inline-flex items-center gap-2">
                <code className="text-xs text-daintree-text/70 font-mono">{devCommand}</code>
              </div>
            )}
            <Button
              onClick={handleStartFromRestored}
              variant="ghost"
              size="sm"
              className="gap-1.5 px-2.5 py-1.5 group text-accent-primary"
            >
              <RotateCw className="h-3.5 w-3.5" />
              <span className="text-xs">Restart dev server</span>
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center text-center max-w-md">
            <h3 className="text-sm font-medium text-daintree-text/70 mb-1">
              Waiting for dev server
            </h3>
            <p className="text-xs text-daintree-text/50 mb-4 leading-relaxed">
              The development server will appear here once it starts and a URL is detected.
            </p>
          </div>
        )}
      </div>
    );
  }

  if (!hasBeenVisible) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text">
        <p className="text-xs text-daintree-text/50">
          Preview will load when this panel is first viewed
        </p>
      </div>
    );
  }

  if (isEvicted) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-daintree-bg text-daintree-text p-6">
        <p className="text-xs text-daintree-text/50">
          Preview paused to save memory — will reload when opened
        </p>
      </div>
    );
  }

  return null;
}
