import { useId } from "react";
import { ChevronRight, Plus, RefreshCw } from "lucide-react";
import { BrandMark, CalendarClock } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { resolveAgentIcon } from "@/config/agentIcons";
import { getBrandColorHex } from "@/lib/colorUtils";
import { SEVERITY_GLYPH, type StatusSeverity } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import type { Schedule, ScheduledRun } from "@shared/types/scheduledRuns";
import type { ProjectSchedulesState } from "./useProjectSchedules";
import type { LastRunsState } from "./useLastRuns";
import { lastRunWords } from "./lastRunWords";
import { cadenceWords, formatNextRunRelative, formatRunInstant, nextRunAt } from "./scheduleWords";

interface ScheduleListProps {
  state: ProjectSchedulesState;
  now: number;
  /** Worktree labels by id, for schedules that don't run in the main checkout. */
  worktreeLabels: ReadonlyMap<string, string>;
  /** Schedules whose switch is being saved; the switch holds still until main answers. */
  pendingEnabled: ReadonlySet<string>;
  enabledError: string | null;
  lastRuns: LastRunsState;
  onRetryLastRuns: () => void;
  onOpenSchedule: (id: string) => void;
  onCreate: () => void;
  onSetEnabled: (schedule: Schedule, enabled: boolean) => void;
  onRetry: () => void;
}

const SEVERITY_TONE: Record<StatusSeverity, string> = {
  success: "text-status-success",
  warning: "text-status-warning",
  error: "text-status-error",
  info: "text-status-info",
};

/** The last run as the history recorded it; colour never carries it alone. */
function LastRunCell({
  run,
  status,
  now,
}: {
  run: ScheduledRun | undefined;
  status: LastRunsState["status"];
  now: number;
}) {
  if (!run) {
    return (
      <p className="text-sm text-text-secondary">
        {status === "ready" ? "No runs yet" : status === "error" ? "Couldn't read" : "\u00a0"}
      </p>
    );
  }
  const words = lastRunWords(run);
  const Glyph = words.severity ? SEVERITY_GLYPH[words.severity] : null;
  return (
    <>
      <p className="flex min-w-0 items-center gap-1.5 text-sm text-text-primary">
        {Glyph && words.severity && (
          <Glyph
            className={cn("h-3.5 w-3.5 shrink-0", SEVERITY_TONE[words.severity])}
            aria-hidden="true"
          />
        )}
        <TruncatedTooltip content={words.label} focusable={false}>
          <span className="truncate">{words.label}</span>
        </TruncatedTooltip>
      </p>
      <p className="flex min-w-0 text-xs text-text-secondary">
        {/* TimeAgo carries the exact time on hover, as the next run's second line does inline. */}
        <TimeAgo
          timestamp={words.at}
          now={now}
          verbose
          prefix={words.timePrefix ? `${words.timePrefix} ` : undefined}
          className="shrink-0"
        />
        {words.detail && (
          <TruncatedTooltip content={words.detail} focusable={false}>
            <span className="min-w-0 truncate">&nbsp;· {words.detail}</span>
          </TruncatedTooltip>
        )}
      </p>
    </>
  );
}

const GRID = "grid grid-cols-[minmax(0,1fr)_11rem_9rem_2.75rem_1rem] items-center gap-x-4";

/** The row's own button, for handing focus back to the schedule a page came from. */
export function scheduleRowSelector(id: string): string {
  return `[data-schedule-row="${CSS.escape(id)}"]`;
}
export const NEW_SCHEDULE_SELECTOR = "[data-schedules-new]";

function AgentMark({ agentId }: { agentId: string }) {
  const config = getEffectiveAgentConfig(agentId);
  const Icon = resolveAgentIcon(config?.iconId ?? agentId);
  return (
    <BrandMark brandColor={getBrandColorHex(agentId)}>
      <Icon className="h-3.5 w-3.5" />
    </BrandMark>
  );
}

function ScheduleRow({
  schedule,
  now,
  worktreeLabel,
  enabledPending,
  lastRun,
  lastRunsStatus,
  onOpen,
  onSetEnabled,
}: {
  schedule: Schedule;
  now: number;
  worktreeLabel: string | null;
  enabledPending: boolean;
  lastRun: ScheduledRun | undefined;
  lastRunsStatus: LastRunsState["status"];
  onOpen: () => void;
  onSetEnabled: (enabled: boolean) => void;
}) {
  const detailsId = useId();
  const words = cadenceWords(schedule.cadence);
  const next = schedule.enabled ? nextRunAt(schedule.cadence, now) : null;
  const agentName =
    getEffectiveAgentConfig(schedule.launch.agentId)?.name ?? schedule.launch.agentId;

  return (
    // A click anywhere on the row but its switch opens the schedule, as a settings
    // row's onRowClick does. The name stays the one control for the keyboard, so
    // the cells keep their own hover disclosures.
    <li
      className={cn(GRID, "relative cursor-pointer px-4 py-3 hover:bg-overlay-subtle")}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button, [role='switch']")) {
          return;
        }
        onOpen();
      }}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 shrink-0">
          <AgentMark agentId={schedule.launch.agentId} />
        </span>
        <div className="min-w-0">
          <TruncatedTooltip content={schedule.name} focusable={false}>
            <button
              type="button"
              onClick={onOpen}
              aria-describedby={detailsId}
              data-schedule-row={schedule.id}
              className="block max-w-full truncate rounded-[var(--radius-sm)] text-left text-sm font-medium text-text-primary outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
            >
              {schedule.name}
            </button>
          </TruncatedTooltip>
          <p className="mt-0.5 truncate text-xs text-text-secondary">
            {words ?? <span className="font-mono">{schedule.cadence.cron}</span>}
            <span aria-hidden="true"> · </span>
            {agentName}
            {worktreeLabel && (
              <>
                <span aria-hidden="true"> · </span>
                {worktreeLabel}
              </>
            )}
          </p>
        </div>
      </div>

      <div id={detailsId} className="contents">
        <div className="min-w-0">
          <span className="sr-only">Next run: </span>
          {!schedule.enabled ? (
            <p className="text-sm text-text-secondary">Paused</p>
          ) : next === null ? (
            <p className="text-sm text-text-secondary">Never</p>
          ) : (
            <>
              <p className="truncate text-sm text-text-primary">
                <time dateTime={new Date(next).toISOString()}>
                  {formatNextRunRelative(next, now, schedule.cadence.timeZone)}
                </time>
              </p>
              <p className="truncate text-xs text-text-secondary">
                {formatRunInstant(next, schedule.cadence.timeZone)}
              </p>
            </>
          )}
        </div>

        <div className="min-w-0">
          <span className="sr-only">Last run: </span>
          <LastRunCell run={lastRun} status={lastRunsStatus} now={now} />
        </div>
      </div>

      <div className="flex justify-end">
        {/* aria-disabled while saving, not disabled: a disabled switch drops the focus
            a keyboard toggle left on it. It holds main's answer until main replies. */}
        <SettingsSwitch
          checked={schedule.enabled}
          aria-disabled={enabledPending || undefined}
          onCheckedChange={(enabled) => {
            if (!enabledPending) onSetEnabled(enabled);
          }}
          aria-label={`Enable ${schedule.name}`}
        />
      </div>
      <ChevronRight className="h-4 w-4 text-text-secondary" aria-hidden="true" />
    </li>
  );
}

export function ScheduleList({
  state,
  now,
  worktreeLabels,
  pendingEnabled,
  enabledError,
  lastRuns,
  onRetryLastRuns,
  onOpenSchedule,
  onCreate,
  onSetEnabled,
  onRetry,
}: ScheduleListProps) {
  const schedules = state.snapshot?.schedules ?? [];

  if (state.status === "error" && state.snapshot === null) {
    return (
      <Callout
        severity="error"
        title="Couldn't load schedules"
        action={
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw />
            Retry
          </Button>
        }
      >
        {state.message}
      </Callout>
    );
  }

  if (state.status === "ready" && schedules.length === 0) {
    return (
      <div className="flex min-h-full flex-col justify-center pb-16">
        <EmptyState
          variant="zero-data"
          scale="canvas"
          icon={<CalendarClock />}
          title="Run an agent on a schedule"
          description={
            "A schedule starts an agent with your prompt at the times you set, such as every night at 2:00\u00a0AM. While Daintree is open, each run starts as an ordinary terminal in this project, so you can see what it did."
          }
          action={
            <Button variant="contrast" size="sm" onClick={onCreate} data-schedules-new="">
              <Plus />
              New schedule
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-text-secondary">
          Runs start while Daintree is open, as terminals in this project
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={onCreate}
          className="shrink-0"
          data-schedules-new=""
        >
          <Plus />
          New schedule
        </Button>
      </div>

      {state.status === "error" && (
        <Callout
          severity="error"
          title="Couldn't refresh schedules, so this list may be out of date"
          action={
            <Button
              variant="outline"
              size="sm"
              // `loading` keeps the button focusable while it blocks a second retry.
              onClick={onRetry}
              loading={state.retrying ?? false}
            >
              <RefreshCw />
              Retry
            </Button>
          }
        >
          {state.message}
        </Callout>
      )}
      {lastRuns.status === "error" && (
        <Callout
          severity="error"
          title="Couldn't read run history, so Last run may be out of date"
          action={
            <Button variant="outline" size="sm" onClick={onRetryLastRuns}>
              <RefreshCw />
              Retry
            </Button>
          }
        />
      )}
      {enabledError && (
        <Callout severity="error" role="alert">
          {enabledError}
        </Callout>
      )}

      <div className="settings-card rounded-[var(--radius-lg)] border border-border-default">
        <div
          className={cn(
            GRID,
            "border-b border-border-subtle px-4 py-2 text-xs text-text-secondary"
          )}
          aria-hidden="true"
        >
          {/* The agent mark's width, so the heading starts where the names do. */}
          <span className="flex items-center gap-3">
            <span className="invisible">
              <AgentMark agentId="claude" />
            </span>
            Schedule
          </span>
          <span>Next run</span>
          <span>Last run</span>
          <span className="text-right">On</span>
          <span />
        </div>
        {state.status === "loading" ? (
          <Skeleton label="Loading schedules" className="space-y-2 p-3">
            <SkeletonBone className="h-10 w-full" />
            <SkeletonBone className="h-10 w-full" />
          </Skeleton>
        ) : (
          <ul aria-label="Schedules" className="divide-y divide-border-subtle">
            {schedules.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                now={now}
                worktreeLabel={
                  schedule.launch.worktreeId === null
                    ? null
                    : (worktreeLabels.get(schedule.launch.worktreeId) ?? "Missing worktree")
                }
                enabledPending={pendingEnabled.has(schedule.id)}
                lastRun={lastRuns.byScheduleId.get(schedule.id)}
                lastRunsStatus={lastRuns.status}
                onOpen={() => onOpenSchedule(schedule.id)}
                onSetEnabled={(enabled) => onSetEnabled(schedule, enabled)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
