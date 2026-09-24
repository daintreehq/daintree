import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { CircleStop, Play, RotateCw, Server, X } from "lucide-react";
import type { DevPreviewSessionState, DevPreviewSessionStatus } from "@shared/types/ipc/devPreview";
import { cn } from "@/lib/utils";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useAllDevSessions } from "@/store/allDevSessionsStore";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { worktreeLabels } from "@/lib/worktreeLabels";
import { useSkeletonFloor, useSkeletonGate } from "@/hooks/useDeferredLoading";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";

// Status dot colors reuse the dev-server semantic tokens (--color-server-*),
// the same ones DevPreview's ConsoleDrawer uses — NOT the panel-state-* border
// classes (those drive the animated ContentPanel edge) and not the accent token.
const STATUS_PRESENTATION: Record<DevPreviewSessionStatus, { label: string; dotClass: string }> = {
  stopped: { label: "Stopped", dotClass: "bg-server-stopped" },
  starting: { label: "Starting", dotClass: "bg-server-starting" },
  installing: { label: "Installing", dotClass: "bg-server-starting" },
  running: { label: "Running", dotClass: "bg-server-running" },
  stopping: { label: "Stopping", dotClass: "bg-server-starting" },
  error: { label: "Error", dotClass: "bg-server-error" },
  "restored-stopped": { label: "Stopped", dotClass: "bg-server-stopped" },
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
const PROGRESS_STATUSES: ReadonlySet<DevPreviewSessionStatus> = new Set([
  "starting",
  "installing",
  "stopping",
]);
const STOPPED_STATUSES: ReadonlySet<DevPreviewSessionStatus> = new Set([
  "stopped",
  "restored-stopped",
]);

const actionClass =
  "toolbar-icon-button flex w-6 h-6 items-center justify-center rounded-[var(--radius-md)] text-text-secondary disabled:opacity-30 disabled:cursor-not-allowed";

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
  const isError = session.status === "error";
  const isStopped = STOPPED_STATUSES.has(session.status);
  const canStop = worktreeId !== undefined && STOPPABLE_STATUSES.has(session.status);
  // The second line answers "is it up, and where": an error names its reason,
  // a server still coming up shows its progress, and a running one stops at
  // its port — routine log lines stay in the row's tooltip.
  const detail = isError
    ? (session.error?.message ?? session.lastOutput)
    : PROGRESS_STATUSES.has(session.status)
      ? session.lastOutput
      : undefined;

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

  const restartLabel = isStopped ? "Start" : "Restart";
  // Stopping an errored session only clears its error — there is no process.
  const stopLabel = isError ? "Dismiss error" : "Stop";

  return (
    <li
      title={session.lastOutput}
      className="group flex items-center gap-2.5 pl-3 pr-2 py-1.5 hover:bg-overlay-subtle transition-colors duration-150"
    >
      <span
        className={cn("status-mark flex-shrink-0 w-2 h-2 rounded-full", presentation.dotClass)}
        aria-hidden="true"
      />
      <div className="flex flex-col min-w-0 flex-1">
        <span className="truncate text-xs font-medium text-text-primary">{worktreeName}</span>
        <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-text-secondary">
          <span className="shrink-0">{presentation.label}</span>
          {port && <span className="shrink-0 tabular-nums">:{port}</span>}
          {detail && (
            <span className="min-w-0 truncate" title={detail}>
              {detail}
            </span>
          )}
        </span>
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <button
          type="button"
          onClick={handleRestart}
          disabled={!worktreeId}
          aria-label={`${restartLabel} dev server for ${worktreeName}`}
          title={restartLabel}
          className={actionClass}
        >
          {isStopped ? <Play className="w-3.5 h-3.5" /> : <RotateCw className="w-3.5 h-3.5" />}
        </button>
        {!isStopped && (
          <button
            type="button"
            onClick={handleStop}
            disabled={!canStop}
            aria-label={
              isError ? `Dismiss error for ${worktreeName}` : `Stop dev server for ${worktreeName}`
            }
            title={stopLabel}
            className={actionClass}
          >
            {isError ? <X className="w-3.5 h-3.5" /> : <CircleStop className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
    </li>
  );
}

function summarize(sessions: DevPreviewSessionState[]): string {
  const running = sessions.filter((s) => s.status === "running").length;
  const failed = sessions.filter((s) => s.status === "error").length;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

export function DevServerDashboard({ onHide }: { onHide?: () => void }) {
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
  // A worktree this view can't name (another project's, or one still loading)
  // is named from its id, which is its path — by the shortest trailing part
  // that no other unnamed row shares, so two "main" checkouts don't read, and
  // announce, as the same row. Never the whole path as a title.
  const fallbackNames = useMemo(
    () =>
      worktreeLabels([
        ...new Set(
          visibleSessions
            .map((s) => s.worktreeId)
            .filter((id): id is string => !!id && worktreeNames[id] === undefined)
        ),
      ]),
    [visibleSessions, worktreeNames]
  );

  const summary = summarize(visibleSessions);
  const showSkeleton = useSkeletonFloor(useSkeletonGate(!hydrated));

  return (
    <section
      aria-label="Dev servers"
      className="flex flex-col flex-shrink-0 max-h-[40%] min-h-0 border-t border-divider bg-surface-canvas"
    >
      <header className="flex items-center gap-2 h-9 shrink-0 pl-3 pr-2">
        <Server className="w-3.5 h-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
        <h2 className="text-xs font-medium text-text-primary">Dev servers</h2>
        {summary && (
          <span className="min-w-0 truncate text-xs tabular-nums text-text-secondary">
            {summary}
          </span>
        )}
        <div className="flex-1" />
        {onHide && (
          <button
            type="button"
            onClick={onHide}
            aria-label="Hide dev servers"
            title="Hide dev servers"
            className={actionClass}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </header>
      {showSkeleton ? (
        <Skeleton label="Loading dev servers" className="flex flex-col gap-3 pl-3 pr-2 pt-1.5 pb-3">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-2.5">
              <SkeletonBone className="w-2 h-2 rounded-full" />
              <div className="flex flex-col gap-1.5 flex-1">
                <SkeletonBone className="h-2.5 w-1/3" />
                <SkeletonBone className="h-2.5 w-2/3" />
              </div>
            </div>
          ))}
        </Skeleton>
      ) : !hydrated ? null : visibleSessions.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-text-secondary">
          {fetchError
            ? "Couldn't load dev servers"
            : "Open a Dev Server panel in any worktree to start one"}
        </p>
      ) : (
        <ul className="flex flex-col min-h-0 overflow-y-auto pb-1">
          {visibleSessions.map((session) => (
            <DevServerRow
              key={`${session.projectId}:${session.panelId}`}
              session={session}
              worktreeName={
                session.worktreeId
                  ? (worktreeNames[session.worktreeId] ??
                    fallbackNames.get(session.worktreeId) ??
                    session.worktreeId)
                  : session.panelId
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}
