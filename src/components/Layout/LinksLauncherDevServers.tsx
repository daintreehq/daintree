import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { CircleStop, ExternalLink, Play, RotateCw, X } from "lucide-react";
import type { DevPreviewSessionState, DevPreviewSessionStatus } from "@shared/types/ipc/devPreview";
import { cn } from "@/lib/utils";
import { SeverityMark } from "@/lib/statusSeverity";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { devServerAddress, devServerPanelInView } from "@/services/openDevServer";
import { LIST_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { scratchName, useScratchStore } from "@/store/scratchStore";
import { isScratchWorkspaceId } from "@shared/utils/workspaceIds";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { worktreeLabels } from "@/lib/worktreeLabels";
import { useSkeletonFloor, useSkeletonGate } from "@/hooks/useDeferredLoading";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import {
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_ICON_CLASS,
} from "@/components/ui/paneToolbarStyles";
import { LinksLauncherRow } from "./LinksLauncherRow";

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

export const DEV_SERVERS_HEADING = "Dev servers";

/** What the launcher knows of every dev server on this machine. */
export interface DevSessionsSnapshot {
  sessions: DevPreviewSessionState[];
  hydrated: boolean;
  fetchError: boolean;
}

/**
 * A plain "stopped" session has no row; "restored-stopped" stays listed
 * because it is an explicit restart offer.
 */
export function listedDevSessions(sessions: DevPreviewSessionState[]): DevPreviewSessionState[] {
  return sessions.filter((session) => session.status !== "stopped");
}

/**
 * Whether the launcher has a dev servers section to show: a row, a first load
 * still running (its skeleton), or a load that failed (said so). With none of
 * those the section is left out rather than shown empty.
 */
export function hasDevServersSection({
  sessions,
  hydrated,
  fetchError,
}: DevSessionsSnapshot): boolean {
  return !hydrated || fetchError || listedDevSessions(sessions).length > 0;
}

// "error" is stoppable: errored sessions have no terminal, so stop() takes the
// no-terminal branch — transitions to "stopped" and clears the error, which is
// the only way to dismiss an errored row from the list.
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

const actionClass = PANE_TOOLBAR_ICON_BUTTON_CLASS;

/**
 * Where the server is, as a browser's address bar would show it
 * (`localhost:5824`): the address it runs at, else the one it is expected at.
 */
function displayAddress(session: DevPreviewSessionState): string | null {
  const target = session.url ?? session.predictedUrl;
  if (!target) return null;
  try {
    return new URL(target).host || null;
  } catch {
    return null;
  }
}

function rowKey(session: DevPreviewSessionState): string {
  return `${session.projectId}:${session.panelId}`;
}

function DevServerRow({
  session,
  displayName,
  rowId,
  onOpen,
  onOpenExternal,
}: {
  session: DevPreviewSessionState;
  displayName: string;
  rowId: string;
  onOpen: (session: DevPreviewSessionState) => void;
  onOpenExternal: (url: string) => void;
}) {
  const presentation = STATUS_PRESENTATION[session.status];
  const address = displayAddress(session);
  // Only a running server has somewhere to go; every other row is a status
  // with its own controls.
  const url = devServerAddress(session);
  const isError = session.status === "error";
  // A compile error keeps its terminal: stopping then kills a live watcher, so
  // only a process-less error is a pure dismissal.
  const isDismissableError = isError && !session.terminalId;
  const isStopped = STOPPED_STATUSES.has(session.status);
  const canStop = STOPPABLE_STATUSES.has(session.status);
  // The detail answers "is it up, and where": a running server shows the
  // address it opens, an error names its reason, a server still coming up
  // shows its progress — routine log lines stay in the status's tooltip.
  const detail = isError
    ? (session.error?.message ?? session.lastOutput)
    : PROGRESS_STATUSES.has(session.status)
      ? session.lastOutput
      : undefined;

  // Each row is one panel's session: a worktree can hold several previews (an
  // app beside its Storybook), and a plain folder or scratch has no worktree at
  // all, so the row's own key is the only target that can't hit a sibling.
  const target = { panelId: session.panelId, projectId: session.projectId };

  const handleRestart = () => {
    safeFireAndForget(window.electron.devPreview.restart(target), {
      context: "Restarting dev server from the links launcher",
    });
  };

  const handleStop = () => {
    if (!canStop) return;
    safeFireAndForget(window.electron.devPreview.stop(target), {
      context: "Stopping dev server from the links launcher",
    });
  };

  const restartLabel = isStopped ? "Start" : "Restart";
  // Stopping an errored session only clears its error — there is no process.
  const stopLabel = isDismissableError ? "Dismiss error" : "Stop";

  return (
    <LinksLauncherRow
      rowId={rowId}
      icon={
        isError ? (
          <SeverityMark
            severity="error"
            label={presentation.label}
            className="h-4 w-4 shrink-0"
            decorative
          />
        ) : (
          <span
            className={cn("status-mark mx-1 h-2 w-2 shrink-0 rounded-full", presentation.dotClass)}
            aria-hidden="true"
          />
        )
      }
      title={displayName}
      revealTitle
      // A running row is about its address; the name gives way to it.
      keepDetail={url !== undefined}
      detail={
        // The log line rides the status only: on the row it would be inherited
        // by the action buttons, and on the name it would sit over that name's
        // own full-text reveal.
        <StatusLine
          label={presentation.label}
          showLabel={url === undefined}
          address={address}
          detail={detail}
          lastOutput={session.lastOutput}
        />
      }
      url={url}
      // The row knows its server by panel, not by address: another worktree's
      // or project's server can share a port with one here.
      opensPanel={() => devServerPanelInView(session) !== undefined}
      onOpen={() => onOpen(session)}
      actions={
        <>
          {url !== undefined && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onOpenExternal(url)}
                  aria-label={`Open dev server for ${displayName} in external browser`}
                  className={actionClass}
                >
                  <ExternalLink className={PANE_TOOLBAR_ICON_CLASS} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Open in external browser</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleRestart}
                aria-label={`${restartLabel} dev server for ${displayName}`}
                className={actionClass}
              >
                {isStopped ? (
                  <Play className={PANE_TOOLBAR_ICON_CLASS} />
                ) : (
                  <RotateCw className={PANE_TOOLBAR_ICON_CLASS} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{restartLabel}</TooltipContent>
          </Tooltip>
          {!isStopped && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleStop}
                  // Not `disabled`: a server going down disables its Stop, and a
                  // disabled control drops the keyboard focus that was on it.
                  aria-disabled={!canStop || undefined}
                  aria-label={
                    isDismissableError
                      ? `Dismiss error for ${displayName}`
                      : `Stop dev server for ${displayName}`
                  }
                  className={actionClass}
                >
                  {isDismissableError ? (
                    <X className={PANE_TOOLBAR_ICON_CLASS} />
                  ) : (
                    <CircleStop className={PANE_TOOLBAR_ICON_CLASS} />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{stopLabel}</TooltipContent>
            </Tooltip>
          )}
        </>
      }
    />
  );
}

export function summarizeDevServers(sessions: DevPreviewSessionState[]): string {
  const running = sessions.filter((s) => s.status === "running").length;
  const failed = sessions.filter((s) => s.status === "error").length;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

/**
 * The launcher's section listing every dev server across this machine's
 * worktrees, with its status and its start or restart and stop (#17251). A
 * running server's row opens it: its own preview when that is a panel of this
 * view, else its address in the system browser, which it also offers outright.
 * Renders nothing when {@link hasDevServersSection} says there is nothing to
 * show, or while a first load is too young for its skeleton.
 */
export function LinksLauncherDevServers({
  snapshot,
  sectionId,
  onOpen,
  onOpenExternal,
}: {
  snapshot: DevSessionsSnapshot;
  sectionId: string;
  /** Opens a running server where it lives: its own preview, else the system browser. */
  onOpen: (session: DevPreviewSessionState) => void;
  /** Opens a running server's address in the system browser, wherever it lives. */
  onOpenExternal: (url: string) => void;
}) {
  const { sessions: allSessions, hydrated } = snapshot;
  // Select only the names this list renders: the worktrees Map identity
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
  // A session with no worktree (a plain folder, a scratch) is named after its
  // workspace, from every project and scratch on this machine, since the
  // list shows other projects' servers too.
  const projectNames = useProjectStore(
    useShallow((s) => {
      const names: Record<string, string> = {};
      for (const session of allSessions) {
        if (session.worktreeId) continue;
        const name = s.projects.find((p) => p.id === session.projectId)?.name.trim();
        if (name) names[session.projectId] = name;
      }
      return names;
    })
  );
  const scratchNames = useScratchStore(
    useShallow((s) => {
      const names: Record<string, string> = {};
      for (const session of allSessions) {
        if (session.worktreeId) continue;
        const name = scratchName(s.scratches, session.projectId)?.trim();
        if (name) names[session.projectId] = name;
      }
      return names;
    })
  );

  const visibleSessions = useMemo(() => listedDevSessions(allSessions), [allSessions]);
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

  // Two previews in one worktree (or one workspace) share its name, so each
  // takes a panel number, ordered by its key rather than its status or the
  // snapshot's order so a row keeps its number as servers come and go.
  const displayNames = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const session of visibleSessions) {
      const name = session.worktreeId
        ? (worktreeNames[session.worktreeId] ??
          fallbackNames.get(session.worktreeId) ??
          session.worktreeId)
        : (projectNames[session.projectId] ??
          scratchNames[session.projectId] ??
          (isScratchWorkspaceId(session.projectId) ? "Scratch workspace" : "Workspace"));
      const keys = groups.get(name);
      if (keys) keys.push(rowKey(session));
      else groups.set(name, [rowKey(session)]);
    }
    const names = new Map<string, string>();
    for (const [name, keys] of groups) {
      if (keys.length === 1) {
        names.set(keys[0]!, name);
        continue;
      }
      keys.sort().forEach((key, index) => names.set(key, `${name} · panel ${index + 1}`));
    }
    return names;
  }, [visibleSessions, worktreeNames, fallbackNames, projectNames, scratchNames]);

  const summary = summarizeDevServers(visibleSessions);
  const showSkeleton = useSkeletonFloor(useSkeletonGate(!hydrated));
  if (!hasDevServersSection(snapshot) || (!hydrated && !showSkeleton)) return null;
  const headingId = `${sectionId}-heading`;

  return (
    <section aria-labelledby={headingId}>
      <div className="flex min-w-0 items-baseline gap-2 px-3 pt-1.5 pb-1">
        <h2 id={headingId} className={cn(LIST_LABEL_CLASS, "shrink-0")}>
          {DEV_SERVERS_HEADING}
        </h2>
        {summary && (
          <span className="min-w-0 truncate text-xs tabular-nums text-text-secondary">
            {summary}
          </span>
        )}
      </div>
      {showSkeleton ? (
        <Skeleton label="Loading dev servers" className="flex flex-col gap-3 px-3 pt-1.5 pb-3">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-2.5">
              <SkeletonBone immediate className="w-2 h-2 rounded-full" />
              <div className="flex flex-col gap-1.5 flex-1">
                <SkeletonBone immediate className="h-2.5 w-1/3" />
                <SkeletonBone immediate className="h-2.5 w-2/3" />
              </div>
            </div>
          ))}
        </Skeleton>
      ) : visibleSessions.length === 0 ? (
        <p className="px-3 pb-2 text-xs text-text-secondary">Couldn't load dev servers</p>
      ) : (
        <ul className="flex flex-col">
          {visibleSessions.map((session) => (
            <DevServerRow
              key={rowKey(session)}
              rowId={`${sectionId}-${rowKey(session)}`}
              session={session}
              displayName={displayNames.get(rowKey(session)) ?? ""}
              onOpen={onOpen}
              onOpenExternal={onOpenExternal}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * A shown detail reveals itself when clipped. The last log line, whenever the
 * row is not already showing it, is the tooltip on the status: the whole story
 * for a running server, and what preceded the error for a failed one. A
 * running row's address says it is up, so its label is for screen readers.
 */
function StatusLine({
  label,
  showLabel,
  address,
  detail,
  lastOutput,
}: {
  label: string;
  showLabel: boolean;
  address: string | null;
  detail: string | undefined;
  lastOutput: string | undefined;
}) {
  const status = (
    <span className="flex shrink-0 items-baseline gap-1.5">
      <span className={showLabel ? undefined : "sr-only"}>{label}</span>
      {/* Read between the two; a flex container doesn't draw it. */}
      {address && " "}
      {address && <span className="tabular-nums">{address}</span>}
    </span>
  );
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      {lastOutput && lastOutput !== detail ? (
        <Tooltip>
          <TooltipTrigger asChild>{status}</TooltipTrigger>
          <TooltipContent side="bottom" align="start" className="break-words">
            {lastOutput}
          </TooltipContent>
        </Tooltip>
      ) : (
        status
      )}
      {detail && (
        <TruncatedTooltip content={detail}>
          <span className="min-w-0 truncate">{detail}</span>
        </TruncatedTooltip>
      )}
    </span>
  );
}
