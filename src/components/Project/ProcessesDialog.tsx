import { useEffect, useRef, useState, type ReactElement } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import { isDevPreviewKind } from "@shared/types/panel";
import type {
  ClosedProcessKillResult,
  ProcessInventoryPluginProcess,
  ProcessInventorySnapshot,
  ProcessInventoryTerminal,
  ProcessTreeSample,
} from "@shared/types/processes";
import { AppDialog, type RestoreFocusTarget } from "@/components/ui/AppDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { terminalClient } from "@/clients/terminalClient";
import { processesClient } from "@/clients/processesClient";
import { pluralize } from "@/lib/pluralize";
import { isProjectViewCached } from "@/lib/viewCacheState";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import {
  closedProcessKey,
  describeCleanupReport,
  describeClosedMembers,
  describeMembers,
  describeTerminalKind,
  formatAgo,
  formatApproxMemory,
  formatCpu,
  groupClosedProcesses,
  groupProcessesByProject,
  type ClosedProcessGroup,
  pluginProcessTitle,
  sortPluginProcesses,
  terminalTitle,
  trashSecondsLeft,
} from "./processesView";

const POLL_MS = 4_000;
const TICK_MS = 1_000;
/** Below this the reading is simply current; past it the age earns a line. */
const STALE_AFTER_MS = 10_000;

interface ProcessesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  restoreFocusTo?: RestoreFocusTarget;
}

/**
 * Decided before the confirm opens, so the dialog names what will actually
 * happen: a dev preview stops through its session (which also cancels its
 * recovery), anything else gets the terminal kill.
 */
type KillTarget =
  | { via: "pty"; terminal: ProcessInventoryTerminal }
  | { via: "dev-session"; terminal: ProcessInventoryTerminal; projectId: string; panelId: string };

function incarnationKey(terminal: ProcessInventoryTerminal): string {
  return `${terminal.id}@${terminal.spawnedAt}`;
}

type ReadOutcome = {
  snapshot: ProcessInventorySnapshot | null;
  snapshotError: unknown;
  sessions: DevPreviewSessionState[] | null;
};

/** Settled one by one: a failed session read must not hold back the list. */
async function readProcesses(): Promise<ReadOutcome> {
  const [snapshotResult, sessionsResult] = await Promise.allSettled([
    processesClient.getSnapshot(),
    window.electron.devPreview.getAllSessions(),
  ]);
  return {
    snapshot: snapshotResult.status === "fulfilled" ? snapshotResult.value : null,
    snapshotError: snapshotResult.status === "rejected" ? snapshotResult.reason : null,
    sessions: sessionsResult.status === "fulfilled" ? sessionsResult.value : null,
  };
}

/**
 * Read the dev-preview sessions fresh: a dev preview's PTY must stop through its
 * session, and a stale or failed read would silently pick the raw kill instead.
 * Rejects when the sessions can't be read, so nothing is offered.
 */
async function resolveKillTarget(
  terminal: ProcessInventoryTerminal
): Promise<{ target: KillTarget; sessionTerminalIds: Set<string> }> {
  const sessions = await window.electron.devPreview.getAllSessions();
  const session = sessions.find((candidate) => candidate.terminalId === terminal.id);
  return {
    target: session
      ? { via: "dev-session", terminal, projectId: session.projectId, panelId: session.panelId }
      : { via: "pty", terminal },
    sessionTerminalIds: sessionTerminalIdsOf(sessions),
  };
}

function sessionTerminalIdsOf(sessions: DevPreviewSessionState[]): Set<string> {
  return new Set(
    sessions.map((session) => session.terminalId).filter((id): id is string => id !== null)
  );
}

type KillOutcome =
  { status: "ended" } | { status: "replaced" } | { status: "failed"; message: string };

/**
 * End the confirmed process — and only that one. A dev preview stops through
 * its session every time: that also cancels a recovery or reinstall waiting to
 * relaunch it, which a PTY that already left would not show. A terminal is
 * killed by id, so a pane that restarted while the confirm was open would take
 * the new process with it; its generation is re-read from the owning host right
 * before the kill and a replacement is refused.
 */
async function endProcess(target: KillTarget): Promise<KillOutcome> {
  try {
    if (target.via === "dev-session") {
      await window.electron.devPreview.stop({
        projectId: target.projectId,
        panelId: target.panelId,
      });
      return { status: "ended" };
    }
    const live = await window.electron.terminal.getInfo(target.terminal.id);
    if (live.spawnedAt !== target.terminal.spawnedAt) return { status: "replaced" };
    if (live.hasPty === false) return { status: "ended" };
    await terminalClient.kill(target.terminal.id);
    return { status: "ended" };
  } catch (error) {
    return { status: "failed", message: formatErrorMessage(error, "The process didn't respond.") };
  }
}

const CLOSED_KILL_PREFIX = "closed:";

/**
 * Says what the kill observed when it didn't see every process end. Returns
 * null when it did — the rows leaving the list say that on their own.
 */
function describeClosedKillShortfall(
  result: ClosedProcessKillResult,
  requested: number
): string | null {
  const parts: string[] = [];
  if (result.stillRunning > 0) {
    parts.push(`${pluralize(result.stillRunning, "process is", "processes are")} still running.`);
  }
  if (result.unchecked > 0) {
    parts.push(
      `Couldn't check ${pluralize(result.unchecked, "process", "processes")}, so ${
        result.unchecked === 1 ? "it may still be" : "they may still be"
      } running.`
    );
  }
  if (parts.length === 0) return null;
  const ended = result.ended + result.notTracked;
  return `Ended ${ended} of ${pluralize(requested, "process", "processes")}. ${parts.join(" ")}`;
}

/**
 * Every row and the column heading share one grid, so CPU and memory line up
 * down the whole list whatever the row kind; a row with no action keeps the
 * action column empty rather than letting its readings slide right.
 */
const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_3rem_4.5rem_8rem] items-center gap-x-3";

function Reading({ label, value }: { label: string; value: string | null }): ReactElement {
  return (
    <span className="text-right text-xs tabular-nums text-text-secondary">
      <span className="sr-only">{label} </span>
      {value ?? (
        <>
          <span aria-hidden="true">—</span>
          <span className="sr-only">not sampled</span>
        </>
      )}
    </span>
  );
}

function SampleReadings({ sample }: { sample: ProcessTreeSample | null }): ReactElement {
  return (
    <>
      <Reading label="CPU" value={sample ? formatCpu(sample.cpuPercent) : null} />
      <Reading label="Memory" value={sample ? formatApproxMemory(sample.memoryKb) : null} />
    </>
  );
}

/**
 * Type, process names and PID, PID last. The line names at most three
 * processes; the full list, and anything the row's width clips, is one
 * disclosure away by hover or focus.
 */
function IdentityLine({
  parts,
  full,
}: {
  parts: Array<string | null>;
  full: Array<string | null>;
}): ReactElement {
  const text = parts.filter((part): part is string => part !== null).join(" · ");
  const fullText = full.filter((part): part is string => part !== null).join(" · ");
  return (
    <TruncatedTooltip content={fullText} isTruncated={text !== fullText ? true : undefined}>
      <div className="truncate text-xs text-text-secondary">{text}</div>
    </TruncatedTooltip>
  );
}

function RowTitle({ title, state }: { title: string; state?: ReactElement | null }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <TruncatedTooltip content={title}>
        <span className="truncate text-sm text-text-primary">{title}</span>
      </TruncatedTooltip>
      {state}
    </div>
  );
}

/**
 * Every live terminal and plugin process across all projects (#13175): the
 * ones in background projects, evicted views, hidden dev previews and the
 * trash included. Polls only while open, and only while this view is visible.
 */
export function ProcessesDialog({
  isOpen,
  onClose,
  restoreFocusTo,
}: ProcessesDialogProps): ReactElement {
  const [snapshot, setSnapshot] = useState<ProcessInventorySnapshot | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [killTarget, setKillTarget] = useState<KillTarget | null>(null);
  // Which terminals the last poll saw a dev-preview session for. Display only:
  // it picks the row's verb, while the press re-reads the sessions to decide.
  // Null until a read answers; until then the panel kind stands in.
  const [devSessionTerminalIds, setDevSessionTerminalIds] = useState<ReadonlySet<string> | null>(
    null
  );
  const [isKilling, setIsKilling] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);
  // Killed rows stay hidden until the next read stops listing them: the kill
  // lands before the census notices. Keyed by PTY generation, so a pane that
  // restarts on exit reappears as the new process it is.
  const [killedIds, setKilledIds] = useState<ReadonlySet<string>>(() => new Set());
  const [closedKillTarget, setClosedKillTarget] = useState<ClosedProcessGroup | null>(null);
  // Closed-terminal processes a kill saw end, by recorded identity, hidden
  // until the next read stops listing them.
  const [endedClosedKeys, setEndedClosedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const fetchRef = useRef<() => Promise<void>>(async () => {});
  // Bumped on every open and close, so a session read that resolves after the
  // dialog closed can't raise a confirm nobody asked for.
  const openGenerationRef = useRef(0);
  // The latest Kill press wins: a slower session read for an earlier row must
  // not replace the confirm a later press opened.
  const killRequestRef = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Where the confirm hands focus back: the row's own Kill, or after a kill
  // the neighbouring rows' Kill buttons, in preference order.
  const focusPlanRef = useRef<{ ids: string[] } | null>(null);

  useEffect(() => {
    openGenerationRef.current += 1;
    if (!isOpen) {
      setKillTarget(null);
      setClosedKillTarget(null);
      return;
    }
    let cancelled = false;
    let inFlight = false;

    const fetchSnapshot = (): Promise<void> => {
      if (inFlight || document.hidden || isProjectViewCached()) return Promise.resolve();
      inFlight = true;
      return readProcesses().then((result) => {
        inFlight = false;
        if (cancelled) return;
        if (result.sessions) {
          setDevSessionTerminalIds(sessionTerminalIdsOf(result.sessions));
        }
        if (result.snapshot) {
          const next = result.snapshot;
          setSnapshot(next);
          setReadFailed(false);
          const listed = new Set(next.terminals.map(incarnationKey));
          setKilledIds((prev) => {
            const kept = [...prev].filter((key) => listed.has(key));
            return kept.length === prev.size ? prev : new Set(kept);
          });
          const listedClosed = new Set(next.closedTerminalProcesses.map(closedProcessKey));
          // A missing host's processes are absent from a partial reading, not
          // gone; forgetting them here would let a stale row come back.
          if (next.complete) {
            setEndedClosedKeys((prev) => {
              const kept = [...prev].filter((key) => listedClosed.has(key));
              return kept.length === prev.size ? prev : new Set(kept);
            });
          }
        } else {
          setReadFailed(true);
          logError("[ProcessesDialog] Failed to read processes", result.snapshotError);
        }
      });
    };

    fetchRef.current = fetchSnapshot;
    void fetchSnapshot();
    const poll = setInterval(() => void fetchSnapshot(), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    const onVisible = () => {
      if (!document.hidden) void fetchSnapshot();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      fetchRef.current = async () => {};
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isOpen]);

  const terminals = (snapshot?.terminals ?? []).filter(
    (terminal) => !killedIds.has(incarnationKey(terminal))
  );
  const plugins = sortPluginProcesses(snapshot?.plugins ?? []);
  const closedGroups = groupClosedProcesses(
    (snapshot?.closedTerminalProcesses ?? []).filter(
      (process) => !endedClosedKeys.has(closedProcessKey(process))
    )
  );
  const groups = groupProcessesByProject(terminals, closedGroups);
  const cleanup = describeCleanupReport(snapshot?.cleanup ?? null);
  const isEmpty =
    snapshot !== null && terminals.length + plugins.length + closedGroups.length === 0;
  // In the order the rows render, so focus after a kill lands on a neighbour.
  const listedIds = groups.flatMap((group) =>
    group.rows.map((row) =>
      row.kind === "live" ? row.terminal.id : `${CLOSED_KILL_PREFIX}${row.closed.key}`
    )
  );

  const neighboursOf = (id: string): string[] => {
    const at = listedIds.indexOf(id);
    if (at < 0) return listedIds;
    return [...listedIds.slice(at + 1), ...listedIds.slice(0, at).reverse()];
  };

  const requestKill = (terminal: ProcessInventoryTerminal) => {
    setKillError(null);
    const generation = openGenerationRef.current;
    const request = ++killRequestRef.current;
    const isCurrent = () =>
      openGenerationRef.current === generation && killRequestRef.current === request;
    void resolveKillTarget(terminal).then(
      ({ target, sessionTerminalIds }) => {
        if (!isCurrent()) return;
        focusPlanRef.current = { ids: [terminal.id] };
        // Row verbs follow the fresh answer, so they agree with the confirm.
        setDevSessionTerminalIds(sessionTerminalIds);
        setClosedKillTarget(null);
        setKillTarget(target);
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        logError("[ProcessesDialog] Failed to read dev preview sessions", error);
        setKillError(
          `Couldn't check whether '${terminalTitle(terminal)}' is a dev preview, so nothing was killed. Try again.`
        );
      }
    );
  };

  const confirmKill = (): Promise<void> | undefined => {
    const target = killTarget;
    if (!target) return undefined;
    const { terminal } = target;
    const title = terminalTitle(terminal);
    const neighbours = neighboursOf(terminal.id);
    setIsKilling(true);
    return endProcess(target).then((outcome) => {
      setIsKilling(false);
      setKillTarget(null);
      if (outcome.status === "ended") {
        focusPlanRef.current = { ids: neighbours };
        setKilledIds((prev) => new Set(prev).add(incarnationKey(terminal)));
        void fetchRef.current();
      } else if (outcome.status === "replaced") {
        setKillError(
          `'${title}' restarted after you chose it, so the new process wasn't killed. Choose it again to kill it.`
        );
      } else {
        setKillError(
          `Couldn't ${target.via === "dev-session" ? "stop" : "kill"} '${title}'. ${outcome.message}`
        );
      }
    });
  };

  const requestClosedKill = (group: ClosedProcessGroup) => {
    setKillError(null);
    // Supersedes a terminal Kill still resolving its dev-preview lookup, so the
    // two confirms can never both open.
    killRequestRef.current += 1;
    setKillTarget(null);
    focusPlanRef.current = { ids: [`${CLOSED_KILL_PREFIX}${group.key}`] };
    setClosedKillTarget(group);
  };

  const confirmClosedKill = (): Promise<void> | undefined => {
    const group = closedKillTarget;
    if (!group) return undefined;
    const neighbours = neighboursOf(`${CLOSED_KILL_PREFIX}${group.key}`);
    const targets = group.processes.map(({ pid, startTime }) => ({ pid, startTime }));
    setIsKilling(true);
    return processesClient.killClosedTerminalProcesses(targets).then(
      (result) => {
        setIsKilling(false);
        setClosedKillTarget(null);
        const shortfall = describeClosedKillShortfall(result, targets.length);
        if (shortfall === null) {
          focusPlanRef.current = { ids: neighbours };
          setEndedClosedKeys((prev) => {
            const next = new Set(prev);
            for (const target of targets) next.add(closedProcessKey(target));
            return next;
          });
        } else {
          setKillError(`Kill from '${group.title}' didn't finish. ${shortfall}`);
        }
        void fetchRef.current();
      },
      (error: unknown) => {
        setIsKilling(false);
        setClosedKillTarget(null);
        logError("[ProcessesDialog] Failed to kill closed-terminal processes", error);
        setKillError(
          `Couldn't kill the processes from '${group.title}'. ${formatErrorMessage(
            error,
            "The terminal host didn't respond."
          )}`
        );
      }
    );
  };

  // Resolved when the confirm finishes closing, not when the kill lands: by
  // then a killed row has left, and its neighbour is the next Kill to reach.
  const resolveConfirmFocus = (): HTMLElement | null => {
    const dialog = bodyRef.current?.closest('[role="dialog"]');
    if (!dialog) return null;
    const plan = focusPlanRef.current;
    focusPlanRef.current = null;
    for (const id of plan?.ids ?? []) {
      const button = dialog.querySelector<HTMLElement>(`[data-process-kill="${CSS.escape(id)}"]`);
      if (button) return button;
    }
    return (
      dialog.querySelector<HTMLElement>("[data-process-kill]") ??
      dialog.querySelector<HTMLElement>('button[aria-label="Close dialog"]')
    );
  };

  const sampleAge =
    snapshot && snapshot.sampledAt > 0 ? Math.max(0, now - snapshot.sampledAt) : null;

  const renderTerminal = (terminal: ProcessInventoryTerminal, projectLabel: string) => {
    const title = terminalTitle(terminal);
    const kind = describeTerminalKind(terminal);
    const secondsLeft = trashSecondsLeft(terminal, now);
    const stops = devSessionTerminalIds
      ? devSessionTerminalIds.has(terminal.id)
      : isDevPreviewKind(terminal.kind);
    const action = stops ? "Stop dev server" : "Kill terminal";
    const members = terminal.sample ? describeMembers(terminal.sample, 3) : null;
    const pid = terminal.rootPid !== null ? `PID ${terminal.rootPid}` : null;
    return (
      <li
        key={terminal.id}
        className={`${ROW_GRID} min-h-12 border-t border-border-subtle py-1.5 first:border-t-0`}
        data-testid="process-row"
        data-terminal-id={terminal.id}
      >
        <div className="min-w-0">
          <RowTitle
            title={title}
            state={
              terminal.isTrashed ? (
                <Badge tone="warning">
                  <Trash2 aria-hidden="true" />
                  {secondsLeft === null ? "In trash" : `In trash · ends in ${secondsLeft}s`}
                </Badge>
              ) : null
            }
          />
          <IdentityLine
            parts={[kind === title ? null : kind, members, pid]}
            full={[
              kind === title ? null : kind,
              terminal.sample ? describeMembers(terminal.sample, Infinity) : null,
              pid,
            ]}
          />
        </div>
        <SampleReadings sample={terminal.sample} />
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${action} '${title}' in ${projectLabel}`}
            onClick={() => requestKill(terminal)}
            data-process-kill={terminal.id}
          >
            {action}
          </Button>
        </div>
      </li>
    );
  };

  const renderPlugin = (process: ProcessInventoryPluginProcess) => {
    const title = pluginProcessTitle(process);
    const members =
      process.sample && process.sample.members.length > 0
        ? describeMembers(process.sample, 3)
        : null;
    const owner =
      process.source === "plugin-worker" ? "Plugin worker" : `Run by ${process.pluginId}`;
    return (
      <li
        key={`${process.source}:${process.id}`}
        className={`${ROW_GRID} min-h-12 border-t border-border-subtle py-1.5 first:border-t-0`}
        data-testid="plugin-process-row"
      >
        <div className="min-w-0">
          <RowTitle title={title} />
          <IdentityLine
            parts={[owner, members, `PID ${process.pid}`]}
            full={[
              owner,
              members && process.sample ? describeMembers(process.sample, Infinity) : null,
              `PID ${process.pid}`,
            ]}
          />
        </div>
        <SampleReadings sample={process.sample} />
        <span aria-hidden="true" />
      </li>
    );
  };

  const renderClosedGroup = (group: ClosedProcessGroup) => {
    const count = group.processes.length;
    const killId = `${CLOSED_KILL_PREFIX}${group.key}`;
    const action = count === 1 ? "Kill process" : `Kill ${count} processes`;
    const only = count === 1 ? group.processes[0] : undefined;
    const state =
      count > 1 ? `${pluralize(count, "process", "processes")} still running` : "Still running";
    const pid = only ? `PID ${only.pid}` : null;
    return (
      <li
        key={group.key}
        className={`${ROW_GRID} min-h-12 border-t border-border-subtle py-1.5 first:border-t-0`}
        data-testid="closed-process-row"
      >
        <div className="min-w-0">
          <RowTitle
            title={group.title}
            state={<Badge>Terminal closed {formatAgo(now - group.closedAt)}</Badge>}
          />
          <IdentityLine
            parts={[state, describeClosedMembers(group.processes), pid]}
            full={[
              state,
              only
                ? describeClosedMembers(group.processes, Infinity)
                : group.processes
                    .map((process) => `${process.comm || "process"} (PID ${process.pid})`)
                    .join(", "),
              pid,
            ]}
          />
        </div>
        <Reading
          label="CPU"
          value={group.cpuPercent === null ? null : formatCpu(group.cpuPercent)}
        />
        <Reading
          label="Memory"
          value={group.memoryKb === null ? null : formatApproxMemory(group.memoryKb)}
        />
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Kill ${pluralize(count, "process", "processes")} from '${group.title}'`}
            onClick={() => requestClosedKill(group)}
            data-process-kill={killId}
          >
            {action}
          </Button>
        </div>
      </li>
    );
  };

  const closedTarget = closedKillTarget;
  const closedTargetCount = closedTarget?.processes.length ?? 0;
  const closedTargetWhere = closedTarget?.projectLabel ? ` in ${closedTarget.projectLabel}` : "";

  const target = killTarget;
  const targetTitle = target ? terminalTitle(target.terminal) : "";
  const targetWhere = target?.terminal.projectId
    ? ` in ${target.terminal.projectName ?? "an unknown project"}`
    : "";
  const targetCount = target?.terminal.sample?.processCount ?? null;

  return (
    <>
      <AppDialog
        isOpen={isOpen}
        onClose={onClose}
        size="lg"
        restoreFocusTo={restoreFocusTo}
        data-testid="processes-dialog"
      >
        <AppDialog.Header>
          <AppDialog.Title>Running processes</AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        <AppDialog.Body>
          <div ref={bodyRef} className="flex flex-col gap-4">
            <p className="text-xs leading-snug text-text-secondary">
              Every terminal and plugin process across all projects, including ones whose panel
              isn't on screen. Readings are sampled, and memory is counted per process, so memory
              two processes share is counted twice.
            </p>
            {killError && (
              <Callout severity="error" size="compact" role="alert">
                {killError}
              </Callout>
            )}
            {readFailed && (
              <Callout
                severity="warning"
                size="compact"
                action={
                  <Button variant="ghost" size="sm" onClick={() => void fetchRef.current()}>
                    <RefreshCw aria-hidden="true" />
                    Retry
                  </Button>
                }
              >
                {snapshot
                  ? "Couldn't refresh the list. Showing the last reading."
                  : "Couldn't read the running processes."}
              </Callout>
            )}
            {snapshot && !snapshot.complete && (
              <Callout severity="warning" size="compact">
                A terminal host didn't answer, so some terminals may be missing, along with
                processes from their closed terminals.
              </Callout>
            )}
            {snapshot && snapshot.complete && !snapshot.samplesAvailable && (
              <Callout severity="warning" size="compact">
                The last process census failed, so Daintree can't currently check what's still
                running. CPU, memory and processes from closed terminals are from the reading before
                it.
              </Callout>
            )}
            {cleanup && (
              <Callout severity={cleanup.severity} size="compact">
                {cleanup.text}
              </Callout>
            )}
            {snapshot === null && !readFailed ? (
              <Skeleton label="Loading processes" className="space-y-2">
                <SkeletonBone className="h-4 w-full" />
                <SkeletonBone className="h-4 w-5/6" />
                <SkeletonBone className="h-4 w-3/4" />
              </Skeleton>
            ) : isEmpty ? (
              <p className="text-sm text-text-secondary">
                No terminals or plugin processes are running.
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                <div
                  className={`${ROW_GRID} sticky top-0 z-10 -mb-2 border-b border-border-subtle bg-surface-dialog py-1.5 text-xs text-text-secondary`}
                >
                  <span className="truncate">
                    {sampleAge !== null && sampleAge >= STALE_AFTER_MS
                      ? `Sampled ${Math.round(sampleAge / 1000)}s ago`
                      : null}
                  </span>
                  <span aria-hidden="true" className="text-right">
                    CPU
                  </span>
                  <span aria-hidden="true" className="text-right">
                    Memory
                  </span>
                  <span aria-hidden="true" />
                </div>
                {groups.map((group) => {
                  const headingId = `processes-group-${group.key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
                  const leftover = group.closed.reduce(
                    (sum, closed) => sum + closed.processes.length,
                    0
                  );
                  const counts = [
                    group.terminals.length > 0
                      ? pluralize(group.terminals.length, "terminal")
                      : null,
                    leftover > 0
                      ? `${pluralize(leftover, "process", "processes")} left running`
                      : null,
                  ].filter((part): part is string => part !== null);
                  return (
                    <section key={group.key} aria-labelledby={headingId}>
                      <h3
                        id={headingId}
                        className="mb-0.5 flex items-baseline justify-between gap-2 text-xs font-medium text-text-primary"
                      >
                        <TruncatedTooltip content={group.label}>
                          <span className="truncate">{group.label}</span>
                        </TruncatedTooltip>
                        <span className="shrink-0 font-normal text-text-secondary">
                          {counts.join(" · ")}
                        </span>
                      </h3>
                      <ul>
                        {group.rows.map((row) =>
                          row.kind === "live"
                            ? renderTerminal(row.terminal, group.label)
                            : renderClosedGroup(row.closed)
                        )}
                      </ul>
                    </section>
                  );
                })}
                {plugins.length > 0 && (
                  <section aria-labelledby="processes-group-plugins">
                    <h3
                      id="processes-group-plugins"
                      className="mb-0.5 flex items-baseline justify-between gap-2 text-xs font-medium text-text-primary"
                    >
                      <span className="truncate">Plugins</span>
                      <span className="shrink-0 font-normal text-text-secondary">
                        {pluralize(plugins.length, "process", "processes")}
                      </span>
                    </h3>
                    <ul>{plugins.map(renderPlugin)}</ul>
                  </section>
                )}
              </div>
            )}
          </div>
        </AppDialog.Body>
      </AppDialog>
      <ConfirmDialog
        isOpen={isOpen && target !== null}
        restoreFocusTo={resolveConfirmFocus}
        onClose={() => setKillTarget(null)}
        variant="destructive"
        title={target?.via === "dev-session" ? `Stop '${targetTitle}'?` : `Kill '${targetTitle}'?`}
        description={
          target?.via === "dev-session"
            ? `Stops the dev server for this preview${targetWhere}.`
            : `Ends this terminal${targetWhere}${
                targetCount !== null && targetCount > 1
                  ? ` and the ${pluralize(targetCount - 1, "process", "processes")} running in it`
                  : ""
              }.${
                target?.terminal.isTrashed
                  ? " It's in the trash, so its pane is removed and can't be restored."
                  : ""
              }`
        }
        confirmLabel={target?.via === "dev-session" ? "Stop dev server" : "Kill terminal"}
        onConfirm={confirmKill}
        isConfirmLoading={isKilling}
      />
      <ConfirmDialog
        isOpen={isOpen && closedTarget !== null}
        restoreFocusTo={resolveConfirmFocus}
        onClose={() => setClosedKillTarget(null)}
        variant="destructive"
        title={`Kill ${pluralize(closedTargetCount, "process", "processes")} from '${
          closedTarget?.title ?? ""
        }'?`}
        description={`Ends ${
          closedTarget ? describeClosedMembers(closedTarget.processes) : ""
        }, still running after this terminal closed${closedTargetWhere}. Anything ${
          closedTargetCount === 1 ? "it was" : "they were"
        } doing stops.`}
        confirmLabel={
          closedTargetCount === 1 ? "Kill process" : `Kill ${closedTargetCount} processes`
        }
        onConfirm={confirmClosedKill}
        isConfirmLoading={isKilling}
      />
    </>
  );
}
