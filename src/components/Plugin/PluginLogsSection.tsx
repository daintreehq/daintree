import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { pluginClient } from "@/clients/pluginClient";
import type { PluginDiagnosticsLogLine } from "@shared/types/ipc/pluginDiagnostics";
import { parseProjectPluginInstanceKey } from "@shared/types/plugin";

/**
 * The per-plugin log ring buffer, surfaced where its author will look (#12214).
 * The buffer has existed for as long as `host.logger` has, but only ever fed
 * the shareable bug report — so an author watching their own plugin misbehave
 * had no way to read what it had logged.
 *
 * Pull, not push: there is no log-push channel, and adding one to feed a tab
 * that is usually closed would cost more than a button. The buffer is bounded
 * and lines arrive already scrubbed of secrets, so a manual refresh is enough.
 */

const LEVEL_STYLE: Record<PluginDiagnosticsLogLine["level"], string> = {
  info: "text-text-secondary",
  warn: "text-status-warning",
  error: "text-status-danger",
};

export interface PluginLogsState {
  /** Buffered lines, or null when the host isn't running this plugin at all. */
  lines: PluginDiagnosticsLogLine[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Reads one plugin's log buffer. Lives in the detail pane rather than in the
 * tab body because the tab has to be *earned by content* (#11302) — the pane
 * cannot decide whether to offer a Logs tab without already knowing whether
 * there is anything in it.
 */
export function usePluginLogs(pluginId: string): PluginLogsState {
  const [lines, setLines] = useState<PluginDiagnosticsLogLine[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // A monotonic request token, because `mountedRef` alone does not order
  // overlapping reads: StrictMode's cleanup/setup pair flips it false then true
  // again, and two rapid refreshes can resolve out of order. Only the newest
  // request may write, so a slow first response cannot overwrite a fresh one.
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const snapshot = await pluginClient.getDiagnosticsSnapshot();
      if (!mountedRef.current || request !== requestRef.current) return;
      // A project plugin runs under an instance key rather than its manifest
      // id, and the pane knows it only by the manifest name. Parse the key
      // rather than matching its tail, so the same id in another open project
      // cannot answer for this one.
      const entry = snapshot.plugins.find(
        (plugin) =>
          plugin.pluginId === pluginId ||
          parseProjectPluginInstanceKey(plugin.pluginId)?.manifestId === pluginId
      );
      // `null` (not running, so no buffer) and `[]` (ran, logged nothing) are
      // different answers to an author's question, and the caller renders them
      // differently.
      setLines(entry ? entry.logLines : null);
      setError(null);
    } catch (err) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setError(formatErrorMessage(err, "Couldn't read this plugin's log buffer"));
    } finally {
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    }
  }, [pluginId]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  return { lines, loading, error, refresh: () => void refresh() };
}

/**
 * Presentational half. Every state it renders is reachable: the tab is only
 * offered when lines exist, but a refresh can empty the buffer (a reload clears
 * it) while the tab is open, and the read itself can fail.
 */
export function PluginLogsSection({ lines, loading, error, refresh }: PluginLogsState) {
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-text-secondary">
          The newest lines this plugin wrote through its logger. Kept in memory only, and cleared
          when the plugin reloads.
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          disabled={loading}
          className="shrink-0 text-2xs"
        >
          <SpinningIcon icon={RefreshCw} active={loading} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
          <AlertCircle className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5" />
          <p className="text-2xs text-status-danger break-words">{error}</p>
        </div>
      )}

      {!error && lines === null && !loading && (
        <p className="text-xs text-text-secondary">
          This plugin isn&apos;t running, so it has no log buffer. Activation is lazy — a plugin
          runs the first time one of its contributions is used.
        </p>
      )}

      {!error && lines !== null && lines.length === 0 && (
        <p className="text-xs text-text-secondary">
          The buffer is empty. A reload clears it, so lines reappear as the plugin logs again.
        </p>
      )}

      {lines !== null && lines.length > 0 && (
        <ol className="max-h-96 overflow-auto rounded-[var(--radius-md)] bg-surface-canvas border border-border-default divide-y divide-border-default/50">
          {lines.map((line, index) => (
            <li
              key={`${line.ts}-${index}`}
              className="flex items-baseline gap-2 px-2 py-1 font-mono text-2xs leading-relaxed"
            >
              <span className="text-text-muted tabular-nums shrink-0 select-none">
                {formatTimestamp(line.ts)}
              </span>
              <span
                className={`whitespace-pre-wrap break-words select-text ${LEVEL_STYLE[line.level]}`}
              >
                {line.message}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString(undefined, { hour12: false });
}
