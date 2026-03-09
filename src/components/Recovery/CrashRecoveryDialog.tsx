import { useState, useCallback } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, FileText } from "lucide-react";
import { AppDialog } from "../ui/AppDialog";
import { Button } from "../ui/button";
import type { PendingCrash, CrashRecoveryAction, CrashRecoveryConfig } from "@shared/types/ipc";

const ISSUES_URL = "https://github.com/canopyide/canopy/issues/new";

interface CrashRecoveryDialogProps {
  crash: PendingCrash;
  config: CrashRecoveryConfig;
  onResolve: (action: CrashRecoveryAction) => Promise<void>;
  onUpdateConfig: (patch: Partial<CrashRecoveryConfig>) => Promise<void>;
}

export function CrashRecoveryDialog({
  crash,
  config,
  onResolve,
  onUpdateConfig,
}: CrashRecoveryDialogProps) {
  const [resolving, setResolving] = useState<CrashRecoveryAction | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [privacyWarningShown, setPrivacyWarningShown] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleResolve = useCallback(
    async (action: CrashRecoveryAction) => {
      if (resolving) return;
      setResolving(action);
      try {
        await onResolve(action);
      } finally {
        setResolving(null);
      }
    },
    [resolving, onResolve]
  );

  const handleOpenLogFile = useCallback(() => {
    window.electron.system.openPath(crash.logPath).catch(console.error);
  }, [crash.logPath]);

  const handleReport = useCallback(() => {
    if (!privacyWarningShown) {
      setPrivacyWarningShown(true);
      return;
    }
    const text = buildClipboardText(crash);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
    window.electron.system.openExternal(ISSUES_URL).catch(console.error);
  }, [privacyWarningShown, crash]);

  const handleAutoRestore = useCallback(
    async (checked: boolean) => {
      await onUpdateConfig({ autoRestoreOnCrash: checked });
    },
    [onUpdateConfig]
  );

  const backupDate = crash.backupTimestamp
    ? new Date(crash.backupTimestamp).toLocaleString()
    : null;

  const crashDate = new Date(crash.entry.timestamp).toLocaleString();

  return (
    <AppDialog
      isOpen={true}
      onClose={() => {}}
      dismissible={false}
      size="md"
      data-testid="crash-recovery-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<AlertTriangle className="h-5 w-5 text-amber-400" />}>
          Canopy Crashed
        </AppDialog.Title>
      </AppDialog.Header>

      <AppDialog.Body className="space-y-4">
        <p className="text-sm text-canopy-text/80">
          The previous session ended unexpectedly on {crashDate}. Choose how to continue:
        </p>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => handleResolve("restore")}
            disabled={resolving !== null}
            className="flex items-start gap-3 p-3 rounded-lg border border-canopy-border hover:border-canopy-accent hover:bg-overlay-soft text-left transition-colors disabled:opacity-50 disabled:pointer-events-none"
            data-testid="restore-button"
          >
            <div className="mt-0.5 h-5 w-5 rounded-full bg-canopy-accent/20 flex items-center justify-center shrink-0">
              <div className="h-2 w-2 rounded-full bg-canopy-accent" />
            </div>
            <div>
              <div className="text-sm font-medium text-canopy-text">Restore Previous Session</div>
              {backupDate ? (
                <div className="text-xs text-canopy-text/60 mt-0.5">
                  Restore session from {backupDate}
                </div>
              ) : (
                <div className="text-xs text-canopy-text/60 mt-0.5">
                  No backup available — layout may be empty
                </div>
              )}
            </div>
          </button>

          <button
            type="button"
            onClick={() => handleResolve("fresh")}
            disabled={resolving !== null}
            className="flex items-start gap-3 p-3 rounded-lg border border-canopy-border hover:border-canopy-border/80 hover:bg-overlay-soft text-left transition-colors disabled:opacity-50 disabled:pointer-events-none"
            data-testid="fresh-button"
          >
            <div className="mt-0.5 h-5 w-5 rounded-full bg-canopy-text/10 flex items-center justify-center shrink-0">
              <div className="h-2 w-2 rounded-full bg-canopy-text/40" />
            </div>
            <div>
              <div className="text-sm font-medium text-canopy-text">Start Fresh</div>
              <div className="text-xs text-canopy-text/60 mt-0.5">
                Reset to a clean layout — open panels will be cleared
              </div>
            </div>
          </button>
        </div>

        <div className="border border-canopy-border rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setDetailsOpen((o) => !o)}
            className="w-full flex items-center justify-between px-3 py-2 text-sm text-canopy-text/70 hover:text-canopy-text hover:bg-overlay-soft transition-colors"
            data-testid="details-toggle"
          >
            <span className="font-medium">Error Details</span>
            {detailsOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>

          {detailsOpen && (
            <div
              className="px-3 pb-3 space-y-2 border-t border-canopy-border"
              data-testid="details-section"
            >
              <DetailRow label="App version" value={crash.entry.appVersion} />
              <DetailRow label="Platform" value={`${crash.entry.platform} ${crash.entry.arch}`} />
              <DetailRow label="OS version" value={crash.entry.osVersion} />
              {crash.entry.sessionDurationMs !== undefined && (
                <DetailRow
                  label="Session duration"
                  value={formatDuration(crash.entry.sessionDurationMs)}
                />
              )}
              {crash.entry.errorMessage && (
                <div className="mt-2">
                  <div className="text-xs text-canopy-text/50 mb-1">Error</div>
                  <pre className="text-xs text-red-400 bg-red-500/10 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                    {crash.entry.errorMessage}
                  </pre>
                </div>
              )}
              {crash.entry.errorStack && (
                <div>
                  <div className="text-xs text-canopy-text/50 mb-1">Stack trace</div>
                  <pre className="text-xs text-canopy-text/60 bg-overlay-soft rounded p-2 overflow-x-auto max-h-32 whitespace-pre-wrap break-all">
                    {crash.entry.errorStack}
                  </pre>
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-xs h-7"
                  onClick={handleOpenLogFile}
                  data-testid="open-log-button"
                >
                  <FileText className="h-3 w-3 mr-1" />
                  Open log file
                </Button>

                <Button
                  size="sm"
                  variant="ghost"
                  className="text-xs h-7"
                  onClick={handleReport}
                  data-testid="report-button"
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  {copied
                    ? "Copied!"
                    : privacyWarningShown
                      ? "Copy & open GitHub"
                      : "Report this crash"}
                </Button>
              </div>

              {privacyWarningShown && !copied && (
                <p
                  className="text-xs text-amber-400/90 bg-amber-500/10 rounded px-2 py-1.5"
                  data-testid="privacy-warning"
                >
                  Crash info may include file paths. Click again to copy and open GitHub Issues.
                </p>
              )}
            </div>
          )}
        </div>

        <label className="flex items-center gap-2 cursor-pointer" data-testid="auto-restore-label">
          <input
            type="checkbox"
            checked={config.autoRestoreOnCrash}
            onChange={(e) => handleAutoRestore(e.target.checked)}
            className="accent-canopy-accent h-4 w-4"
            data-testid="auto-restore-checkbox"
          />
          <span className="text-xs text-canopy-text/60">
            Don't show this again — always restore automatically
          </span>
        </label>
      </AppDialog.Body>
    </AppDialog>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-0.5">
      <span className="text-xs text-canopy-text/50 shrink-0">{label}</span>
      <span className="text-xs text-canopy-text/80 text-right font-mono">{value}</span>
    </div>
  );
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function buildClipboardText(crash: PendingCrash): string {
  const lines = [
    `## Crash Report`,
    ``,
    `**Canopy ${crash.entry.appVersion}** on ${crash.entry.platform} ${crash.entry.arch}`,
    `OS: ${crash.entry.osVersion}`,
    `Crashed at: ${new Date(crash.entry.timestamp).toISOString()}`,
  ];

  if (crash.entry.errorMessage) {
    lines.push(``, `**Error:** ${crash.entry.errorMessage}`);
  }
  if (crash.entry.errorStack) {
    lines.push(``, "```", crash.entry.errorStack, "```");
  }

  return lines.join("\n");
}
