import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pencil, RefreshCw } from "lucide-react";
import { History, SquareTerminal } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { machineTimeZone } from "@shared/utils/cron";
import type { Schedule, ScheduledRun } from "@shared/types/scheduledRuns";
import { AgentMark } from "./ScheduleList";
import { RunGlyph } from "./RunGlyph";
import { lastRunWords } from "./lastRunWords";
import {
  TRIGGER_WORDS,
  formatDueTime,
  formatRunExact,
  formatRunTime,
  runAction,
  runDayLabel,
  runDetail,
  runDuration,
  runReferenceAt,
  runStartedAt,
  type RunAction,
} from "./runWords";
import {
  cadenceWords,
  formatNextRunRelative,
  formatRunInstant,
  localDayNumber,
  nextRunAt,
} from "./scheduleWords";
import type { ScheduleRunsState } from "./useScheduleRuns";

interface ScheduleRunsProps {
  schedule: Schedule;
  now: number;
  /** The schedule's worktree label, or null for the main checkout. */
  worktreeLabel: string | null;
  presetName: string | null;
  /** The schedule names a preset its agent no longer has, so every launch will be refused. */
  presetMissing: boolean;
  runsState: ScheduleRunsState;
  onRetryRuns: () => void;
  /** Terminal ids that still have a pane in this view. */
  liveTerminalIds: ReadonlySet<string>;
  worktreeIds: ReadonlySet<string>;
  /** A Run now failure the history didn't record, so the page is the only place it can be said. */
  runNowError: string | null;
  runNowRetrying: boolean;
  /** Runs this page started with Run now, announced even when they land in the first read. */
  requestedRunIds: ReadonlySet<string>;
  onRetryRunNow: () => void;
  onEdit: () => void;
  onOpenRun: (run: ScheduledRun) => void;
  onResumeRun: (run: ScheduledRun) => void;
}

const MissingGlyph = SEVERITY_GLYPH.warning;

const GRID = "grid grid-cols-[minmax(0,1fr)_10.5rem_5rem_7.5rem] items-start gap-x-4";

function agentNameOf(agentId: string): string {
  return getEffectiveAgentConfig(agentId)?.name ?? agentId;
}

function RunActionCell({
  action,
  runName,
  onOpen,
  onResume,
}: {
  action: RunAction;
  /** Which run this is, for a control met by Tab away from its row: "Today at 2:00 AM, Done". */
  runName: string;
  onOpen: () => void;
  onResume: () => void;
}) {
  // Ghost, as repeated row controls are: a bordered button on every run would
  // outweigh the runs themselves.
  if (action.kind === "open") {
    return (
      <Button variant="ghost" size="sm" onClick={onOpen} aria-label={`Open run from ${runName}`}>
        <SquareTerminal />
        Open
      </Button>
    );
  }
  if (action.kind === "resume") {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={onResume}
        aria-label={`Resume run from ${runName}`}
      >
        <History />
        Resume
      </Button>
    );
  }
  if (action.label === null) return <span className="sr-only">{action.explanation}</span>;
  return (
    // pr-3 lines the words up with a ghost button's label in the rows around it.
    <p className="py-1.5 pr-3 text-right text-xs text-text-secondary" title={action.explanation}>
      {action.label}
      <span className="sr-only">: {action.explanation}</span>
    </p>
  );
}

function RunTime({
  at,
  timeZone,
  children,
}: {
  at: number;
  timeZone: string;
  children: ReactNode;
}) {
  return (
    <time dateTime={new Date(at).toISOString()} title={formatRunExact(at, timeZone)}>
      {children}
    </time>
  );
}

function RunRow({
  run,
  schedule,
  now,
  dayLabel,
  action,
  onOpen,
  onResume,
}: {
  run: ScheduledRun;
  schedule: Schedule;
  now: number;
  dayLabel: string;
  action: RunAction;
  onOpen: () => void;
  onResume: () => void;
}) {
  const timeZone = schedule.cadence.timeZone;
  const words = lastRunWords(run);
  const detail = runDetail(run);
  const started = runStartedAt(run);
  const reference = runReferenceAt(run);
  const duration = runDuration(run, now);
  const { dueAt } = run.origin;
  const agentName = agentNameOf(run.resume?.agentId ?? schedule.launch.agentId);
  const runName = `${dayLabel} at ${formatRunTime(reference, timeZone)}, ${words.label}`;

  return (
    <li
      data-run-row={run.id}
      // Focusable only by script, for a held run revealed with no action of its own.
      tabIndex={-1}
      className={cn(
        GRID,
        "px-4 py-3 outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <RunGlyph run={run} className="mt-0.5 h-4 w-4" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">{words.label}</p>
          {detail?.kind === "summary" && (
            // The agent's own claim, so it's attributed: the outcome above is what was recorded.
            <p className="mt-0.5 break-words text-xs text-text-primary [text-wrap:pretty]">
              <span className="text-text-secondary">{agentName}: </span>
              {detail.text}
            </p>
          )}
          {detail?.kind === "reason" && (
            <p className="mt-0.5 break-words text-xs text-text-secondary [text-wrap:pretty]">
              {detail.text}
            </p>
          )}
        </div>
      </div>

      <div className="min-w-0">
        <p className="text-sm tabular-nums text-text-primary">
          <span className="sr-only">Started: </span>
          {started === null ? (
            <span className="text-text-secondary">Didn't start</span>
          ) : (
            <RunTime at={started} timeZone={timeZone}>
              {formatRunTime(started, timeZone)}
            </RunTime>
          )}
        </p>
        <p className="text-xs text-text-secondary">
          <span className="sr-only">Trigger: </span>
          {TRIGGER_WORDS[run.origin.trigger]}
          {dueAt !== null && (
            <>
              <span aria-hidden="true"> · </span>
              due{" "}
              <RunTime at={dueAt} timeZone={timeZone}>
                {formatDueTime(dueAt, reference, timeZone)}
              </RunTime>
            </>
          )}
        </p>
      </div>

      <p className="text-sm tabular-nums text-text-primary">
        <span className="sr-only">Duration: </span>
        {duration === null ? (
          <>
            <span className="text-text-secondary" aria-hidden="true">
              —
            </span>
            <span className="sr-only">none recorded</span>
          </>
        ) : duration.ongoing ? (
          <>
            {/* The elapsed time ticks with the clock; it's never announced. */}
            {formatElapsedDuration(duration.ms)}
            <span className="text-text-secondary"> so far</span>
          </>
        ) : (
          formatElapsedDuration(duration.ms)
        )}
      </p>

      {/* -mt-1 centres a 28px button on the row's first 20px line. */}
      <div className="-mt-1 flex justify-end">
        <RunActionCell action={action} runName={runName} onOpen={onOpen} onResume={onResume} />
      </div>
    </li>
  );
}

interface DayGroup {
  /** The calendar day in the schedule's zone; stable across midnight, unlike the label. */
  day: number;
  label: string;
  runs: ScheduledRun[];
}

/** Runs filed under the day they belong to, newest day first. */
function groupByDay(runs: readonly ScheduledRun[], now: number, timeZone: string): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const run of runs) {
    const at = runReferenceAt(run);
    const day = localDayNumber(at, timeZone);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.runs.push(run);
    else groups.push({ day, label: runDayLabel(at, now, timeZone), runs: [run] });
  }
  return groups;
}

/** What one read changed, in words: a run seen starting, a run settling, a run recorded settled. */
function describeChange(run: ScheduledRun, prior: ScheduledRun | undefined): string | null {
  const trigger = TRIGGER_WORDS[run.origin.trigger];
  const settledNow =
    run.settlement.state === "settled" && (!prior || prior.settlement.state === "open");
  if (settledNow) {
    const detail = runDetail(run);
    const reason = detail?.kind === "reason" ? ` (${detail.text})` : "";
    return `${trigger} run ${prior ? "ended" : "recorded"}: ${lastRunWords(run).label}${reason}`;
  }
  const startedNow =
    run.process.pty.state === "running" && (!prior || prior.process.pty.state !== "running");
  if (startedNow && run.settlement.state === "open") return `${trigger} run started`;
  return null;
}

/** How long the status line stays empty before new words go in, so repeated words are heard again. */
const ANNOUNCE_CLEAR_MS = 100;

/**
 * Every change between two reads, said in one status line. The list itself is
 * never live, and a registration nobody has seen start isn't announced. The line
 * is emptied before each announcement, so a second identical refusal is still read out.
 *
 * The first read is the page's baseline and stays quiet, except for a run this
 * page asked for with Run now: that one is said once, whether it lands in the
 * first read or before Run now has answered.
 */
function useRunAnnouncement(
  runs: readonly ScheduledRun[],
  ready: boolean,
  requestedRunIds: ReadonlySet<string>
): string {
  const previous = useRef<ReadonlyMap<string, ScheduledRun> | null>(null);
  const arrivalsSaid = useRef(new Set<string>());
  const pending = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!ready) return;
    const before = previous.current;
    previous.current = new Map(runs.map((run) => [run.id, run]));
    const changes: string[] = [];
    for (const run of runs) {
      const prior = before?.get(run.id);
      let change = before === null ? null : describeChange(run, prior);
      // Any announcement of a run counts, so the Run now fallback never says it again.
      if (change !== null) arrivalsSaid.current.add(run.id);
      if (change === null && requestedRunIds.has(run.id) && !arrivalsSaid.current.has(run.id)) {
        change = describeChange(run, undefined);
        if (change !== null) arrivalsSaid.current.add(run.id);
      }
      if (change !== null) changes.push(change);
    }
    if (changes.length === 0) return;
    pending.current.push(...changes);
    setMessage("");
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setMessage(pending.current.join(". "));
      pending.current = [];
    }, ANNOUNCE_CLEAR_MS);
  }, [runs, ready, requestedRunIds]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );
  return message;
}

function EmptyRuns({
  schedule,
  next,
  now,
}: {
  schedule: Schedule;
  next: number | null;
  now: number;
}) {
  const timeZone = schedule.cadence.timeZone;
  if (schedule.enabled && next !== null) {
    return (
      <EmptyState
        variant="zero-data"
        scale="canvas"
        icon={<History />}
        title={`First run ${formatNextRunRelative(next, now, timeZone)}`}
        description="Run now starts one sooner"
      />
    );
  }
  return (
    <EmptyState
      variant="zero-data"
      scale="canvas"
      icon={<History />}
      title="Start the first run"
      description={
        schedule.enabled
          ? "Its cadence never comes round, so it won't run on its own. Run now starts a run."
          : "This schedule is paused. Run now starts a run without turning it on."
      }
    />
  );
}

export function ScheduleRuns({
  schedule,
  now,
  worktreeLabel,
  presetName,
  presetMissing,
  runsState,
  onRetryRuns,
  liveTerminalIds,
  worktreeIds,
  runNowError,
  runNowRetrying,
  requestedRunIds,
  onRetryRunNow,
  onEdit,
  onOpenRun,
  onResumeRun,
}: ScheduleRunsProps) {
  const timeZone = schedule.cadence.timeZone;
  const foreignZone = timeZone !== machineTimeZone();
  const words = cadenceWords(schedule.cadence);
  const next = schedule.enabled ? nextRunAt(schedule.cadence, now) : null;
  const { runs, status } = runsState;
  const announcement = useRunAnnouncement(runs, status === "ready", requestedRunIds);

  // While the pointer or focus is in the history, a run that arrives is held back
  // rather than pushing every row down under the pointer; runs already shown keep
  // updating. It joins the list when the history is let go, or from Show new runs.
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  if (runs.length === 0 && (pointerInside || focusInside)) {
    // The list unmounted under the pointer, so its leave never comes.
    setPointerInside(false);
    setFocusInside(false);
  }
  const engaged = runs.length > 0 && (pointerInside || focusInside);
  const [heldBack, setHeldBack] = useState<ReadonlySet<string> | null>(null);
  if (engaged && heldBack === null) setHeldBack(new Set(runs.map((run) => run.id)));
  if (!engaged && heldBack !== null) setHeldBack(null);
  const shownRuns = heldBack ? runs.filter((run) => heldBack.has(run.id)) : runs;
  const heldCount = runs.length - shownRuns.length;
  const groups = groupByDay(shownRuns, now, timeZone);

  // Show new runs unmounts itself once pressed, so focus that was on it moves to
  // the newest run it revealed: that run's action, or the row itself.
  const listRef = useRef<HTMLDivElement>(null);
  const [focusRevealed, setFocusRevealed] = useState<string | null>(null);
  useEffect(() => {
    if (focusRevealed === null) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-run-row="${CSS.escape(focusRevealed)}"]`
    );
    (row?.querySelector<HTMLElement>("button") ?? row)?.focus();
    setFocusRevealed(null);
  }, [focusRevealed]);
  const showHeld = (offerHadFocus: boolean) => {
    const newest = runs.find((run) => !heldBack?.has(run.id));
    setHeldBack(new Set(runs.map((run) => run.id)));
    if (offerHadFocus && newest) setFocusRevealed(newest.id);
  };

  return (
    <div className="space-y-6">
      <p role="status" className="sr-only">
        {announcement}
      </p>

      <div
        className={cn(
          "settings-card grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-6",
          "rounded-[var(--radius-lg)] border border-border-default px-4 py-3"
        )}
      >
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 shrink-0">
            <AgentMark agentId={schedule.launch.agentId} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm text-text-primary">
              {words ?? <span className="font-mono">{schedule.cadence.cron}</span>}
            </p>
            <p className="flex min-w-0 items-center truncate text-xs text-text-secondary">
              {agentNameOf(schedule.launch.agentId)}
              {presetMissing ? (
                <>
                  <span aria-hidden="true">&nbsp;·&nbsp;</span>
                  <MissingGlyph
                    className="mr-1 h-3 w-3 shrink-0 text-status-warning"
                    aria-hidden="true"
                  />
                  <span className="text-text-primary">Missing preset</span>
                </>
              ) : (
                presetName && (
                  <>
                    <span aria-hidden="true">&nbsp;·&nbsp;</span>
                    {presetName}
                  </>
                )
              )}
              <span aria-hidden="true">&nbsp;·&nbsp;</span>
              {worktreeLabel ?? "Main checkout"}
              {foreignZone && (
                <>
                  <span aria-hidden="true">&nbsp;·&nbsp;</span>
                  times in {timeZone}
                </>
              )}
            </p>
          </div>
        </div>
        <div className="min-w-0 text-right">
          <span className="sr-only">Next run: </span>
          {!schedule.enabled ? (
            <p className="text-sm text-text-secondary">Paused</p>
          ) : next === null ? (
            <p className="text-sm text-text-secondary">Never</p>
          ) : (
            <>
              <p className="text-sm text-text-primary">
                Next run{" "}
                <time dateTime={new Date(next).toISOString()}>
                  {formatNextRunRelative(next, now, timeZone)}
                </time>
              </p>
              <p className="text-xs text-text-secondary">{formatRunInstant(next, timeZone, now)}</p>
            </>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={onEdit} data-schedule-edit="">
          <Pencil />
          Edit schedule
        </Button>
      </div>

      {runNowError && (
        <Callout
          severity="error"
          role="alert"
          title="Couldn't start a run"
          action={
            // `loading` keeps the button mounted and focusable while it blocks a second try.
            <Button variant="outline" size="sm" onClick={onRetryRunNow} loading={runNowRetrying}>
              <RefreshCw />
              Retry
            </Button>
          }
        >
          {runNowError}
        </Callout>
      )}

      {status === "error" && (
        <Callout
          severity="error"
          role="alert"
          title={
            runs.length > 0
              ? "Couldn't refresh run history, so this list may be out of date"
              : "Couldn't read run history"
          }
          action={
            <Button variant="outline" size="sm" onClick={onRetryRuns} loading={runsState.retrying}>
              <RefreshCw />
              Retry
            </Button>
          }
        />
      )}

      {status === "loading" ? (
        <Skeleton label="Loading runs" className="space-y-2">
          <SkeletonBone className="h-12 w-full" />
          <SkeletonBone className="h-12 w-full" />
          <SkeletonBone className="h-12 w-full" />
        </Skeleton>
      ) : runs.length === 0 && status === "ready" ? (
        <EmptyRuns schedule={schedule} next={next} now={now} />
      ) : runs.length > 0 ? (
        <div
          ref={listRef}
          className="settings-card rounded-[var(--radius-lg)] border border-border-default"
          onPointerEnter={() => setPointerInside(true)}
          onPointerLeave={() => setPointerInside(false)}
          onFocus={() => setFocusInside(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setFocusInside(false);
            }
          }}
        >
          <div
            className={cn(
              GRID,
              // Stays in view while the history scrolls, so a column is never unnamed.
              // -top-2 takes back the body's top padding, so no row shows above it.
              "settings-card sticky -top-2 z-[1] h-9 items-center rounded-t-[var(--radius-lg)]",
              "border-b border-border-subtle px-4 text-xs text-text-secondary"
            )}
          >
            <span className="pl-[1.625rem]" aria-hidden="true">
              Run
            </span>
            <span aria-hidden="true">Started</span>
            <span aria-hidden="true">Took</span>
            {/* Held arrivals are offered here, in the header's own height, so the offer moves nothing. */}
            <div className="flex justify-end">
              {heldCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(event) => showHeld(event.currentTarget === document.activeElement)}
                >
                  Show {pluralize(heldCount, "new run")}
                </Button>
              )}
            </div>
          </div>
          <ul aria-label={`Runs of ${schedule.name}, newest first`}>
            {groups.map((group) => (
              <li key={group.day} className="border-b border-border-subtle last:border-b-0">
                <h4 className="border-b border-border-subtle bg-overlay-subtle px-4 py-1.5 text-xs font-medium text-text-secondary">
                  {group.label}
                </h4>
                <ul className="divide-y divide-border-subtle">
                  {group.runs.map((run) => (
                    <RunRow
                      key={run.id}
                      run={run}
                      schedule={schedule}
                      now={now}
                      dayLabel={group.label}
                      action={runAction(run, {
                        terminalExists:
                          run.terminalId !== null && liveTerminalIds.has(run.terminalId),
                        worktreeIds,
                      })}
                      onOpen={() => onOpenRun(run)}
                      onResume={() => onResumeRun(run)}
                    />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
