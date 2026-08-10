import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { McpServerContribution } from "@shared/types/plugin";
import type {
  PluginMcpServerInfo,
  PluginMcpServerStatus,
  PluginMcpStderrResult,
} from "@shared/types/ipc/pluginMcp";

/**
 * The supervisor exposes no status-push channel, so the renderer pulls a fresh
 * snapshot on this cadence. A respawn walks `crashed → stopped → spawning →
 * ready` over a couple of ticks; 3s keeps that legible without hammering IPC.
 */
const POLL_INTERVAL_MS = 3000;

/**
 * A manifest-declared server that has never been spawned has no supervisor
 * state yet (servers are lazy-started on first agent enumeration). We surface
 * it as its own pseudo-status so the row reads "Not started" rather than
 * vanishing — the user can still start it from here.
 */
type RowStatus = PluginMcpServerStatus | "not-started";

const STATUS_DOT: Record<RowStatus, string> = {
  spawning: "bg-status-warning",
  ready: "bg-status-success",
  crashed: "bg-status-danger",
  stopped: "bg-daintree-text/30",
  "not-started": "bg-daintree-text/30",
};

const STATUS_LABEL: Record<RowStatus, string> = {
  spawning: "Starting",
  ready: "Running",
  crashed: "Crashed",
  stopped: "Stopped",
  "not-started": "Not started",
};

function serverKey(pluginId: string, serverId: string): string {
  return `${pluginId}/${serverId}`;
}

interface ServerRow {
  pluginId: string;
  serverId: string;
  name: string;
  /** Runtime snapshot, or null when the server has not been spawned yet. */
  info: PluginMcpServerInfo | null;
}

interface StderrState {
  loading: boolean;
  error: string | null;
  result: PluginMcpStderrResult | null;
}

interface PluginMcpServersSectionProps {
  pluginId: string;
  /** The plugin's declared MCP servers, from `manifest.contributes.mcpServers`. */
  declared: McpServerContribution[];
}

/**
 * Per-plugin MCP server surface (#10584). The supervisor tracks each contributed
 * stdio server's lifecycle and buffers its stderr, but nothing in the renderer
 * consumed those endpoints — a crashed server was silently unrecoverable in-app.
 * This polls `plugin-mcp:list`, shows each server's status and last error, lets
 * the user expand its buffered stderr on demand, and offers a manual restart
 * (the documented recovery path). Restart is a D1 action — local and
 * irreversible but harmless to data — so it gates on an in-flight disable, not a
 * confirmation dialog.
 */
export function PluginMcpServersSection({ pluginId, declared }: PluginMcpServersSectionProps) {
  const [servers, setServers] = useState<PluginMcpServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [stderr, setStderr] = useState<Record<string, StderrState>>({});
  const [restarting, setRestarting] = useState<Record<string, boolean>>({});
  const [restartError, setRestartError] = useState<Record<string, string>>({});

  const showLoading = useDeferredLoading(loading, UI_DOHERTY_THRESHOLD);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Poll the supervisor snapshot. Recursive setTimeout (not setInterval) so a
  // slow IPC round never stacks overlapping requests; a per-effect `cancelled`
  // flag stops a pending tick from scheduling another after unmount or a
  // pluginId switch (IPC promises aren't cancellable).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const all = await window.electron.pluginMcp.list();
        if (cancelled) return;
        setServers(all.filter((s) => s.pluginId === pluginId));
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(formatErrorMessage(err, "Couldn't load MCP server status"));
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pluginId]);

  const refreshNow = useCallback(async () => {
    try {
      const all = await window.electron.pluginMcp.list();
      if (mountedRef.current) setServers(all.filter((s) => s.pluginId === pluginId));
    } catch {
      // The poll loop will retry on its own cadence.
    }
  }, [pluginId]);

  const handleRestart = useCallback(
    async (row: ServerRow) => {
      const key = serverKey(row.pluginId, row.serverId);
      setRestarting((prev) => ({ ...prev, [key]: true }));
      setRestartError((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      try {
        // restart() resolves only after the new handshake settles (ready or
        // crashed), so the button stays disabled across the whole respawn.
        await window.electron.pluginMcp.restart({
          pluginId: row.pluginId,
          serverId: row.serverId,
        });
        // The respawn started a fresh stderr ring; drop any cached/expanded
        // output for this server so a re-expand fetches the new buffer rather
        // than showing pre-restart lines.
        if (mountedRef.current) {
          setExpanded((prev) => {
            if (!prev.has(key)) return prev;
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
          setStderr((prev) => {
            if (!(key in prev)) return prev;
            const next = { ...prev };
            delete next[key];
            return next;
          });
        }
        await refreshNow();
      } catch (err) {
        // A renderer race with plugin unload makes the main handler throw.
        if (mountedRef.current) {
          setRestartError((prev) => ({
            ...prev,
            [key]: formatErrorMessage(err, "Couldn't restart server"),
          }));
        }
        await refreshNow();
      } finally {
        if (mountedRef.current) {
          setRestarting((prev) => {
            if (!(key in prev)) return prev;
            const next = { ...prev };
            delete next[key];
            return next;
          });
        }
      }
    },
    [refreshNow]
  );

  // `isOpen` comes from committed render state, not from inside the updater:
  // React 19 only runs a functional updater synchronously on its eager-state
  // path (no pending lanes). With the poll's setServers or useDeferredLoading's
  // timer in flight, the updater is deferred — so deriving `willOpen` inside it
  // left it stale, returned before getStderr() ran, and stranded the disclosure
  // on a perpetual "Loading output…". Keep the updater pure.
  const toggleStderr = useCallback(async (row: ServerRow, isOpen: boolean) => {
    const key = serverKey(row.pluginId, row.serverId);
    const willOpen = !isOpen;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (isOpen) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
    if (!willOpen) return;
    setStderr((prev) => ({
      ...prev,
      [key]: { loading: true, error: null, result: prev[key]?.result ?? null },
    }));
    try {
      const result = await window.electron.pluginMcp.getStderr({
        pluginId: row.pluginId,
        serverId: row.serverId,
      });
      if (mountedRef.current) {
        setStderr((prev) => ({ ...prev, [key]: { loading: false, error: null, result } }));
      }
    } catch (err) {
      if (mountedRef.current) {
        setStderr((prev) => ({
          ...prev,
          [key]: {
            loading: false,
            error: formatErrorMessage(err, "Couldn't load server output"),
            result: null,
          },
        }));
      }
    }
  }, []);

  // Merge declared servers (manifest) with live supervisor states. Declared
  // servers anchor the list and stay visible before first spawn; any retained
  // state whose contribution was dropped from the manifest still surfaces so a
  // lingering crashed subprocess isn't hidden.
  const byId = new Map(servers.map((s) => [s.serverId, s]));
  const rows: ServerRow[] = declared.map((d) => ({
    pluginId,
    serverId: d.id,
    name: d.name,
    info: byId.get(d.id) ?? null,
  }));
  const declaredIds = new Set(declared.map((d) => d.id));
  for (const s of servers) {
    if (!declaredIds.has(s.serverId)) {
      rows.push({ pluginId, serverId: s.serverId, name: s.name, info: s });
    }
  }

  if (rows.length === 0) {
    return (
      <div className="space-y-3">
        {showLoading && <p className="text-xs text-daintree-text/40">Loading…</p>}
        {!loading && (
          <p className="text-xs text-daintree-text/40">This plugin has no MCP servers.</p>
        )}
        {error && <SectionError message={error} />}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-daintree-text/50">
        Servers this plugin runs to provide tools. Restart one if it crashes.
      </p>
      <ul className="space-y-2">
        {rows.map((row) => {
          const key = serverKey(row.pluginId, row.serverId);
          const status: RowStatus = row.info?.status ?? "not-started";
          const isRestarting = restarting[key] === true;
          const isSpawning = status === "spawning";
          const isOpen = expanded.has(key);
          const stderrState = stderr[key];
          const hasOutput = (row.info?.stderrLineCount ?? 0) > 0;
          const rowRestartError = restartError[key];
          return (
            <li
              key={key}
              className="rounded-[var(--radius-md)] border border-daintree-border overflow-hidden"
            >
              <div className="flex items-center gap-3 px-3 py-2.5">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[status]} ${
                    isSpawning ? "animate-pulse" : ""
                  }`}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-daintree-text truncate">{row.name}</div>
                  <div className="text-[11px] text-daintree-text/40">
                    {STATUS_LABEL[status]}
                    {row.info?.pid != null && status === "ready" && ` · pid ${row.info.pid}`}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleRestart(row)}
                  disabled={isRestarting || isSpawning}
                  className="shrink-0"
                >
                  <SpinningIcon icon={RefreshCw} active={isRestarting} className="w-3.5 h-3.5" />
                  {status === "not-started" ? "Start server" : "Restart server"}
                </Button>
              </div>

              {row.info?.lastError && status === "crashed" && (
                <div className="mx-3 mb-2.5 flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
                  <AlertCircle className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5" />
                  <p className="text-[11px] text-status-danger break-words select-text">
                    {row.info.lastError}
                  </p>
                </div>
              )}

              {rowRestartError && (
                <div className="mx-3 mb-2.5 flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
                  <AlertCircle className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5" />
                  <p className="text-[11px] text-status-danger break-words">{rowRestartError}</p>
                </div>
              )}

              {hasOutput && (
                <div className="border-t border-daintree-border/60">
                  <button
                    type="button"
                    onClick={() => void toggleStderr(row, isOpen)}
                    aria-expanded={isOpen}
                    className="flex items-center gap-1.5 w-full px-3 py-2 text-[11px] text-daintree-text/50 hover:text-daintree-text/80 transition-[color] duration-150"
                  >
                    {isOpen ? (
                      <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                    )}
                    <span>{isOpen ? "Hide output" : "View output"}</span>
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-3">
                      <StderrView state={stderrState} />
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && <SectionError message={error} />}
    </div>
  );
}

function StderrView({ state }: { state: StderrState | undefined }) {
  if (!state || (state.loading && !state.result)) {
    return <p className="text-[11px] text-daintree-text/40">Loading output…</p>;
  }
  if (state.error) {
    return <p className="text-[11px] text-status-danger">{state.error}</p>;
  }
  const result = state.result;
  if (!result || result.lines.length === 0) {
    return <p className="text-[11px] text-daintree-text/40">No output captured.</p>;
  }
  const hidden = result.totalLines - result.lines.length;
  return (
    <div className="space-y-1.5">
      {hidden > 0 && (
        <p className="text-[10px] text-daintree-text/40">
          Showing the most recent {result.lines.length} of {result.totalLines} lines.
        </p>
      )}
      <pre className="max-h-48 overflow-auto rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border p-2 font-mono text-[11px] leading-relaxed text-daintree-text/80 whitespace-pre-wrap break-words select-text">
        {result.lines.join("\n")}
      </pre>
    </div>
  );
}

function SectionError({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
      <AlertCircle className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5" />
      <p className="text-[11px] text-status-danger break-words">{message}</p>
    </div>
  );
}
