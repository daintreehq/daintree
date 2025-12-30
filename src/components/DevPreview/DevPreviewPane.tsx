import { useCallback, useEffect, useState, useRef } from "react";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { cn } from "@/lib/utils";
import { useTerminalStore } from "@/store";
import type { DevPreviewStatus } from "@shared/types/ipc/devPreview";
import { DevPreviewToolbar } from "./DevPreviewToolbar";

const STATUS_STYLES: Record<DevPreviewStatus, { label: string; dot: string; text: string }> = {
  installing: {
    label: "Installing",
    dot: "bg-[var(--color-status-warning)]",
    text: "text-[var(--color-status-warning)]",
  },
  starting: {
    label: "Starting",
    dot: "bg-[var(--color-status-info)]",
    text: "text-[var(--color-status-info)]",
  },
  running: {
    label: "Running",
    dot: "bg-[var(--color-status-success)]",
    text: "text-[var(--color-status-success)]",
  },
  error: {
    label: "Error",
    dot: "bg-[var(--color-status-error)]",
    text: "text-[var(--color-status-error)]",
  },
  stopped: {
    label: "Stopped",
    dot: "bg-canopy-text/40",
    text: "text-canopy-text/50",
  },
};

export interface DevPreviewPaneProps extends BasePanelProps {
  cwd: string;
}

export function DevPreviewPane({
  id,
  title,
  cwd,
  isFocused,
  isMaximized = false,
  location = "grid",
  onFocus,
  onClose,
  onToggleMaximize,
  onTitleChange,
  onMinimize,
  onRestore,
  isTrashing = false,
  gridPanelCount,
}: DevPreviewPaneProps) {
  const [status, setStatus] = useState<DevPreviewStatus>("starting");
  const [message, setMessage] = useState("Starting dev server...");
  const [error, setError] = useState<string | undefined>(undefined);
  const [url, setUrl] = useState<string | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const offStatus = window.electron.devPreview.onStatus((payload) => {
      if (payload.panelId !== id) return;
      setStatus(payload.status);
      setMessage(payload.message);
      setError(payload.status === "error" ? (payload.error ?? payload.message) : undefined);
      // Clear restarting state when we receive a terminal status (server responded)
      if (
        payload.status === "running" ||
        payload.status === "error" ||
        payload.status === "stopped"
      ) {
        setIsRestarting(false);
        if (restartTimeoutRef.current) {
          clearTimeout(restartTimeoutRef.current);
          restartTimeoutRef.current = null;
        }
      }
    });

    const offUrl = window.electron.devPreview.onUrl((payload) => {
      if (payload.panelId !== id) return;
      setUrl(payload.url);
    });

    return () => {
      offStatus();
      offUrl();
      if (restartTimeoutRef.current) {
        clearTimeout(restartTimeoutRef.current);
      }
    };
  }, [id]);

  useEffect(() => {
    setUrl(null);
    setError(undefined);
    setStatus("starting");
    setMessage("Starting dev server...");
    setIsRestarting(false);
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }

    const terminal = useTerminalStore.getState().getTerminal(id);
    const cols = terminal?.cols ?? 80;
    const rows = terminal?.rows ?? 24;

    void window.electron.devPreview.start(id, cwd, cols, rows);

    return () => {
      void window.electron.devPreview.stop(id);
    };
  }, [id, cwd]);

  const handleRestart = useCallback(() => {
    setUrl(null);
    setError(undefined);
    setStatus("starting");
    setMessage("Restarting dev server...");
    setIsRestarting(true);
    // Clear restarting after 10 seconds as a fallback
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
    }
    restartTimeoutRef.current = setTimeout(() => {
      setIsRestarting(false);
    }, 10000);
    void window.electron.devPreview.restart(id);
  }, [id]);

  const statusStyle = STATUS_STYLES[status];

  const devPreviewToolbar = (
    <DevPreviewToolbar
      status={status}
      url={url}
      isRestarting={isRestarting}
      onRestart={handleRestart}
    />
  );

  return (
    <ContentPanel
      id={id}
      title={title}
      kind="dev-preview"
      isFocused={isFocused}
      isMaximized={isMaximized}
      location={location}
      isTrashing={isTrashing}
      gridPanelCount={gridPanelCount}
      onFocus={onFocus}
      onClose={onClose}
      onToggleMaximize={onToggleMaximize}
      onTitleChange={onTitleChange}
      onMinimize={onMinimize}
      onRestore={onRestore}
      onRestart={handleRestart}
      toolbar={devPreviewToolbar}
    >
      <div className="flex flex-1 min-h-0 flex-col">
        <div className="relative flex-1 min-h-0 bg-white">
          {url ? (
            <iframe
              src={url}
              title={title}
              className="w-full h-full border-0"
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-canopy-bg">
              <div className="text-center max-w-md space-y-1 px-4">
                <div className="text-sm font-medium text-canopy-text">Dev Preview</div>
                <div className="text-xs text-canopy-text/60">{message}</div>
                {error && <div className="text-xs text-[var(--color-status-error)]">{error}</div>}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-t border-canopy-border bg-[color-mix(in_oklab,var(--color-surface)_92%,transparent)] text-xs text-canopy-text/70">
          <div className="flex items-center gap-2 min-w-0" role="status" aria-live="polite">
            <span className={cn("h-2 w-2 rounded-full shrink-0", statusStyle.dot)} />
            <span className={cn("font-medium", statusStyle.text)}>{statusStyle.label}</span>
            <span className="truncate">{message}</span>
          </div>
          {url && <span className="font-mono text-canopy-text/50 truncate max-w-[45%]">{url}</span>}
        </div>
      </div>
    </ContentPanel>
  );
}
