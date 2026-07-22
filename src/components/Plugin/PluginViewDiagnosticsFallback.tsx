import { useCallback, useEffect, useMemo, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import { scrubReportText } from "@shared/utils/reportScrubbers";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

export interface PluginViewDiagnosticsFallbackProps {
  error: Error;
  errorInfo?: React.ErrorInfo;
  resetError: () => void;
  incidentId?: string | null;
  /** Plugin id — `manifest.name`, e.g. `acme`. */
  pluginId: string;
  /** Manifest display name, or the plugin id when the manifest omits one. */
  pluginDisplayName: string;
  /** Panel kind id — already prefixed, i.e. `${pluginId}.${panel.id}`. */
  kindId: string;
  /** The panel's own name, e.g. `Dashboard`. */
  panelDisplayName: string;
  /** Resolved `plugin://` URL of the view module that threw. */
  componentPath: string;
  /** The owning plugin loads from a dir outside the managed plugins dir. */
  devMode: boolean;
  /**
   * Close this panel, supplied by the presentation host. Omitted when the host
   * offers no close, in which case the button is not rendered rather than
   * rendered inert.
   */
  onRequestClose?: () => void;
}

const BUTTON_BASE = "rounded px-3 py-1.5 text-xs transition-colors";
const NEUTRAL_BUTTON = "bg-daintree-border text-daintree-text hover:bg-daintree-border/80";

function buildTrace(error: Error, errorInfo: React.ErrorInfo | undefined): string {
  return [
    "Stack:",
    error.stack || "No stack trace available",
    "",
    "Component stack:",
    errorInfo?.componentStack || "No component stack available",
  ].join("\n");
}

/**
 * Diagnostics pane for a plugin view that threw during render. Replaces the
 * shared `component` ErrorFallback at the plugin boundary only — that variant
 * stays lean for BrowserPane/FilePane/ReviewPane, which have no author to
 * inform (#11207).
 *
 * Detail depth keys off the plugin's own `devMode`, never `import.meta.env.DEV`:
 * plugin authors build against a *production* Daintree, so a build-mode gate
 * blinds the exact audience the trace exists for. The trace is redacted rather
 * than hidden for installed plugins — visibility isn't the risk, leaking the
 * user's paths and secrets into a pasted report is (#9427).
 */
export function PluginViewDiagnosticsFallback({
  error,
  errorInfo,
  resetError,
  incidentId,
  pluginId,
  pluginDisplayName,
  kindId,
  panelDisplayName,
  componentPath,
  devMode,
  onRequestClose,
}: PluginViewDiagnosticsFallbackProps) {
  const { copied, copy } = useCopyWithFeedback({ announcement: "Diagnostics copied" });
  const message = error.message || "Unknown render error";

  const announcedRef = useRef(false);
  useEffect(() => {
    if (announcedRef.current) return;
    announcedRef.current = true;
    useAnnouncerStore.getState().announce(`${panelDisplayName} error`, "polite");
  }, [panelDisplayName]);

  // Scrubbed once, here, so the rendered trace and the copied report can never
  // diverge. A dev-mode plugin's paths are the author's own — redacting them
  // would strip the file references they need to find the throw.
  const trace = useMemo(() => {
    const raw = buildTrace(error, errorInfo);
    return devMode ? raw : scrubReportText(raw);
  }, [error, errorInfo, devMode]);

  // Identity and message stay raw in both surfaces: they name the plugin, not
  // the user, and redacting them costs signal for no leak benefit.
  const report = useMemo(
    () =>
      [
        `Plugin: ${pluginDisplayName} (${pluginId})`,
        `Panel: ${panelDisplayName} (${kindId})`,
        `Module: ${componentPath}`,
        ...(incidentId ? [`Error ID: ${incidentId}`] : []),
        `Trace: ${devMode ? "raw (dev mode)" : "redacted"}`,
        "",
        `Message: ${message}`,
        "",
        trace,
      ].join("\n"),
    [
      pluginDisplayName,
      pluginId,
      panelDisplayName,
      kindId,
      componentPath,
      incidentId,
      devMode,
      message,
      trace,
    ]
  );

  const handleCopy = useCallback(() => {
    void copy(report);
  }, [copy, report]);

  const handleOpenLogs = useCallback(() => {
    void actionService.dispatch("logs.openFile", undefined, { source: "user" });
  }, []);

  return (
    <div
      role="region"
      aria-label={`${panelDisplayName} render error`}
      data-testid="plugin-view-diagnostics"
      className="flex h-full min-h-0 w-full flex-col gap-4 overflow-auto bg-surface-panel p-6"
    >
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-5 shrink-0 text-status-error" />
        <h2
          className="text-sm font-semibold text-status-error"
          data-testid="plugin-view-diagnostics-title"
        >
          Couldn&apos;t render {panelDisplayName}
        </h2>
      </div>

      <p className="text-xs text-text-primary" data-testid="plugin-view-diagnostics-message">
        {message}
      </p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-text-muted">Plugin</dt>
        <dd className="font-mono break-all text-text-primary">
          {pluginDisplayName} ({pluginId})
        </dd>
        <dt className="text-text-muted">Panel</dt>
        <dd className="font-mono break-all text-text-primary">
          {panelDisplayName} ({kindId})
        </dd>
        <dt className="text-text-muted">Module</dt>
        <dd className="font-mono break-all text-text-primary">{componentPath}</dd>
        {incidentId && (
          <>
            <dt className="text-text-muted">Error ID</dt>
            <dd className="font-mono break-all text-text-primary">{incidentId}</dd>
          </>
        )}
      </dl>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={resetError}
          data-testid="plugin-view-diagnostics-retry"
          className={cn(
            BUTTON_BASE,
            "bg-status-error text-daintree-bg hover:bg-[color-mix(in_oklab,var(--color-status-error)_85%,transparent)]"
          )}
        >
          Try again
        </button>
        {onRequestClose && (
          // No confirmation: the grid/dock close trashes the panel, which the
          // trash bin restores — a D0 reversible action, same as the header's
          // own close control. Neutral styling keeps "Try again" the single
          // emphasized action in this region.
          <button
            type="button"
            // Wrapped, not passed through: `onRequestClose` is declared
            // `() => void`, and handing it straight to onClick would call it
            // with the MouseEvent. The grid host absorbs that today only
            // because it wraps too — a host that forwarded a handler taking an
            // optional first argument (ContentPanel's `onClose(force?)`) would
            // silently receive a truthy one.
            onClick={() => onRequestClose()}
            data-testid="plugin-view-diagnostics-close"
            className={cn(BUTTON_BASE, NEUTRAL_BUTTON)}
          >
            Close panel
          </button>
        )}
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy diagnostics"
          data-testid="plugin-view-diagnostics-copy"
          className={cn(BUTTON_BASE, NEUTRAL_BUTTON)}
        >
          {copied ? "Copied" : "Copy diagnostics"}
        </button>
        <button
          type="button"
          onClick={handleOpenLogs}
          data-testid="plugin-view-diagnostics-logs"
          className={cn(BUTTON_BASE, NEUTRAL_BUTTON)}
        >
          View logs
        </button>
      </div>

      <pre
        data-testid="plugin-view-diagnostics-trace"
        className="rounded bg-scrim-soft p-3 text-xs break-words whitespace-pre-wrap text-status-error/80 select-text"
      >
        {trace}
      </pre>
    </div>
  );
}
