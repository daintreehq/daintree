import { useCallback, useEffect, useMemo, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import { buildPluginViewDiagnostics } from "@/components/Plugin/buildPluginViewDiagnostics";
import { Button } from "@/components/ui/button";
import { StackLines } from "@/components/ErrorBoundary/StackLines";
import { actionService } from "@/services/ActionService";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { pluginDocumentRuntime } from "@/services/plugin/pluginDocumentRuntime";
import { PathSegments } from "@/components/ui/PathSegments";

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
  // Only a refusal the document runtime itself issued is unrecoverable by a
  // remount; an unrelated render error in the same plugin keeps its retry.
  const needsDocumentReload = pluginDocumentRuntime.errorSource(error) !== undefined;

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
    useAnnouncerStore.getState().announce(`${panelName} stopped working`, "polite");
  }, [panelName]);

  const handleCopy = useCallback(() => {
    void copy(report);
  }, [copy, report]);

  const handleReloadWindow = useCallback(() => {
    void actionService.dispatch("plugin.reloadWindow", undefined, { source: "user" });
  }, []);

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
      <div className="flex items-start gap-3">
        <div
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-overlay-subtle"
        >
          <TriangleAlert className="size-4 text-status-error" />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <h2
            className="text-sm font-semibold break-words text-text-primary"
            data-testid="plugin-view-diagnostics-title"
          >
            {panelName} stopped working
          </h2>
          <p className="text-xs break-words text-text-secondary">
            {needsDocumentReload
              ? `${diagnostics.pluginDisplayName} needs this window to reload before its panels can run again.`
              : devMode
                ? `${diagnostics.pluginDisplayName} threw while rendering this panel. The full trace is below.`
                : `${diagnostics.pluginDisplayName} hit an error while rendering this panel. The rest of Daintree is still running.`}
          </p>

          <div className="mt-2 flex flex-wrap gap-2">
            {needsDocumentReload && (
              // A remount can't clear a refusal the document runtime issued, so the
              // recovery here is the plugin reload, with its own save-first confirm.
              <Button
                type="button"
                variant="contrast"
                size="sm"
                onClick={handleReloadWindow}
                data-testid="plugin-view-diagnostics-reload-window"
              >
                Reload window
              </Button>
            )}
            {!needsDocumentReload && (
              <Button
                type="button"
                variant="contrast"
                size="sm"
                onClick={resetError}
                data-testid="plugin-view-diagnostics-retry"
              >
                Try again
              </Button>
            )}
            {onRequestClose && (
              // No confirmation: the grid/dock close trashes the panel, which the
              // trash bin restores — a D0 reversible action, same as the header's
              // own close control. Neutral styling keeps "Try again" the single
              // emphasized action in this region.
              <Button
                type="button"
                variant="subtle"
                size="sm"
                // Wrapped, not passed through: `onRequestClose` is declared
                // `() => void`, and handing it straight to onClick would call it
                // with the MouseEvent. The grid host absorbs that today only
                // because it wraps too — a host that forwarded a handler taking an
                // optional first argument (ContentPanel's `onClose(force?)`) would
                // silently receive a truthy one.
                onClick={() => onRequestClose()}
                data-testid="plugin-view-diagnostics-close"
              >
                Close panel
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              aria-label="Copy diagnostics"
              data-testid="plugin-view-diagnostics-copy"
            >
              {copied ? "Copied" : "Copy diagnostics"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleOpenLogs}
              data-testid="plugin-view-diagnostics-logs"
            >
              View logs
            </Button>
          </div>
        </div>
      </div>

      {/* Open by default for the plugin's own author, closed for someone who
          installed it and mostly wants their panel back. */}
      <details open={devMode} className="min-w-0 pl-11">
        <summary className="w-fit cursor-pointer rounded-[var(--radius-sm)] text-xs text-text-secondary hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary">
          Technical details
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          {/* Wraps and keeps newlines: a thrown non-Error renders as formatted JSON
              here, and a plugin's message is routinely multi-line. */}
          <p
            className="font-mono text-xs break-words whitespace-pre-wrap text-text-primary"
            data-testid="plugin-view-diagnostics-message"
          >
            {message}
          </p>

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-text-secondary">Plugin</dt>
            <dd className="font-mono break-all text-text-primary">
              {diagnostics.pluginDisplayName} ({diagnostics.pluginId})
            </dd>
            <dt className="text-text-secondary">Panel</dt>
            <dd className="font-mono break-all text-text-primary">
              {panelName} ({diagnostics.kindId})
            </dd>
            <dt className="text-text-secondary">Module</dt>
            <dd className="font-mono text-text-primary">
              <PathSegments path={diagnostics.componentPath} />
            </dd>
            {diagnostics.incidentId && (
              <>
                <dt className="text-text-secondary">Error ID</dt>
                <dd className="font-mono break-all text-text-primary">{diagnostics.incidentId}</dd>
              </>
            )}
            {diagnostics.code && (
              <>
                <dt className="text-text-secondary">Code</dt>
                <dd className="font-mono break-all text-text-primary">{diagnostics.code}</dd>
              </>
            )}
            {/* The pane makes a claim about its own contents, so it has to state
                which claim — an unlabelled raw view is how #12281 happened. */}
            <dt className="text-text-secondary">Report</dt>
            <dd className="text-text-primary" data-testid="plugin-view-diagnostics-mode">
              {diagnostics.mode}
            </dd>
          </dl>

          <pre
            data-testid="plugin-view-diagnostics-trace"
            className="max-h-80 overflow-y-auto rounded-[var(--radius-md)] border border-divider bg-surface-canvas p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-text-secondary select-text"
          >
            <StackLines text={trace} />
          </pre>
        </div>
      </details>
    </div>
  );
}
