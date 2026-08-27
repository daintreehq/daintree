import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { RotateCw, Square } from "lucide-react";
import type { DevPreviewSessionState, DevPreviewSessionStatus } from "@shared/types/ipc/devPreview";
import { cn } from "@/lib/utils";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useAllDevSessions } from "@/store/allDevSessionsStore";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

// Status dot colors reuse the dev-server semantic tokens (--color-server-*),
// the same ones DevPreview's ConsoleDrawer uses — NOT the panel-state-* border
// classes (those drive the animated ContentPanel edge) and not the accent token.
const STATUS_PRESENTATION: Record<DevPreviewSessionStatus, { label: string; dotClass: string }> = {
  stopped: { label: "Stopped", dotClass: "bg-daintree-text/40" },
  starting: { label: "Starting", dotClass: "bg-server-starting" },
  installing: { label: "Installing", dotClass: "bg-server-starting" },
  running: { label: "Running", dotClass: "bg-server-running" },
  stopping: { label: "Stopping", dotClass: "bg-server-starting" },
  error: { label: "Error", dotClass: "bg-server-error" },
  "restored-stopped": { label: "Stopped", dotClass: "bg-daintree-text/40" },
};

// A plain "stopped" session has no row; "restored-stopped" stays visible because
// it is an explicit restart offer the dashboard should surface.
const HIDDEN_STATUSES: ReadonlySet<DevPreviewSessionStatus> = new Set(["stopped"]);
// "error" is stoppable: errored sessions have no terminal, so stop() takes the
// no-terminal branch — transitions to "stopped" and clears the error, which is
// the only way to dismiss an errored row from the dashboard.
const STOPPABLE_STATUSES: ReadonlySet<DevPreviewSessionStatus> = new Set([
  "starting",
  "installing",
  "running",
  "error",
]);

function extractPort(session: DevPreviewSessionState): string | null {
  const target = session.url ?? session.predictedUrl;
  if (!target) return null;
  try {
    return new URL(target).port || null;
  } catch {
    return null;
  }
}

function DevServerRow({
  session,
  worktreeName,
}: {
  session: DevPreviewSessionState;
  worktreeName: string;
}) {
  const presentation = STATUS_PRESENTATION[session.status];
  const port = extractPort(session);
  const worktreeId = session.worktreeId;
  const canStop = worktreeId !== undefined && STOPPABLE_STATUSES.has(session.status);

  const handleRestart = () => {
    if (!worktreeId) return;
    safeFireAndForget(window.electron.devPreview.restartByWorktree({ worktreeId }), {
      context: "Restarting dev server from dashboard",
    });
  };

  const handleStop = () => {
    if (!worktreeId) return;
    safeFireAndForget(window.electron.devPreview.stopDevServerByWorktree({ worktreeId }), {
      context: "Stopping dev server from dashboard",
    });
  };

  return (
    <li className="flex items-center gap-2 px-3 py-1.5 hover:bg-overlay-subtle transition-colors">
      <span
        className={cn("status-mark flex-shrink-0 w-1.5 h-1.5 rounded-full", presentation.dotClass)}
        aria-hidden="true"
      />
      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium text-daintree-text">{worktreeName}</span>
          {port && (
            <span className="flex-shrink-0 text-xs tabular-nums text-daintree-text/50">
              :{port}
            </span>
          )}
          <span className="flex-shrink-0 text-xs text-text-secondary">{presentation.label}</span>
        </div>
        {session.lastOutput && (
          <span className="truncate text-xs text-daintree-text/45">{session.lastOutput}</span>
        )}
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <button
          type="button"
          onClick={handleRestart}
          disabled={!worktreeId}
          aria-label={`Restart dev server for ${worktreeName}`}
          title="Restart"
          className="p-1 rounded hover:bg-tint/[0.06] text-muted-foreground hover:text-daintree-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
        >
          <RotateCw className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={handleStop}
          disabled={!canStop}
          aria-label={`Stop dev server for ${worktreeName}`}
          title="Stop"
          className="p-1 rounded hover:bg-tint/[0.06] text-muted-foreground hover:text-daintree-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
        >
          <Square className="w-3.5 h-3.5" />
        </button>
      </div>
    </li>
  );
}

export function DevServerDashboard() {
  const { sessions: allSessions, hydrated, fetchError } = useAllDevSessions();
  // Select only the names this dashboard renders: the worktrees Map identity
  // changes on every polled git-status delta, but a flat Record of primitives
  // lets useShallow skip the re-render unless a relevant name changes.
  const worktreeNames = useWorktreeStore(
    useShallow((s) => {
      const names: Record<string, string> = {};
      for (const session of allSessions) {
        if (!session.worktreeId) continue;
        const name = s.worktrees.get(session.worktreeId)?.name;
        if (name !== undefined) names[session.worktreeId] = name;
      }
      return names;
    })
  );

  const visibleSessions = useMemo(
    () => allSessions.filter((s) => !HIDDEN_STATUSES.has(s.status)),
    [allSessions]
  );

  return (
    <section
      aria-label="Dev servers"
      className="flex-shrink-0 border-t border-daintree-border bg-daintree-bg"
    >
      <header className="px-3 pt-2 pb-1 text-xs font-medium uppercase tracking-wide text-daintree-text/55">
        Dev servers
      </header>
      {!hydrated ? null : visibleSessions.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-daintree-text/50">
          {fetchError ? "Couldn't load dev servers" : "No active dev servers"}
        </p>
      ) : (
        <ul className="flex flex-col pb-1">
          {visibleSessions.map((session) => (
            <DevServerRow
              key={`${session.projectId}:${session.panelId}`}
              session={session}
              worktreeName={
                session.worktreeId
                  ? (worktreeNames[session.worktreeId] ?? session.worktreeId)
                  : session.panelId
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}
