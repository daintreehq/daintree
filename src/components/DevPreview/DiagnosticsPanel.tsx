import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  DevPreviewDiagnosticEvent,
  DevPreviewDiagnosticsResult,
  DevPreviewUpstreamResolution,
} from "@shared/types/ipc/devPreview";
import type { DevPreviewStatus } from "@/hooks/useDevServer";

interface DiagnosticsPanelProps {
  paneId: string;
  projectId?: string;
  /** Live dev-server status — a change means the timeline moved, so refetch. */
  status?: DevPreviewStatus;
}

const PROXY_CAUSE_LABELS: Record<string, string> = {
  "no-session": "no session registered for this origin",
  "not-running": "dev server isn't running",
  "upstream-refused": "dev server refused the connection",
  "upstream-timeout": "dev server timed out",
  "upstream-error": "dev server connection failed",
};

function describeProxyCause(cause: string, code?: string): string {
  const label = PROXY_CAUSE_LABELS[cause] ?? cause;
  return code ? `${label} (${code})` : label;
}

/**
 * Human-readable line for one timeline event. Exported for tests — the switch
 * is exhaustive over the event union, so a new event type fails typecheck here
 * instead of silently rendering blank.
 */
export function describeDiagnosticEvent(event: DevPreviewDiagnosticEvent): {
  label: string;
  detail?: string;
} {
  switch (event.type) {
    case "ensure-requested":
      return {
        label: "Ensure requested",
        detail: event.configChanged ? "config changed" : undefined,
      };
    case "config-changed":
      return { label: "Config changed", detail: event.changed.join(", ") };
    case "command-invalid":
      return { label: "Command invalid", detail: event.message };
    case "bundler-conflict":
      return { label: "Bundler preference not applied", detail: event.message };
    case "port-allocated":
      return { label: "Port allocated", detail: `port ${event.port}` };
    case "port-conflict":
      return { label: "Port conflict", detail: `port ${event.port} did not release` };
    case "spawned":
      return { label: "Dev server spawned", detail: `port ${event.port}` };
    case "spawn-failed":
      return { label: "Spawn failed", detail: event.message };
    case "install-started":
      return { label: "Install started", detail: event.command };
    case "install-completed":
      return { label: "Install completed" };
    case "install-failed":
      return { label: "Install failed", detail: event.message };
    case "url-detected":
      return { label: "URL detected", detail: event.url };
    case "readiness-probe-succeeded":
      return { label: "Server ready", detail: event.url };
    case "readiness-probe-timed-out":
      return {
        label: "Readiness timed out",
        detail: `${event.url} after ${Math.round(event.timeoutMs / 1000)}s`,
      };
    case "readiness-probe-failed":
      return { label: "Readiness check failed", detail: event.message };
    case "compile-started":
      return { label: "Compile started" };
    case "compile-cleared":
      return { label: "Compile finished" };
    case "output-error":
      return { label: `Error (${event.errorType})`, detail: event.message };
    case "restart-requested":
      return {
        label:
          event.mode === "clear-cache"
            ? "Restart with cache clear"
            : event.mode === "reinstall"
              ? "Restart with reinstall"
              : "Restart requested",
      };
    case "stop-requested":
      return { label: "Stop requested", detail: event.context };
    case "terminal-exited":
      return {
        label: "Process exited",
        detail: `code ${event.exitCode}${event.signal !== undefined ? `, signal ${event.signal}` : ""}`,
      };
    case "crash-loop-backoff":
      return {
        label: "Crash-loop backoff",
        detail: `attempt ${event.attempt}, retrying in ${event.delayMs}ms`,
      };
    case "crash-loop-stopped":
      return { label: "Crash loop stopped auto-restart" };
    case "manifest-restored":
      return { label: "Restored from last session" };
    case "proxy-502":
      return { label: "Proxy 502", detail: describeProxyCause(event.cause, event.code) };
    case "proxy-ws-failed":
      return {
        label: "WebSocket upgrade failed",
        detail: describeProxyCause(event.cause, event.code),
      };
  }
}

export function describeUpstream(upstream: DevPreviewUpstreamResolution): string {
  switch (upstream.kind) {
    case "ok":
      return `localhost:${upstream.port}${upstream.isHttps ? " (https)" : ""}`;
    case "not-running":
      return `none — server ${upstream.status}`;
    case "unknown-subdomain":
      return "none — preview not registered";
  }
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

const ERROR_EVENT_TYPES: ReadonlySet<DevPreviewDiagnosticEvent["type"]> = new Set([
  "command-invalid",
  "port-conflict",
  "spawn-failed",
  "install-failed",
  "readiness-probe-timed-out",
  "readiness-probe-failed",
  "output-error",
  "crash-loop-stopped",
  "proxy-502",
  "proxy-ws-failed",
]);

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-text-secondary">{label}</dt>
      <dd className="min-w-0 truncate text-text-primary" title={value}>
        {value}
      </dd>
    </>
  );
}

/**
 * Pull-based diagnostics view for one dev-preview session: a compact summary
 * of where the session stands (ports, proxy upstream, crash-loop state) plus
 * the bounded lifecycle timeline recorded in the main process. Read-only —
 * every signal here is Tier 0; recovery actions stay on the banners and the
 * drawer toolbar that already own them.
 */
export function DiagnosticsPanel({ paneId, projectId, status }: DiagnosticsPanelProps) {
  const [result, setResult] = useState<DevPreviewDiagnosticsResult | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const fetchGenerationRef = useRef(0);

  const fetchDiagnostics = useCallback(() => {
    if (!projectId) return;
    // Tolerate a bridge that predates this IPC (older preload, partial test
    // mock): render the empty state rather than crashing the drawer.
    const getDiagnostics = window.electron?.devPreview?.getDiagnostics;
    if (typeof getDiagnostics !== "function") return;
    const generation = ++fetchGenerationRef.current;
    getDiagnostics({ panelId: paneId, projectId })
      .then((next) => {
        if (fetchGenerationRef.current !== generation) return;
        setResult(next);
        setLoadFailed(false);
      })
      .catch(() => {
        if (fetchGenerationRef.current !== generation) return;
        setLoadFailed(true);
      });
  }, [paneId, projectId]);

  useEffect(() => {
    fetchDiagnostics();
    // `status` is a refetch trigger: every lifecycle transition appends events.
  }, [fetchDiagnostics, status]);

  useEffect(() => {
    return () => {
      // Invalidate in-flight fetches on unmount.
      fetchGenerationRef.current += 1;
    };
  }, []);

  const session = result?.session ?? null;
  const proxy = result?.proxy ?? null;
  // Newest first — the question is almost always "what just happened?".
  const events = session ? [...session.events].reverse() : [];

  const crashLoop = session?.crashLoop;
  const showCrashLoop = !!crashLoop && (crashLoop.count > 0 || crashLoop.stopped);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-canvas text-xs">
      <div className="flex shrink-0 items-center justify-between border-b border-overlay/50 px-3 py-1.5">
        <span className="font-semibold text-text-secondary">Session diagnostics</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={fetchDiagnostics}
              className="rounded p-1 text-daintree-text/60 transition-colors hover:bg-overlay-medium hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-status-info"
              aria-label="Refresh diagnostics"
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Refresh diagnostics</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loadFailed ? (
          <div className="flex flex-col items-start gap-2 p-3">
            <p className="text-text-secondary">Couldn't load diagnostics for this preview.</p>
            <button
              type="button"
              onClick={fetchDiagnostics}
              className="rounded border border-overlay/50 px-2 py-1 text-text-secondary transition-colors hover:bg-overlay-medium"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            {session && (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-overlay/40 px-3 py-2">
                <SummaryRow
                  label="Status"
                  value={`${session.status}${session.restoredFromManifest ? " (restored)" : ""}`}
                />
                <SummaryRow
                  label="Allocated port"
                  value={session.allocatedPort !== null ? String(session.allocatedPort) : "none"}
                />
                <SummaryRow label="Detected URL" value={session.detectedUrl ?? "none"} />
                <SummaryRow label="Proxy upstream" value={describeUpstream(session.upstream)} />
                {proxy && (
                  <SummaryRow
                    label="Proxy port"
                    value={`${proxy.port}${proxy.usedPortFallback ? " (fallback — fixed port was taken)" : ""}`}
                  />
                )}
                {showCrashLoop && (
                  <SummaryRow
                    label="Crash loop"
                    value={
                      crashLoop.stopped
                        ? "stopped auto-restart"
                        : `${crashLoop.count} fast crash${crashLoop.count === 1 ? "" : "es"}${crashLoop.backoffPending ? ", backoff pending" : ""}`
                    }
                  />
                )}
              </dl>
            )}

            {events.length === 0 ? (
              <p className="px-3 py-4 text-text-secondary">
                No lifecycle events yet. Start the dev server to record its timeline.
              </p>
            ) : (
              <ol className="px-1 py-1">
                {events.map((event) => {
                  const { label, detail } = describeDiagnosticEvent(event);
                  const isError = ERROR_EVENT_TYPES.has(event.type);
                  return (
                    <li
                      key={event.seq}
                      className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-x-2 rounded px-2 py-0.5 hover:bg-overlay-subtle"
                    >
                      <span className="font-mono tabular-nums text-text-secondary">
                        {formatTime(event.at)}
                      </span>
                      <span
                        className={cn(
                          "whitespace-nowrap font-medium",
                          isError ? "text-status-error" : "text-text-primary"
                        )}
                      >
                        {label}
                        {event.count !== undefined && event.count > 1 && (
                          <span className="ml-1 rounded-full bg-overlay-medium px-1.5 text-3xs tabular-nums text-text-secondary">
                            ×{event.count}
                          </span>
                        )}
                      </span>
                      <span
                        className="min-w-0 truncate font-mono text-text-secondary"
                        title={detail}
                      >
                        {detail}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </>
        )}
      </div>
    </div>
  );
}
