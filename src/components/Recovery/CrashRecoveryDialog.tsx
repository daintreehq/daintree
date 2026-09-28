import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { InlineError } from "@/components/ui/field";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileText,
  SquareTerminal,
  Globe,
  MonitorPlay,
  GitPullRequest,
} from "lucide-react";
import { Plug } from "@/components/icons";
import { AppDialog } from "../ui/AppDialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Textarea } from "../ui/textarea";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SettingsSwitch } from "../Settings/SettingsSwitch";
import { InlineStatusBanner } from "../Terminal/InlineStatusBanner";
import {
  getSuspectPanelBannerTitle,
  getPanelSuspectReasonTitle,
  SUSPECT_PANEL_BANNER_DESCRIPTION_DESELECTED,
  SUSPECT_PANEL_BANNER_DESCRIPTION_SELECTED,
} from "./recoveryCopy";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { scrubReportText } from "@shared/utils/reportScrubbers";
import {
  buildCrashReportUrl,
  buildCrashReportUrlFromBody,
} from "@shared/utils/buildCrashReportUrl";
import { getCrashCauseTitle, getCrashCauseDescription } from "@shared/utils/crashCauseCopy";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import type {
  PendingCrash,
  PanelSummary,
  ActionBreadcrumb,
  CrashRecoveryAction,
  CrashRecoveryConfig,
} from "@shared/types/ipc";

interface CrashRecoveryDialogProps {
  crash: PendingCrash;
  config: CrashRecoveryConfig;
  onResolve: (action: CrashRecoveryAction) => Promise<void>;
  onUpdateConfig: (patch: Partial<CrashRecoveryConfig>) => Promise<void>;
  /**
   * If set, renders the "Recovery failed" inline banner on first paint.
   * Used by the auto-restore path when the IPC handler rejects — the manual
   * rejection path (user clicks Restore → `onResolve` throws) still wins on
   * subsequent retries because it overrides this seed in `handleResolve`.
   */
  initialError?: string;
}

function getPanelIcon(kind: string) {
  switch (kind) {
    case "agent":
      return <Plug className="h-3.5 w-3.5" />;
    case "browser":
      return <Globe className="h-3.5 w-3.5" />;
    case "dev-preview":
      return <MonitorPlay className="h-3.5 w-3.5" />;
    case "review":
      return <GitPullRequest className="h-3.5 w-3.5" />;
    default:
      return <SquareTerminal className="h-3.5 w-3.5" />;
  }
}

export function CrashRecoveryDialog({
  crash,
  config,
  onResolve,
  onUpdateConfig,
  initialError,
}: CrashRecoveryDialogProps) {
  const panels = useMemo(() => crash.panels ?? [], [crash.panels]);
  const hasPanels = panels.length > 0;
  const isInCrashLoop = (crash.crashCount ?? 0) >= 2;
  const shouldDeselectSuspects = (crash.crashCount ?? 0) >= 1;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(panels.filter((p) => !(shouldDeselectSuspects && p.isSuspect)).map((p) => p.id))
  );
  const [resolving, setResolving] = useState(false);
  // Which action is in flight, so only its button shows busy.
  const [resolvingKind, setResolvingKind] = useState<CrashRecoveryAction["kind"] | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(initialError ?? null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [showReportPreview, setShowReportPreview] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showFreshConfirm, setShowFreshConfirm] = useState(false);
  const { copy: copyReport } = useCopyWithFeedback();
  const { copied: stackCopied, copy: copyStack } = useCopyWithFeedback();
  const reportTextRef = useRef<HTMLTextAreaElement>(null);

  const recentActions = useMemo(() => crash.entry.recentActions ?? [], [crash.entry.recentActions]);
  // The ring buffer is chronological; show newest-first so the most relevant
  // pre-crash context is at the top.
  const actionsNewestFirst = useMemo(() => [...recentActions].reverse(), [recentActions]);
  const reportResult = useMemo(() => buildCrashReportUrl(crash.entry), [crash.entry]);

  // Whether the (possibly edited) report exceeds the URL budget and must travel
  // via the clipboard. Tracks the textarea so the note stays accurate as the user
  // trims or pads the report.
  const [clipboardFallback, setClipboardFallback] = useState(reportResult.usedClipboardFallback);

  // Reset the preview when a different crash is loaded into the dialog. The
  // textarea content resets for free via key={crash.entry.id}; this only clears
  // the surrounding open/error state (single effect, not a split init/reset).
  useEffect(() => {
    setShowReportPreview(false);
    setReportError(null);
    setClipboardFallback(reportResult.usedClipboardFallback);
  }, [crash.entry.id, reportResult.usedClipboardFallback]);

  const selectedCount = selectedIds.size;
  const allSelected = selectedCount === panels.length;

  const handleResolve = useCallback(
    async (action: CrashRecoveryAction) => {
      if (resolving) return;
      setResolving(true);
      setResolvingKind(action.kind);
      setRecoveryError(null);
      try {
        await onResolve(action);
      } catch (err) {
        // notify() is dead in the crash-pending branch (Toaster isn't mounted
        // yet — the main app tree only renders after the user resolves the
        // dialog). Surface the failure inline alongside the recovery buttons
        // so the diagnostics action is reachable in the failure path.
        setRecoveryError(formatErrorMessage(err, "Couldn't complete recovery action"));
      } finally {
        setResolving(false);
        setResolvingKind(null);
      }
    },
    [resolving, onResolve]
  );

  const handleSendDiagnostics = useCallback(() => {
    void actionService.dispatch(
      "diagnostics.openReview",
      { scope: { source: "recovery.crashRecoveryFailed" } },
      { source: "user" }
    );
  }, []);

  const handleRestoreSelected = useCallback(() => {
    handleResolve({ kind: "restore", panelIds: [...selectedIds] });
  }, [handleResolve, selectedIds]);

  const handleRestoreAll = useCallback(() => {
    handleResolve({ kind: "restore", panelIds: panels.map((p) => p.id) });
  }, [handleResolve, panels]);

  const handleFresh = useCallback(() => {
    handleResolve({ kind: "fresh" });
  }, [handleResolve]);

  const handleFreshConfirm = useCallback(() => {
    setShowFreshConfirm(false);
    handleFresh();
  }, [handleFresh]);

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
    window.electron.system.openPath(crash.logPath).catch((err) => {
      logError("Failed to open crash log path", err);
      // shell.openPath rejects when the file is missing or inaccessible. After
      // the consumeMarker() persistence fix this is exceptional (corruption,
      // AV lock), but a corrupt V1 log from an older build can still hit it.
      // Soft warning — the cause-aware title above already tells the user why
      // the session ended, so an error toast here is more noise than signal.
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        priority: "low",
        title: "Log file isn't available",
        message: formatErrorMessage(err, "The on-disk crash log couldn't be opened"),
        duration: 6000,
      });
    });
  }, [crash.logPath]);

  const handleSubmitReport = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setReportError(null);
    try {
      const edited = reportTextRef.current?.value ?? reportResult.fullBody;
      const result = buildCrashReportUrlFromBody(crash.entry, edited);
      // When the edited report exceeds the URL budget the full content can only
      // travel via the clipboard. If that copy fails, keep the preview open and
      // surface the error rather than opening GitHub with a truncated stub.
      if (result.usedClipboardFallback) {
        const ok = await copyReport(edited);
        if (!ok) {
          setReportError(
            "Couldn't copy the report to the clipboard. Copy it manually, then open GitHub."
          );
          return;
        }
      }
      await window.electron.system.openExternal(result.url);
      setShowReportPreview(false);
    } catch (err) {
      logError("Failed to open issues URL", err);
      setReportError("Couldn't open GitHub. Copy the report above and open an issue manually.");
    } finally {
      setSubmitting(false);
    }
  }, [submitting, crash.entry, reportResult.fullBody, copyReport]);

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
    <>
      <AppDialog
        isOpen={true}
        onClose={() => {}}
        dismissible={false}
        size="md"
        data-testid="crash-recovery-dialog"
      >
        <AppDialog.Header>
          <AppDialog.Title icon={<AlertTriangle className="text-status-warning" />}>
            {getCrashCauseTitle(crash.entry.crashCause)}
          </AppDialog.Title>
          {/* Disabled, not absent: recovery has to be answered, and the header
              says so the way every other locked dialog does. */}
          <AppDialog.CloseButton />
        </AppDialog.Header>

        <AppDialog.Body className="space-y-4">
          <p className="text-sm text-text-primary">
            {getCrashCauseDescription(crash.entry.crashCause)} The previous session ended on{" "}
            {crashDate}.
            {hasPanels ? " Select which panels to restore:" : " Choose how to continue:"}
          </p>

          {hasPanels ? (
            <>
              <div className="border border-border-default rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-overlay-soft border-b border-border-default">
                  <Button
                    variant="link"
                    onClick={toggleAll}
                    className="text-xs"
                    data-testid="toggle-all-button"
                  >
                    {allSelected ? "Deselect all" : "Select all"}
                  </Button>
                  <span className="text-xs tabular-nums text-text-secondary">
                    {selectedCount} of {panels.length} selected
                  </span>
                </div>
                <div
                  className="max-h-48 overflow-y-auto divide-y divide-daintree-border/50"
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
                <div data-testid="suspect-warning">
                  <InlineStatusBanner
                    severity="warning"
                    icon={AlertTriangle}
                    title={getSuspectPanelBannerTitle(suspectCount, shouldDeselectSuspects)}
                    description={
                      shouldDeselectSuspects
                        ? SUSPECT_PANEL_BANNER_DESCRIPTION_DESELECTED
                        : SUSPECT_PANEL_BANNER_DESCRIPTION_SELECTED
                    }
                    actions={[]}
                    role="status"
                    ariaLive="polite"
                  />
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  variant="contrast"
                  onClick={handleRestoreSelected}
                  loading={resolvingKind === "restore"}
                  disabled={resolving || selectedCount === 0}
                  className="flex-1"
                  data-testid="restore-selected-button"
                >
                  {/* One flex item: the button's gap would otherwise space the
                      parentheses away from the count. */}
                  <span>
                    Restore selected (<span className="tabular-nums">{selectedCount}</span>)
                  </span>
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setShowFreshConfirm(true)}
                  disabled={resolving || showFreshConfirm}
                  data-testid="fresh-button"
                >
                  Continue without restoring
                </Button>
              </div>

              {backupDate && (
                <p className="text-xs text-text-secondary">Session backup from {backupDate}</p>
              )}
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={handleRestoreAll}
                disabled={resolving}
                className="cursor-pointer flex items-start gap-3 p-3 rounded-lg border border-border-default hover:border-border-strong hover:bg-overlay-subtle text-left transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
                data-testid="restore-button"
              >
                <div className="mt-0.5 h-5 w-5 rounded-full bg-overlay-medium flex items-center justify-center shrink-0">
                  <div className="h-2 w-2 rounded-full bg-daintree-text/40" />
                </div>
                <div>
                  <div className="text-sm font-medium text-text-primary">
                    Restore previous session
                  </div>
                  {backupDate ? (
                    <div className="text-xs text-text-secondary mt-0.5">
                      Restore session from {backupDate}
                    </div>
                  ) : (
                    <div className="text-xs text-text-secondary mt-0.5">
                      No backup available — layout may be empty
                    </div>
                  )}
                </div>
              </button>

              <button
                type="button"
                onClick={() => setShowFreshConfirm(true)}
                disabled={resolving || showFreshConfirm}
                className="cursor-pointer flex items-start gap-3 p-3 rounded-lg border border-border-default hover:border-border-strong hover:bg-overlay-subtle text-left transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
                data-testid="fresh-button"
              >
                <div className="mt-0.5 h-5 w-5 rounded-full bg-daintree-text/10 flex items-center justify-center shrink-0">
                  <div className="h-2 w-2 rounded-full bg-daintree-text/40" />
                </div>
                <div>
                  <div className="text-sm font-medium text-text-primary">
                    Continue without restoring
                  </div>
                  <div className="text-xs text-text-secondary mt-0.5">
                    Reset to a clean layout — open panels will be cleared
                  </div>
                </div>
              </button>
            </div>
          )}

          {recoveryError && (
            <div data-testid="recovery-error">
              <InlineStatusBanner
                severity="error"
                title="Recovery failed"
                description={recoveryError}
                animated={false}
                action={{
                  id: "send-diagnostics",
                  label: "Send diagnostics",
                  icon: Download,
                  onClick: handleSendDiagnostics,
                }}
                onClose={() => setRecoveryError(null)}
                closeAriaLabel="Dismiss recovery error"
              />
            </div>
          )}

          <div className="border border-border-default rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setDetailsOpen((o) => !o)}
              aria-expanded={detailsOpen}
              className="cursor-pointer w-full flex items-center justify-between px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-overlay-soft transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
              data-testid="details-toggle"
            >
              <span className="font-medium">Error details</span>
              {detailsOpen ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>

            {detailsOpen && (
              <div
                className="px-3 pb-3 space-y-2 border-t border-border-default"
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
                    <div className="text-xs text-text-secondary mb-1">Error</div>
                    <pre className="text-xs text-text-primary bg-status-error/10 border border-status-error/20 rounded-[var(--radius-md)] p-2 overflow-x-auto whitespace-pre-wrap break-all select-text">
                      {crash.entry.errorMessage}
                    </pre>
                  </div>
                )}
                {crash.entry.errorStack && (
                  <div>
                    <div className="text-xs text-text-secondary mb-1">Stack trace</div>
                    <pre className="text-xs text-text-secondary bg-overlay-soft rounded p-2 overflow-x-auto max-h-32 whitespace-pre-wrap break-all select-text">
                      {crash.entry.errorStack}
                    </pre>
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleOpenLogFile}
                    data-testid="open-log-button"
                  >
                    <FileText aria-hidden="true" />
                    Open log file
                  </Button>

                  {crash.entry.errorStack && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => copyStack(crash.entry.errorStack!)}
                      data-testid="copy-stack-button"
                    >
                      <Copy aria-hidden="true" />
                      {stackCopied ? "Copied" : "Copy stack"}
                    </Button>
                  )}

                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowReportPreview((o) => !o)}
                    data-testid="report-button"
                  >
                    <ExternalLink aria-hidden="true" />
                    Report this crash
                  </Button>
                </div>

                {recentActions.length > 0 && (
                  <div data-testid="actions-section" className="pt-1">
                    <div className="text-xs text-text-secondary mb-1">
                      Recent actions ({recentActions.length})
                    </div>
                    <div
                      className="max-h-32 overflow-y-auto rounded bg-overlay-soft divide-y divide-daintree-border/40"
                      data-testid="actions-list"
                    >
                      {actionsNewestFirst.map((action) => (
                        <ActionTrailRow key={action.id} action={action} />
                      ))}
                    </div>
                  </div>
                )}

                {showReportPreview && (
                  <div className="pt-1 space-y-2" data-testid="report-preview">
                    <p className="text-xs text-text-secondary">
                      Review and edit before submitting. The report is redacted and will be publicly
                      visible on GitHub.
                    </p>
                    <Textarea
                      variant="code"
                      density="compact"
                      aria-label="Crash report"
                      key={crash.entry.id}
                      ref={reportTextRef}
                      defaultValue={reportResult.fullBody}
                      spellCheck={false}
                      onChange={(e) =>
                        setClipboardFallback(
                          buildCrashReportUrlFromBody(crash.entry, e.target.value)
                            .usedClipboardFallback
                        )
                      }
                      className="max-h-48 min-h-32 h-48 select-text"
                      data-testid="report-textarea"
                    />
                    {clipboardFallback && (
                      <p
                        className="text-xs text-text-secondary"
                        data-testid="report-clipboard-note"
                      >
                        This report is too long for a GitHub URL — it'll be copied to your clipboard
                        so you can paste it into the issue.
                      </p>
                    )}
                    {reportError && (
                      <InlineError role="alert" data-testid="report-error">
                        {reportError}
                      </InlineError>
                    )}
                    <div className="flex gap-2">
                      <Button
                        variant="contrast"
                        size="sm"
                        onClick={() => void handleSubmitReport()}
                        loading={submitting}
                        data-testid="submit-report-button"
                      >
                        <ExternalLink aria-hidden="true" />
                        Submit on GitHub
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setShowReportPreview(false)}
                        data-testid="cancel-report-button"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {isInCrashLoop ? (
            config.autoRestoreOnCrash && (
              <p className="text-xs text-text-secondary" data-testid="auto-restore-paused">
                Auto-restore paused — too many consecutive crashes.
              </p>
            )
          ) : (
            <div
              className="flex items-center justify-between gap-3"
              data-testid="auto-restore-label"
            >
              <div className="text-left">
                <div id="auto-restore-title" className="text-sm font-medium text-text-primary">
                  Restore automatically next time
                </div>
                <div className="text-xs text-text-secondary">
                  Skips this dialog. Shows again if Daintree crashes twice in a row.
                </div>
              </div>
              <SettingsSwitch
                checked={config.autoRestoreOnCrash}
                onCheckedChange={handleAutoRestore}
                aria-labelledby="auto-restore-title"
                data-testid="auto-restore-checkbox"
              />
            </div>
          )}
        </AppDialog.Body>
      </AppDialog>

      <ConfirmDialog
        isOpen={showFreshConfirm}
        onClose={() => setShowFreshConfirm(false)}
        title="Reset to clean layout?"
        description={
          hasPanels
            ? "All open panels listed below will be closed and their state will be discarded."
            : crash.hasBackup
              ? "Your session will start with a clean layout and the existing session backup will be discarded."
              : "Your session will start with a clean layout."
        }
        confirmLabel="Reset to clean layout"
        variant="destructive"
        // Only the panel-listing branch carries structured content; the
        // no-panels branch really is the brief message alertdialog is for.
        hasPreview={hasPanels}
        zIndex="nested"
        onConfirm={handleFreshConfirm}
      >
        {hasPanels && (
          <ul className="space-y-1.5">
            {panels.map((panel) => (
              <li key={panel.id} className="flex items-center gap-2 text-sm text-text-primary">
                <span className="shrink-0 text-text-secondary">{getPanelIcon(panel.kind)}</span>
                <span className="truncate">{panel.title || panel.kind}</span>
              </li>
            ))}
          </ul>
        )}
      </ConfirmDialog>
    </>
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
      <Checkbox
        checked={selected}
        onCheckedChange={() => onToggle(panel.id)}
        data-testid={`panel-checkbox-${panel.id}`}
      />
      <span className="text-text-secondary shrink-0">{getPanelIcon(panel.kind)}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-primary truncate">{panel.title || panel.kind}</div>
        {panel.cwd && <div className="text-xs text-text-secondary truncate">{panel.cwd}</div>}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {panel.agentState && (
          <span className="text-xs text-text-secondary" data-testid={`agent-state-${panel.id}`}>
            {panel.agentState}
          </span>
        )}
        <span className="text-xs text-text-secondary">{panel.location}</span>
        {panel.isSuspect && (
          <span
            className="text-status-warning"
            title={getPanelSuspectReasonTitle(panel.suspectReason)}
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
      <span className="text-xs text-text-secondary shrink-0">{label}</span>
      <span className="text-xs text-text-primary text-right font-mono">{value}</span>
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

function formatActionArgs(args: Record<string, unknown> | undefined): string | null {
  if (!args || Object.keys(args).length === 0) return null;
  let raw: string;
  try {
    raw = JSON.stringify(args);
  } catch {
    return null;
  }
  return scrubReportText(raw);
}

function ActionTrailRow({ action }: { action: ActionBreadcrumb }) {
  const time = new Date(action.timestamp).toLocaleTimeString();
  const args = formatActionArgs(action.args);
  return (
    <div
      className="flex items-baseline gap-2 px-2 py-1 text-xs"
      data-testid={`action-row-${action.id}`}
    >
      <span className="text-text-secondary tabular-nums shrink-0">{time}</span>
      <span className="font-mono text-text-primary truncate">{action.actionId}</span>
      {action.count > 1 && (
        <span className="text-text-secondary tabular-nums shrink-0">×{action.count}</span>
      )}
      <span className="text-text-secondary shrink-0">{action.source}</span>
      {action.danger !== "safe" && (
        <span className="text-text-secondary shrink-0">{action.danger}</span>
      )}
      {action.confirmed && (
        <span className="text-status-warning shrink-0" title="Confirmed destructive action">
          confirmed
        </span>
      )}
      {args && (
        <span className="text-text-secondary truncate font-mono" title={args}>
          {args}
        </span>
      )}
    </div>
  );
}
