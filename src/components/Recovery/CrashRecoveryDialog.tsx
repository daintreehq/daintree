import { useState, useCallback, useMemo } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  SquareTerminal,
  Globe,
  Leaf,
  Monitor,
} from "lucide-react";
import { CanopyAgentIcon } from "@/components/icons";
import { AppDialog } from "../ui/AppDialog";
import { Button } from "../ui/button";
import type {
  PendingCrash,
  PanelSummary,
  CrashRecoveryAction,
  CrashRecoveryConfig,
} from "@shared/types/ipc";

const ISSUES_URL = "https://github.com/canopyide/canopy/issues/new";

interface CrashRecoveryDialogProps {
  crash: PendingCrash;
  config: CrashRecoveryConfig;
  onResolve: (action: CrashRecoveryAction) => Promise<void>;
  onUpdateConfig: (patch: Partial<CrashRecoveryConfig>) => Promise<void>;
}

function getPanelIcon(kind: string) {
  switch (kind) {
    case "agent":
      return <CanopyAgentIcon className="h-3.5 w-3.5" />;
    case "browser":
      return <Globe className="h-3.5 w-3.5" />;
    case "notes":
      return <Leaf className="h-3.5 w-3.5" />;
    case "dev-preview":
      return <Monitor className="h-3.5 w-3.5" />;
    default:
      return <SquareTerminal className="h-3.5 w-3.5" />;
  }
}

export function CrashRecoveryDialog({
  crash,
  config,
  onResolve,
  onUpdateConfig,
}: CrashRecoveryDialogProps) {
  const panels = useMemo(() => crash.panels ?? [], [crash.panels]);
  const hasPanels = panels.length > 0;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(panels.map((p) => p.id))
  );
  const [resolving, setResolving] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [privacyWarningShown, setPrivacyWarningShown] = useState(false);
  const [copied, setCopied] = useState(false);

  const selectedCount = selectedIds.size;
  const allSelected = selectedCount === panels.length;

  const handleResolve = useCallback(
    async (action: CrashRecoveryAction) => {
      if (resolving) return;
      setResolving(true);
      try {
        await onResolve(action);
      } finally {
        setResolving(false);
      }
    },
    [resolving, onResolve]
  );

  const handleRestoreSelected = useCallback(() => {
    handleResolve({ kind: "restore", panelIds: [...selectedIds] });
  }, [handleResolve, selectedIds]);

  const handleRestoreAll = useCallback(() => {
    handleResolve({ kind: "restore", panelIds: panels.map((p) => p.id) });
  }, [handleResolve, panels]);

  const handleFresh = useCallback(() => {
    handleResolve({ kind: "fresh" });
  }, [handleResolve]);

  const togglePanel = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(panels.map((p) => p.id)));
    }
  }, [allSelected, panels]);

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

  const suspectCount = useMemo(() => panels.filter((p) => p.isSuspect).length, [panels]);
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
        <AppDialog.Title icon={<AlertTriangle className="h-5 w-5 text-status-warning" />}>
          Canopy Crashed
        </AppDialog.Title>
      </AppDialog.Header>

      <AppDialog.Body className="space-y-4">
        <p className="text-sm text-canopy-text/80">
          The previous session ended unexpectedly on {crashDate}.
          {hasPanels ? " Select which panels to restore:" : " Choose how to continue:"}
        </p>

        {hasPanels ? (
          <>
            <div className="border border-canopy-border rounded-lg overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 bg-overlay-soft border-b border-canopy-border">
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-xs text-canopy-accent hover:text-canopy-accent/80 transition-colors"
                  data-testid="toggle-all-button"
                >
                  {allSelected ? "Deselect all" : "Select all"}
                </button>
                <span className="text-xs tabular-nums text-canopy-text/50">
                  {selectedCount} of {panels.length} selected
                </span>
              </div>
              <div
                className="max-h-48 overflow-y-auto divide-y divide-canopy-border/50"
                data-testid="panel-list"
              >
                {panels.map((panel) => (
                  <PanelRow
                    key={panel.id}
                    panel={panel}
                    selected={selectedIds.has(panel.id)}
                    onToggle={togglePanel}
                  />
                ))}
              </div>
            </div>

            {suspectCount > 0 && (
              <p
                className="text-xs text-status-warning/90 bg-status-warning/10 rounded px-2 py-1.5"
                data-testid="suspect-warning"
              >
                <span className="tabular-nums">{suspectCount}</span> panel
                {suspectCount > 1 ? "s were" : " was"} created shortly before the crash and may be
                related.
              </p>
            )}

            <div className="flex gap-2">
              <Button
                onClick={handleRestoreSelected}
                disabled={resolving || selectedCount === 0}
                className="flex-1"
                data-testid="restore-selected-button"
              >
                Restore selected (<span className="tabular-nums">{selectedCount}</span>)
              </Button>
              <Button
                variant="ghost"
                onClick={handleFresh}
                disabled={resolving}
                data-testid="fresh-button"
              >
                Start fresh
              </Button>
            </div>

            {backupDate && (
              <p className="text-xs text-canopy-text/50">Session backup from {backupDate}</p>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={handleRestoreAll}
              disabled={resolving}
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
              onClick={handleFresh}
              disabled={resolving}
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
        )}

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
              {crash.entry.electronVersion && (
                <DetailRow label="Electron" value={crash.entry.electronVersion} />
              )}
              {crash.entry.totalMemory !== undefined && (
                <DetailRow
                  label="Memory"
                  value={`${formatBytesCompact(crash.entry.freeMemory ?? 0)} free / ${formatBytesCompact(crash.entry.totalMemory)} total`}
                />
              )}
              {crash.entry.panelCount !== undefined && (
                <DetailRow label="Panels" value={String(crash.entry.panelCount)} />
              )}
              {crash.entry.processUptime !== undefined && (
                <DetailRow
                  label="Process uptime"
                  value={formatDuration(crash.entry.processUptime * 1000)}
                />
              )}
              {crash.entry.errorMessage && (
                <div className="mt-2">
                  <div className="text-xs text-canopy-text/50 mb-1">Error</div>
                  <pre className="text-xs text-status-danger bg-status-danger/10 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all select-text">
                    {crash.entry.errorMessage}
                  </pre>
                </div>
              )}
              {crash.entry.errorStack && (
                <div>
                  <div className="text-xs text-canopy-text/50 mb-1">Stack trace</div>
                  <pre className="text-xs text-canopy-text/60 bg-overlay-soft rounded p-2 overflow-x-auto max-h-32 whitespace-pre-wrap break-all select-text">
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
                  className="text-xs text-status-warning/90 bg-status-warning/10 rounded px-2 py-1.5"
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

function PanelRow({
  panel,
  selected,
  onToggle,
}: {
  panel: PanelSummary;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <label
      className="flex items-center gap-3 px-3 py-2 hover:bg-overlay-soft cursor-pointer transition-colors"
      data-testid={`panel-row-${panel.id}`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggle(panel.id)}
        className="accent-canopy-accent h-3.5 w-3.5 shrink-0"
        data-testid={`panel-checkbox-${panel.id}`}
      />
      <span className="text-canopy-text/60 shrink-0">{getPanelIcon(panel.kind)}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-canopy-text truncate">{panel.title || panel.kind}</div>
        {panel.cwd && <div className="text-xs text-canopy-text/40 truncate">{panel.cwd}</div>}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {panel.agentState && (
          <span className="text-xs text-canopy-text/50" data-testid={`agent-state-${panel.id}`}>
            {panel.agentState}
          </span>
        )}
        <span className="text-xs text-canopy-text/40">{panel.location}</span>
        {panel.isSuspect && (
          <span
            className="text-status-warning"
            title="Created shortly before crash"
            data-testid={`suspect-badge-${panel.id}`}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
    </label>
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

function formatBytesCompact(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  let i = Math.floor(Math.log(bytes) / Math.log(k));
  i = Math.max(0, Math.min(i, sizes.length - 1));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function buildClipboardText(crash: PendingCrash): string {
  const e = crash.entry;
  const lines: string[] = [
    `## Crash Report`,
    ``,
    `**Canopy ${e.appVersion}** on ${e.platform} ${e.arch}`,
    `- **OS**: ${e.osVersion}`,
  ];

  const versionParts: string[] = [];
  if (e.electronVersion) versionParts.push(`**Electron**: ${e.electronVersion}`);
  if (e.nodeVersion) versionParts.push(`**Node**: ${e.nodeVersion}`);
  if (e.chromeVersion) versionParts.push(`**Chrome**: ${e.chromeVersion}`);
  if (versionParts.length > 0) lines.push(`- ${versionParts.join(" | ")}`);

  const sessionParts: string[] = [];
  if (e.sessionDurationMs !== undefined)
    sessionParts.push(`**Session**: ${formatDuration(e.sessionDurationMs)}`);
  if (e.isPackaged !== undefined) sessionParts.push(`**Packaged**: ${e.isPackaged ? "Yes" : "No"}`);
  if (sessionParts.length > 0) lines.push(`- ${sessionParts.join(" | ")}`);

  if (e.totalMemory !== undefined) {
    lines.push(
      `- **Memory (Free/Total)**: ${formatBytesCompact(e.freeMemory ?? 0)} / ${formatBytesCompact(e.totalMemory)}`
    );
  }
  if (e.rss !== undefined || e.heapUsed !== undefined) {
    const parts: string[] = [];
    if (e.rss !== undefined) parts.push(`RSS ${formatBytesCompact(e.rss)}`);
    if (e.heapUsed !== undefined && e.heapTotal !== undefined)
      parts.push(`Heap ${formatBytesCompact(e.heapUsed)}/${formatBytesCompact(e.heapTotal)}`);
    lines.push(`- **Process Memory**: ${parts.join(", ")}`);
  }

  const infoParts: string[] = [];
  if (e.panelCount !== undefined) {
    let panelStr = String(e.panelCount);
    if (e.panelKinds && Object.keys(e.panelKinds).length > 0) {
      panelStr += ` (${Object.entries(e.panelKinds)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")})`;
    }
    infoParts.push(`**Panels**: ${panelStr}`);
  }
  if (e.windowCount !== undefined) infoParts.push(`**Windows**: ${e.windowCount}`);
  if (infoParts.length > 0) lines.push(`- ${infoParts.join(" | ")}`);

  if (e.cpuCount !== undefined) lines.push(`- **CPUs**: ${e.cpuCount}`);
  if (e.gpuAccelerationDisabled !== undefined)
    lines.push(`- **GPU Acceleration**: ${e.gpuAccelerationDisabled ? "Disabled" : "Enabled"}`);

  lines.push(`- **Crashed at**: ${new Date(e.timestamp).toISOString()}`);

  if (e.errorMessage) {
    lines.push(``, `**Error:** ${e.errorMessage}`);
  }
  if (e.errorStack) {
    lines.push(
      ``,
      `<details>`,
      `<summary>Stack trace</summary>`,
      ``,
      "```",
      e.errorStack,
      "```",
      ``,
      `</details>`
    );
  }

  return lines.join("\n");
}
