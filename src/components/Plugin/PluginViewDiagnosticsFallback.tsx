import { useCallback, useEffect, useMemo, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import { buildPluginViewDiagnostics } from "@/components/Plugin/buildPluginViewDiagnostics";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

export interface PluginViewDiagnosticsFallbackProps {
  /**
   * Whatever the view threw. Typed `unknown` rather than `Error` because React
   * stores the thrown value unnormalized — `getDerivedStateFromError`'s `Error`
   * annotation is the type system's claim, not the runtime's.
   */
  error: unknown;
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
const NEUTRAL_BUTTON = "bg-border-default text-text-primary hover:bg-daintree-border/80";

/**
 * Diagnostics pane for a plugin view that threw during render. Replaces the
 * shared `component` ErrorFallback at the plugin boundary only — that variant
 * stays lean for BrowserPane/FilePane/ReviewPane, which have no author to
 * inform (#11207).
 *
 * Detail depth keys off the plugin's own `devMode`, never `import.meta.env.DEV`:
 * plugin authors build against a *production* Daintree, so a build-mode gate
 * blinds the exact audience the trace exists for. Content is redacted rather
 * than hidden for installed plugins — visibility isn't the risk, leaking the
 * user's paths and secrets into a pasted report is (#9427).
 *
 * Redaction covers the whole document — message and cause chain included, not
 * just the stacks — because the plugin author decides what goes in them
 * (#12281). See `buildPluginViewDiagnostics` for why that differs from the
 * sibling `ErrorFallback`, which keeps its first-party message raw.
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

  // Built once, here, so the rendered pane and the copied report can never
  // diverge — the label claiming redaction has to describe both.
  const diagnostics = useMemo(
    () =>
      buildPluginViewDiagnostics({
        error,
        componentStack: errorInfo?.componentStack,
        devMode,
        pluginId,
        pluginDisplayName,
        kindId,
        panelDisplayName,
        componentPath,
        incidentId,
      }),
    [
      error,
      errorInfo,
      devMode,
      pluginId,
      pluginDisplayName,
      kindId,
      panelDisplayName,
      componentPath,
      incidentId,
    ]
  );
  // Destructured from the builder rather than read off the props: the manifest
  // supplies these, so they are author-controlled text like the message, and a
  // pane labelled redacted must not print them raw beside that label.
  const { message, trace, report, panelDisplayName: panelName } = diagnostics;

  const announcedRef = useRef(false);
  useEffect(() => {
    if (announcedRef.current) return;
    announcedRef.current = true;
    useAnnouncerStore.getState().announce(`${panelName} error`, "polite");
  }, [panelName]);

  const handleCopy = useCallback(() => {
    void copy(report);
  }, [copy, report]);

  const handleOpenLogs = useCallback(() => {
    void actionService.dispatch("logs.openFile", undefined, { source: "user" });
  }, []);

  return (
    <div
      role="region"
      aria-label={`${panelName} render error`}
      data-testid="plugin-view-diagnostics"
      className="flex h-full min-h-0 w-full flex-col gap-4 overflow-auto bg-surface-panel p-6"
    >
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-5 shrink-0 text-status-error" />
        <h2
          className="text-sm font-semibold text-status-error"
          data-testid="plugin-view-diagnostics-title"
        >
          Couldn&apos;t render {panelName}
        </h2>
      </div>

      {/* Wraps and keeps newlines: a thrown non-Error renders as formatted JSON
          here, and a plugin's message is routinely multi-line. */}
      <p
        className="text-xs break-words whitespace-pre-wrap text-text-primary"
        data-testid="plugin-view-diagnostics-message"
      >
        {message}
      </p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-text-muted">Plugin</dt>
        <dd className="font-mono break-all text-text-primary">
          {diagnostics.pluginDisplayName} ({diagnostics.pluginId})
        </dd>
        <dt className="text-text-muted">Panel</dt>
        <dd className="font-mono break-all text-text-primary">
          {panelName} ({diagnostics.kindId})
        </dd>
        <dt className="text-text-muted">Module</dt>
        <dd className="font-mono break-all text-text-primary">{diagnostics.componentPath}</dd>
        {diagnostics.incidentId && (
          <>
            <dt className="text-text-muted">Error ID</dt>
            <dd className="font-mono break-all text-text-primary">{diagnostics.incidentId}</dd>
          </>
        )}
        {diagnostics.code && (
          <>
            <dt className="text-text-muted">Code</dt>
            <dd className="font-mono break-all text-text-primary">{diagnostics.code}</dd>
          </>
        )}
        {/* The pane makes a claim about its own contents, so it has to state
            which claim — an unlabelled raw view is how #12281 happened. */}
        <dt className="text-text-muted">Report</dt>
        <dd className="text-text-primary" data-testid="plugin-view-diagnostics-mode">
          {diagnostics.mode}
        </dd>
      </dl>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={resetError}
          data-testid="plugin-view-diagnostics-retry"
          className={cn(
            BUTTON_BASE,
            "bg-status-error text-surface-canvas hover:bg-[color-mix(in_oklab,var(--color-status-error)_85%,transparent)]"
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
