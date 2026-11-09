import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { ArrowDown, CircleStop, OctagonX, RefreshCw, Trash2, type LucideIcon } from "lucide-react";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import type { HostPlatform } from "@shared/types/remoteHosts";
import { isDevPreviewKind } from "@shared/types/panel";
import type {
  ClosedProcessKillResult,
  ProcessInventoryPluginProcess,
  ProcessInventorySnapshot,
  ProcessInventoryTerminal,
} from "@shared/types/processes";
import { AppDialog, type RestoreFocusTarget } from "@/components/ui/AppDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { terminalClient } from "@/clients/terminalClient";
import { processesClient } from "@/clients/processesClient";
import { systemClient } from "@/clients/systemClient";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";
import { isProjectViewCached } from "@/lib/viewCacheState";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import {
  closedProcessKey,
  cwdLeaf,
  describeCleanupReport,
  describeClosedMembers,
  describeMembers,
  describeTerminalBuffer,
  describeTerminalKind,
  formatAgo,
  formatBufferCell,
  formatCpuCell,
  formatMemoryCell,
  groupClosedProcesses,
  groupProcessesByProject,
  groupTopMetric,
  indexTerminalBuffers,
  processName,
  type ClosedProcessGroup,
  type ProcessSort,
  type TerminalBufferReading,
  pluginProcessTitle,
  sortPluginProcesses,
  terminalTitle,
  trashSecondsLeft,
  unaccountedCores,
  UNOWNED_GROUP_KEY,
} from "./processesView";
import { formatCores } from "./ProjectResourceBadge.utils";
import {
  ATTACHED_HOST_SOURCE,
  type ProcessesReading,
  type ProcessesSource,
} from "./processesSource";

const POLL_MS = 4_000;
const TICK_MS = 1_000;
/** Below this the reading is simply current; past it the age earns a line. */
const STALE_AFTER_MS = 10_000;

interface ProcessesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  restoreFocusTo?: RestoreFocusTarget;
  /** Where the list is read from; the host this window is attached to when omitted. Keep it stable. */
  source?: ProcessesSource;
  /** Whether rows can be ended: only for the host this window is attached to. */
  canKill?: boolean;
  /** Names the host in the title when the list isn't the attached host's. */
  hostName?: string;
  hostPlatform?: HostPlatform | null;
  /** Cores the host reports busy, for saying how much the listed processes leave unaccounted for. */
  hostBusyCores?: number | null;
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
  reading: ProcessesReading | null;
  snapshotError: unknown;
  sessions: DevPreviewSessionState[] | null;
  /** Null when not asked (another host's list) or the read failed. */
  buffers: ReadonlyMap<string, TerminalBufferReading> | null;
};

/**
 * Settled one by one: a failed session read must not hold back the list.
 * Sessions only matter to the Kill verb, so a read-only view never asks.
 */
async function readProcesses(source: ProcessesSource, canKill: boolean): Promise<ReadOutcome> {
  // Renderer buffers live in this device's views, so they only describe the
  // attached host's terminals; another host's list is never joined against them.
  const [snapshotResult, sessionsResult, memoryResult] = await Promise.allSettled([
    source.read(),
    canKill ? window.electron.devPreview.getAllSessions() : Promise.resolve(null),
    source === ATTACHED_HOST_SOURCE ? systemClient.getMemorySnapshot() : Promise.resolve(null),
  ]);
  return {
    reading: snapshotResult.status === "fulfilled" ? snapshotResult.value : null,
    snapshotError: snapshotResult.status === "rejected" ? snapshotResult.reason : null,
    sessions: sessionsResult.status === "fulfilled" ? sessionsResult.value : null,
    buffers:
      memoryResult.status === "fulfilled" && memoryResult.value
        ? indexTerminalBuffers(memoryResult.value.rendererTerminalBuffers)
        : null,
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

/** The order rows and groups were drawn in when the pointer or focus arrived. */
interface HeldOrder {
  sort: ProcessSort;
  sections: string[];
  rows: Record<string, string[]>;
}

/** `items` in `keys`' order; anything `keys` doesn't name follows, in its own order. */
function inHeldOrder<T extends { key: string }>(items: T[], keys: readonly string[]): T[] {
  const rank = new Map(keys.map((key, index) => [key, index]));
  return items
    .map((item, index) => ({ item, index, rank: rank.get(item.key) ?? keys.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ item }) => item);
}

/** `held` with any key `next` has that it lacks appended, or `held` itself when nothing is new. */
function mergeHeldOrder(held: HeldOrder, next: HeldOrder): HeldOrder {
  const addMissing = (have: readonly string[], want: readonly string[]) => {
    const missing = want.filter((key) => !have.includes(key));
    return missing.length === 0 ? null : [...have, ...missing];
  };
  let changed = false;
  const sections = addMissing(held.sections, next.sections);
  if (sections) changed = true;
  const rows: Record<string, string[]> = { ...held.rows };
  for (const [key, keys] of Object.entries(next.rows)) {
    const merged = addMissing(held.rows[key] ?? [], keys);
    if (merged) {
      rows[key] = merged;
      changed = true;
    }
  }
  return changed ? { sort: held.sort, sections: sections ?? held.sections, rows } : held;
}

/** "No project" stays last in a held order too, wherever it was when the hold began. */
function unownedLast<T extends { key: string }>(sections: T[]): T[] {
  const unowned = sections.filter((section) => section.key === UNOWNED_GROUP_KEY);
  return unowned.length === 0
    ? sections
    : [...sections.filter((section) => section.key !== UNOWNED_GROUP_KEY), ...unowned];
}

/**
 * One row per process tree, on a native table: the columns line up down the
 * whole list whatever the row kind, the sort lives on the header cells where
 * assistive technology looks for it, and a row with nothing to end leaves its
 * action cell empty rather than letting its readings slide right.
 */
const CELL = "py-1 align-middle";
const NUM_CELL = `${CELL} whitespace-nowrap pl-3 text-right tabular-nums`;

function SortHeader({
  current,
  sort,
  onSelect,
  children,
}: {
  current: ProcessSort;
  sort: ProcessSort;
  onSelect: (sort: ProcessSort) => void;
  children: ReactNode;
}): ReactElement {
  const active = current === sort;
  return (
    <th
      scope="col"
      aria-sort={active ? "descending" : "none"}
      className="bg-surface-dialog pb-1 pt-3 shadow-[inset_0_-1px_0_var(--color-border-subtle)] pl-3 text-right font-normal"
    >
      <button
        type="button"
        onClick={() => onSelect(sort)}
        className={cn(
          "-mr-1 inline-flex min-h-6 items-center justify-end gap-0.5 whitespace-nowrap rounded-[var(--radius-sm)] px-1 text-xs",
          "transition-colors hover:text-text-primary",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline",
          active ? "font-medium text-text-primary" : "text-text-secondary"
        )}
      >
        {/* Before the label, so a right-aligned header ends where its numbers
            do whether or not it is the active sort. */}
        {active && <ArrowDown aria-hidden="true" className="h-3 w-3" />}
        {children}
      </button>
    </th>
  );
}

/** A reading in its column, or an em dash for one the census didn't take. */
function Reading({
  label,
  value,
  primary = false,
  missing = "not sampled",
}: {
  label: string;
  value: string | null;
  primary?: boolean;
  /** Why there is no value, for whoever can't see the dash. */
  missing?: string;
}): ReactElement {
  return (
    <td className={cn(NUM_CELL, primary ? "text-text-primary" : "text-text-secondary")}>
      <span className="sr-only">{label} </span>
      {value ?? (
        <>
          <span aria-hidden="true">—</span>
          <span className="sr-only">{missing}</span>
        </>
      )}
    </td>
  );
}

/**
 * The row's identity on one line: its title, then what tells it apart from a
 * sibling of the same name. Everything else the row knows (its processes, PID,
 * buffer geometry) is one disclosure away by hover or focus, because a line per
 * fact is what made every row three lines tall.
 */
function IdentityCell({
  title,
  tail,
  detail,
  state,
}: {
  title: string;
  tail: Array<string | null>;
  detail: Array<string | null>;
  state?: ReactElement | null;
}): ReactElement {
  const tailText = tail.filter((part): part is string => part !== null).join(" · ");
  const shown = tailText ? `${title} · ${tailText}` : title;
  const full = [title, ...detail].filter((part): part is string => part !== null).join(" · ");
  return (
    <td className={`${CELL} min-w-0 pr-1`}>
      <div className="flex min-w-0 items-center gap-2">
        <TruncatedTooltip content={full} isTruncated={full !== shown ? true : undefined}>
          <span className="min-w-0 truncate">
            <span className="text-text-primary">{title}</span>
            {tailText && <span className="ml-2 text-xs text-text-secondary">{tailText}</span>}
          </span>
        </TruncatedTooltip>
        {state}
      </div>
    </td>
  );
}

/** A row's end action: one quiet glyph, named in full by its tooltip and accessible name. */
function RowAction({
  label,
  name,
  icon: Icon,
  killId,
  onSelect,
}: {
  label: string;
  name: string;
  icon: LucideIcon;
  killId: string;
  onSelect: () => void;
}): ReactElement {
  return (
    <td className={`${CELL} pl-2 text-right`}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={name}
            onClick={onSelect}
            data-process-kill={killId}
            className="text-text-secondary hover:text-text-primary"
          >
            <Icon aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">{label}</TooltipContent>
      </Tooltip>
    </td>
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
  source = ATTACHED_HOST_SOURCE,
  canKill = true,
  hostName,
  hostPlatform = null,
  hostBusyCores = null,
}: ProcessesDialogProps): ReactElement {
  const [snapshot, setSnapshot] = useState<ProcessInventorySnapshot | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [sort, setSort] = useState<ProcessSort>("memory");
  const sourceRef = useRef(source);
  const [readFailed, setReadFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [killTarget, setKillTarget] = useState<KillTarget | null>(null);
  // Which terminals the last poll saw a dev-preview session for. Display only:
  // it picks the row's verb, while the press re-reads the sessions to decide.
  // Null until a read answers; until then the panel kind stands in.
  const [devSessionTerminalIds, setDevSessionTerminalIds] = useState<ReadonlySet<string> | null>(
    null
  );
  const [terminalBuffers, setTerminalBuffers] = useState<ReadonlyMap<
    string,
    TerminalBufferReading
  > | null>(null);
  const [isKilling, setIsKilling] = useState(false);
  const [pointerInTable, setPointerInTable] = useState(false);
  const [focusInTable, setFocusInTable] = useState(false);
  const [heldOrder, setHeldOrder] = useState<HeldOrder | null>(null);
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
    // Closing can take the table away with the pointer still over it, and no
    // pointerleave follows; a fresh opening starts with nothing held.
    setPointerInTable(false);
    setFocusInTable(false);
    setHeldOrder(null);
    // A kill still out belongs to the generation just ended and will not report back here.
    setIsKilling(false);
    if (!isOpen || !canKill) {
      setKillTarget(null);
      setClosedKillTarget(null);
    }
    if (!isOpen) return;
    // A fresh opening asks again, so an older host's answer doesn't linger.
    setUnsupported(false);
    let cancelled = false;
    let inFlight = false;
    let stopped = false;
    if (sourceRef.current !== source) {
      // Another host's rows, kills and confirms mean nothing here.
      sourceRef.current = source;
      setSnapshot(null);
      setTruncated(false);
      setUnsupported(false);
      setReadFailed(false);
      setKilledIds(new Set());
      setEndedClosedKeys(new Set());
      setDevSessionTerminalIds(null);
      setTerminalBuffers(null);
      setKillError(null);
      setKillTarget(null);
      setClosedKillTarget(null);
    }

    const fetchSnapshot = (): Promise<void> => {
      if (stopped || inFlight || document.hidden || isProjectViewCached()) {
        return Promise.resolve();
      }
      inFlight = true;
      return readProcesses(source, canKill).then((result) => {
        inFlight = false;
        if (cancelled) return;
        if (result.sessions) {
          setDevSessionTerminalIds(sessionTerminalIdsOf(result.sessions));
        }
        setTerminalBuffers(result.buffers);
        if (result.reading && !result.reading.supported) {
          // Asking again won't teach an older host to answer; reopening retries.
          stopped = true;
          setUnsupported(true);
          setSnapshot(null);
          setReadFailed(false);
        } else if (result.reading) {
          const next = result.reading.snapshot;
          setUnsupported(false);
          setTruncated(result.reading.truncated);
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
  }, [isOpen, source, canKill]);

  const terminals = (snapshot?.terminals ?? []).filter(
    (terminal) => !killedIds.has(incarnationKey(terminal))
  );
  const plugins = sortPluginProcesses(snapshot?.plugins ?? [], sort);
  const closedGroups = groupClosedProcesses(
    (snapshot?.closedTerminalProcesses ?? []).filter(
      (process) => !endedClosedKeys.has(closedProcessKey(process))
    )
  );
  const groups = groupProcessesByProject(terminals, closedGroups, sort);
  const cleanup = describeCleanupReport(snapshot?.cleanup ?? null);
  const isEmpty =
    snapshot !== null &&
    !truncated &&
    terminals.length + plugins.length + closedGroups.length === 0;
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
    const generation = openGenerationRef.current;
    setIsKilling(true);
    return endProcess(target).then((outcome) => {
      // Closed, or pointed at another host, while the kill was out: its outcome belongs elsewhere.
      if (openGenerationRef.current !== generation) return;
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
    const generation = openGenerationRef.current;
    setIsKilling(true);
    return processesClient.killClosedTerminalProcesses(targets).then(
      (result) => {
        if (openGenerationRef.current !== generation) return;
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
        if (openGenerationRef.current !== generation) return;
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

  const unaccounted =
    snapshot && !unsupported ? unaccountedCores({ ...snapshot, truncated }, hostBusyCores) : null;

  const sampleAge =
    snapshot && snapshot.sampledAt > 0 ? Math.max(0, now - snapshot.sampledAt) : null;
  const stale = sampleAge !== null && sampleAge >= STALE_AFTER_MS;

  const showBuffers = terminalBuffers !== null;
  const columnCount = 4 + (showBuffers ? 1 : 0) + (canKill ? 1 : 0);
  const emptyCell = <td className={CELL} />;

  const renderTerminal = (terminal: ProcessInventoryTerminal, projectLabel: string) => {
    const title = terminalTitle(terminal);
    const kind = describeTerminalKind(terminal);
    const secondsLeft = trashSecondsLeft(terminal, now);
    const stops = devSessionTerminalIds
      ? devSessionTerminalIds.has(terminal.id)
      : isDevPreviewKind(terminal.kind);
    const action = stops ? "Stop dev server" : "Kill terminal";
    const pid = terminal.rootPid !== null ? `PID ${terminal.rootPid}` : null;
    const buffer = terminalBuffers?.get(terminal.id);
    const leaf = cwdLeaf(terminal.cwd);
    // The working directory names the worktree, which is what tells four
    // "Claude" rows in one project apart; a title that already says it keeps it.
    const where = leaf && !title.includes(leaf) ? leaf : null;
    return (
      <tr
        key={terminal.id}
        className="h-9 border-t border-border-subtle"
        data-testid="process-row"
        data-terminal-id={terminal.id}
      >
        <IdentityCell
          title={title}
          tail={[kind === title ? null : kind, where]}
          detail={[
            kind === title ? null : kind,
            where,
            terminal.sample ? describeMembers(terminal.sample, Infinity) : null,
            pid,
            buffer ? describeTerminalBuffer(buffer) : null,
          ]}
          state={
            terminal.isTrashed ? (
              <Badge tone="outline">
                <Trash2 aria-hidden="true" className="text-status-warning" />
                {secondsLeft === null ? "In trash" : `In trash · ${secondsLeft}s`}
              </Badge>
            ) : null
          }
        />
        <Reading label="PID" value={terminal.rootPid !== null ? String(terminal.rootPid) : null} />
        <Reading
          label="CPU cores"
          value={terminal.sample ? formatCpuCell(terminal.sample.cpuPercent) : null}
          primary
        />
        <Reading
          label="Memory"
          value={terminal.sample ? formatMemoryCell(terminal.sample.memoryKb) : null}
          primary
        />
        {showBuffers && (
          <Reading label="Buffer" value={buffer ? formatBufferCell(buffer.estimatedBytes) : null} />
        )}
        {canKill && (
          <RowAction
            label={action}
            name={`${action} '${where ? `${title} · ${where}` : title}'${pid ? ` (${pid})` : ""} in ${projectLabel}`}
            icon={stops ? CircleStop : OctagonX}
            killId={terminal.id}
            onSelect={() => requestKill(terminal)}
          />
        )}
      </tr>
    );
  };

  const renderPlugin = (process: ProcessInventoryPluginProcess) => {
    const title = pluginProcessTitle(process);
    const owner =
      process.source === "plugin-worker" ? "Plugin worker" : `Run by ${process.pluginId}`;
    return (
      <tr
        key={`${process.source}:${process.id}`}
        className="h-9 border-t border-border-subtle"
        data-testid="plugin-process-row"
      >
        <IdentityCell
          title={title}
          tail={[owner]}
          detail={[
            owner,
            process.sample && process.sample.members.length > 0
              ? describeMembers(process.sample, Infinity)
              : null,
            `PID ${process.pid}`,
          ]}
        />
        <Reading label="PID" value={String(process.pid)} />
        <Reading
          label="CPU cores"
          value={process.sample ? formatCpuCell(process.sample.cpuPercent) : null}
          primary
        />
        <Reading
          label="Memory"
          value={process.sample ? formatMemoryCell(process.sample.memoryKb) : null}
          primary
        />
        {showBuffers && emptyCell}
        {canKill && emptyCell}
      </tr>
    );
  };

  const renderClosedGroup = (group: ClosedProcessGroup) => {
    const count = group.processes.length;
    const killId = `${CLOSED_KILL_PREFIX}${group.key}`;
    const action = count === 1 ? "Kill process" : `Kill ${count} processes`;
    const only = count === 1 ? group.processes[0] : undefined;
    const members = describeClosedMembers(group.processes);
    return (
      <tr
        key={group.key}
        className="h-9 border-t border-border-subtle"
        data-testid="closed-process-row"
      >
        <IdentityCell
          title={group.title}
          // The count is on the group heading, the action's name and the confirm;
          // here it only pushed the process names off the row.
          tail={[members]}
          detail={[
            count > 1
              ? `${pluralize(count, "process", "processes")} still running`
              : "Still running",
            only
              ? describeClosedMembers(group.processes, Infinity)
              : group.processes
                  .map(
                    (process) => `${processName(process.comm) ?? "process"} (PID ${process.pid})`
                  )
                  .join(", "),
          ]}
          state={<Badge tone="outline">Closed {formatAgo(now - group.closedAt)}</Badge>}
        />
        <Reading
          label="PID"
          value={only ? String(only.pid) : null}
          missing={`${count} processes`}
        />
        <Reading
          label="CPU cores"
          value={group.cpuPercent === null ? null : formatCpuCell(group.cpuPercent)}
          primary
        />
        <Reading
          label="Memory"
          value={group.memoryKb === null ? null : formatMemoryCell(group.memoryKb)}
          primary
        />
        {showBuffers && emptyCell}
        {canKill && (
          <RowAction
            label={action}
            name={`Kill ${pluralize(count, "process", "processes")} from '${group.title}'`}
            icon={OctagonX}
            killId={killId}
            onSelect={() => requestClosedKill(group)}
          />
        )}
      </tr>
    );
  };

  // Projects and the plugin list ranked together by their heaviest row under
  // the active sort; "No project" stays last whatever it weighs.
  const pluginTop = plugins.reduce(
    (max, process) =>
      Math.max(
        max,
        process.sample ? (sort === "cpu" ? process.sample.cpuPercent : process.sample.memoryKb) : -1
      ),
    -1
  );
  const sections: Array<{
    key: string;
    label: string;
    counts: string;
    top: number;
    rows: Array<{ key: string; node: ReactNode }>;
  }> = groups.map((group) => {
    const leftover = group.closed.reduce((sum, closed) => sum + closed.processes.length, 0);
    return {
      key: group.key,
      label: group.label,
      counts: [
        group.terminals.length > 0 ? pluralize(group.terminals.length, "terminal") : null,
        leftover > 0 ? `${pluralize(leftover, "process", "processes")} left running` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · "),
      top: groupTopMetric(group, sort),
      rows: group.rows.map((row) =>
        row.kind === "live"
          ? { key: row.terminal.id, node: renderTerminal(row.terminal, group.label) }
          : { key: `closed:${row.closed.key}`, node: renderClosedGroup(row.closed) }
      ),
    };
  });
  if (plugins.length > 0) {
    const at = sections.findIndex(
      (section) => section.key === UNOWNED_GROUP_KEY || section.top < pluginTop
    );
    sections.splice(at < 0 ? sections.length : at, 0, {
      key: "plugins",
      label: "Plugins",
      counts: pluralize(plugins.length, "process", "processes"),
      top: pluginTop,
      rows: plugins.map((process) => ({
        key: `${process.source}:${process.id}`,
        node: renderPlugin(process),
      })),
    });
  }

  // While the pointer or focus is in the table, rows and groups keep the order
  // they had when it arrived: a 4s poll that re-ranks them would otherwise slide
  // another terminal under the action the user is reaching for. Readings keep
  // updating; an explicit sort change applies at once, and the ranking catches
  // up when the table is left.
  const tableShown = !unsupported && snapshot !== null && !isEmpty;
  const interacting = tableShown && (pointerInTable || focusInTable);
  const naturalOrder: HeldOrder = {
    sort,
    sections: sections.map((section) => section.key),
    rows: Object.fromEntries(
      sections.map((section) => [section.key, section.rows.map((row) => row.key)])
    ),
  };
  if (!interacting && heldOrder !== null) setHeldOrder(null);
  else if (interacting && (heldOrder === null || heldOrder.sort !== sort)) {
    setHeldOrder(naturalOrder);
  }
  // Rows and groups that arrive while the order is held join it once, at the
  // end, so the next poll can't swap them under the pointer either.
  if (interacting && heldOrder !== null && heldOrder.sort === sort) {
    const merged = mergeHeldOrder(heldOrder, naturalOrder);
    if (merged !== heldOrder) setHeldOrder(merged);
  }
  const order = interacting && heldOrder?.sort === sort ? heldOrder : null;
  const shownSections = order
    ? unownedLast(inHeldOrder(sections, order.sections)).map((section) => ({
        ...section,
        rows: inHeldOrder(section.rows, order.rows[section.key] ?? []),
      }))
    : sections;

  // In the order the rows are drawn (held or not), so focus after a kill lands
  // on the neighbour the user can see. Plugin rows have no action to land on.
  const listedIds = shownSections.flatMap((section) =>
    section.key === "plugins" ? [] : section.rows.map((row) => row.key)
  );

  const neighboursOf = (id: string): string[] => {
    const at = listedIds.indexOf(id);
    if (at < 0) return listedIds;
    return [...listedIds.slice(at + 1), ...listedIds.slice(0, at).reverse()];
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
  const targetLeaf = target ? cwdLeaf(target.terminal.cwd) : null;
  // The PID beside the consequence, so the body names the very process the
  // question (which carries the worktree) is about.
  const targetWhich =
    target && target.terminal.rootPid !== null ? ` (PID ${target.terminal.rootPid})` : "";
  // Four "Claude" rows can share a project, so the question names the worktree too.
  const targetName =
    targetLeaf && !targetTitle.includes(targetLeaf)
      ? `${targetTitle} · ${targetLeaf}`
      : targetTitle;

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
          <AppDialog.Title>
            {hostName ? `Running processes on ${hostName}` : "Running processes"}
          </AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        <AppDialog.Body>
          <div ref={bodyRef} className="flex flex-col gap-3">
            {!canKill && (
              <p className="text-xs leading-snug text-text-secondary">
                This window isn't attached to this host, so processes are listed here but not ended.
              </p>
            )}
            {killError && (
              <Callout severity="error" size="compact" role="alert">
                {killError}
              </Callout>
            )}
            {readFailed && (
              <Callout
                severity={snapshot ? "warning" : "error"}
                size="compact"
                role="status"
                action={
                  <Button variant="outline" size="sm" onClick={() => void fetchRef.current()}>
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
            {unsupported && (
              <Callout severity="info" size="compact">
                {hostName ?? "This host"} runs an older version that can't list its processes.
                Update it to see them here.
              </Callout>
            )}
            {snapshot && truncated && (
              <Callout severity="warning" size="compact">
                {hostName ?? "This host"} listed only part of its processes to keep the answer
                small, so this list may be incomplete.
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
            {unsupported || (snapshot === null && readFailed) ? null : snapshot === null ? (
              <Skeleton label="Loading processes" className="space-y-2">
                <SkeletonBone className="h-4 w-full" />
                <SkeletonBone className="h-4 w-5/6" />
                <SkeletonBone className="h-4 w-3/4" />
              </Skeleton>
            ) : isEmpty ? (
              <p className="text-sm text-text-secondary">
                {/* Only a complete, current reading may say nothing is running; a
                    partial or stale one says what it saw, beside its warning. */}
                {snapshot.complete && snapshot.samplesAvailable && !readFailed && !stale
                  ? "No terminals or plugin processes are running."
                  : `No processes were listed in the last reading${
                      stale && sampleAge !== null ? `, ${formatAgo(sampleAge)}` : ""
                    }.`}
              </p>
            ) : (
              <>
                <table
                  className="w-full table-fixed border-collapse text-sm"
                  onPointerEnter={() => setPointerInTable(true)}
                  onPointerLeave={() => setPointerInTable(false)}
                  onFocus={() => setFocusInTable(true)}
                  onBlur={(event) => {
                    if (!(
                      event.relatedTarget instanceof Node &&
                      event.currentTarget.contains(event.relatedTarget)
                    )) {
                      setFocusInTable(false);
                    }
                  }}
                >
                  <caption className="sr-only">
                    By project, the heaviest project and row first
                  </caption>
                  <colgroup>
                    <col />
                    <col className="w-16" />
                    <col className="w-22" />
                    <col className="w-20" />
                    {showBuffers && <col className="w-20" />}
                    {canKill && <col className="w-9" />}
                  </colgroup>
                  {/* Stuck at the scrollport edge, above the body's top padding, so no
                      band of scrolled rows shows over it; the rule travels with it. */}
                  <thead className="sticky -top-2 z-10">
                    <tr className="text-xs text-text-secondary">
                      <th
                        scope="col"
                        className="truncate bg-surface-dialog pb-1 pt-3 shadow-[inset_0_-1px_0_var(--color-border-subtle)] text-left font-normal"
                      >
                        Name
                        {stale && sampleAge !== null && (
                          <span>{` · sampled ${formatAgo(sampleAge)}`}</span>
                        )}
                      </th>
                      <th
                        scope="col"
                        className="bg-surface-dialog pb-1 pt-3 shadow-[inset_0_-1px_0_var(--color-border-subtle)] pl-3 text-right font-normal"
                      >
                        PID
                      </th>
                      <SortHeader current={sort} sort="cpu" onSelect={setSort}>
                        CPU (cores)
                      </SortHeader>
                      <SortHeader current={sort} sort="memory" onSelect={setSort}>
                        Memory
                      </SortHeader>
                      {showBuffers && (
                        <th
                          scope="col"
                          className="bg-surface-dialog pb-1 pt-3 shadow-[inset_0_-1px_0_var(--color-border-subtle)] pl-3 text-right font-normal"
                        >
                          Buffer, est.
                        </th>
                      )}
                      {canKill && (
                        <th
                          scope="col"
                          className="bg-surface-dialog pb-1 pt-3 shadow-[inset_0_-1px_0_var(--color-border-subtle)]"
                        >
                          <span className="sr-only">Actions</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  {shownSections.map((section, index) => {
                    const headingId = `processes-group-${section.key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
                    return (
                      <tbody key={section.key} aria-labelledby={headingId}>
                        <tr>
                          <th
                            id={headingId}
                            scope="rowgroup"
                            colSpan={columnCount}
                            className={cn(
                              "pb-1 text-left text-sm font-medium text-text-primary",
                              index === 0 ? "pt-2" : "pt-5"
                            )}
                          >
                            <span className="flex min-w-0 items-baseline gap-2">
                              <TruncatedTooltip content={section.label}>
                                <span className="min-w-0 truncate">{section.label}</span>
                              </TruncatedTooltip>
                              <span className="shrink-0 text-xs font-normal text-text-secondary">
                                {section.counts}
                              </span>
                            </span>
                          </th>
                        </tr>
                        {section.rows.map((row) => row.node)}
                      </tbody>
                    );
                  })}
                </table>
                <div className="space-y-1 border-t border-border-subtle pt-2 text-2xs leading-snug text-text-secondary">
                  {unaccounted !== null && (
                    <p data-testid="cpu-unaccounted">
                      About {formatCores(unaccounted)} of the host's busy CPU isn't from the rows
                      above. Row CPU is an average, so this is an estimate.
                    </p>
                  )}
                  <p>
                    Readings are sampled. Memory counts each process in full, so memory two
                    processes share is counted twice.
                    {showBuffers &&
                      " Buffer is the scrollback Daintree holds for a terminal, estimated from its size, and is part of Daintree's own memory."}
                    {hostPlatform === "linux" &&
                      " On Linux, a terminal's CPU is the average since it started, not what it's using now."}
                  </p>
                </div>
              </>
            )}
          </div>
        </AppDialog.Body>
      </AppDialog>
      <ConfirmDialog
        isOpen={isOpen && canKill && target !== null}
        restoreFocusTo={resolveConfirmFocus}
        onClose={() => setKillTarget(null)}
        variant="destructive"
        title={target?.via === "dev-session" ? `Stop '${targetName}'?` : `Kill '${targetName}'?`}
        description={
          target?.via === "dev-session"
            ? `Stops the dev server for this preview${targetWhich}${targetWhere}.`
            : `Ends this terminal${targetWhich}${targetWhere}${
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
        isOpen={isOpen && canKill && closedTarget !== null}
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
