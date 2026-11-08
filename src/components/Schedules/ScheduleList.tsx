import type { MouseEvent, ReactNode, Ref } from "react";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { BrandMark, DaintreeIcon, History, Play } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { resolveAgentIcon } from "@/config/agentIcons";
import { getBrandColorHex } from "@/lib/colorUtils";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { isScheduleAssistantAgentId } from "@shared/utils/scheduledRuns";
import type { Schedule, ScheduledRun } from "@shared/types/scheduledRuns";
import type { ProjectSchedulesState } from "./useProjectSchedules";
import type { LastRunsState } from "./useLastRuns";
import { lastRunWords } from "./lastRunWords";
import { RunGlyph } from "./RunGlyph";
import { scheduleAgentName } from "./scheduleAgent";
import { SCHEDULE_STARTERS, type ScheduleStarter } from "./scheduleStarters";
import {
  cadenceWords,
  formatNextRunRelative,
  formatRunInstant,
  nextRunAt,
  scheduleWorktreeLabel,
} from "./scheduleWords";

/** The controls a row offers, each findable by schedule for handing focus back to it. */
export type ScheduleRowAction = "run" | "history" | "edit" | "delete";

export function scheduleActionSelector(id: string, action: ScheduleRowAction): string {
  return `[data-schedule-id="${CSS.escape(id)}"] [data-schedule-action="${action}"]`;
}
export const NEW_SCHEDULE_SELECTOR = "[data-schedules-new]";
/** A Run now failure's callout, list or history: its Retry is where the keyboard may be. */
export const RUN_NOW_FAILURE_SELECTOR = "[data-run-now-failure]";

interface ScheduleListProps {
  state: ProjectSchedulesState;
  now: number;
  /** The project's switches, heading the section above its schedules. */
  switches?: ReactNode;
  /** Worktree labels by id, for schedules that don't run in the main checkout. */
  worktreeLabels: ReadonlyMap<string, string>;
  /** Schedules whose switch is being saved; the switch holds still until main answers. */
  pendingEnabled: ReadonlySet<string>;
  enabledError: string | null;
  /** Schedules whose Run now is waiting on main. */
  pendingRunNow: ReadonlySet<string>;
  /** A Run now failure the history couldn't record, named by its schedule. */
  runNowError: string | null;
  runNowRetrying: boolean;
  onRetryRunNow: () => void;
  lastRuns: LastRunsState;
  /** The Add schedule button showing, header or empty row, for handing focus back to. */
  addButtonRef: Ref<HTMLButtonElement>;
  onRetryLastRuns: () => void;
  onCreate: () => void;
  /** Opens the editor for a new schedule filled in from a starter; nothing is saved until Save. */
  onCreateFromStarter: (starter: ScheduleStarter) => void;
  onSetEnabled: (schedule: Schedule, enabled: boolean) => void;
  onRunNow: (schedule: Schedule) => void;
  /** `viaKeyboard`: opened from the keyboard, so focus lands visibly on the history. */
  onOpenHistory: (schedule: Schedule, viaKeyboard: boolean) => void;
  onEdit: (schedule: Schedule) => void;
  onDelete: (schedule: Schedule) => void;
  onRetry: () => void;
}

export function AgentMark({ agentId }: { agentId: string }) {
  if (isScheduleAssistantAgentId(agentId)) {
    return <DaintreeIcon size={14} className="text-text-secondary" />;
  }
  const config = getEffectiveAgentConfig(agentId);
  const Icon = resolveAgentIcon(config?.iconId ?? agentId);
  return (
    <BrandMark brandColor={getBrandColorHex(agentId)}>
      <Icon className="h-3.5 w-3.5" />
    </BrandMark>
  );
}

/** The next run in words: when it is, and the exact time beside it. */
function NextRun({
  schedule,
  now,
  schedulesOn,
}: {
  schedule: Schedule;
  now: number;
  schedulesOn: boolean;
}) {
  if (!schedule.enabled) return <span>Paused</span>;
  // The project's own switch holds every schedule, so no time it names would come.
  if (!schedulesOn) return <span>Schedules off</span>;
  const next = nextRunAt(schedule.cadence, now);
  if (next === null) return <span>Never runs</span>;
  const timeZone = schedule.cadence.timeZone;
  return (
    <span className="min-w-0 truncate">
      Next run{" "}
      <time dateTime={new Date(next).toISOString()}>
        {formatNextRunRelative(next, now, timeZone)}
      </time>
      , {formatRunInstant(next, timeZone, now)}
    </span>
  );
}

/** The last run as the history recorded it; colour never carries it alone. */
function LastRun({
  run,
  status,
  now,
}: {
  run: ScheduledRun | undefined;
  status: LastRunsState["status"];
  now: number;
}) {
  if (!run) {
    if (status === "ready") return <span>No runs yet</span>;
    if (status === "error") return <span>Last run couldn&apos;t be read</span>;
    return null;
  }
  const words = lastRunWords(run);
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="shrink-0">Last run</span>
      <RunGlyph run={run} className="h-3 w-3 shrink-0" />
      <span className="shrink-0 text-text-primary">{words.label}</span>
      {/* TimeAgo carries the exact time on hover. */}
      <TimeAgo
        timestamp={words.at}
        now={now}
        verbose
        prefix={words.timePrefix ? `${words.timePrefix} ` : undefined}
        className="shrink-0"
      />
      {words.detail && (
        <TruncatedTooltip content={words.detail} focusable={false}>
          <span className="min-w-0 truncate">· {words.detail}</span>
        </TruncatedTooltip>
      )}
    </span>
  );
}

function RowAction({
  label,
  tooltip,
  action,
  danger = false,
  loading,
  onClick,
  children,
}: {
  label: string;
  tooltip: string;
  action: ScheduleRowAction;
  danger?: boolean;
  loading?: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={danger ? "ghost-danger" : "ghost"}
          size="icon-sm"
          onClick={onClick}
          loading={loading}
          aria-label={label}
          data-schedule-action={action}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function ScheduleRow({
  schedule,
  now,
  schedulesOn,
  worktreeLabel,
  enabledPending,
  runNowPending,
  lastRun,
  lastRunsStatus,
  onSetEnabled,
  onRunNow,
  onOpenHistory,
  onEdit,
  onDelete,
}: {
  schedule: Schedule;
  now: number;
  schedulesOn: boolean;
  worktreeLabel: string | null;
  enabledPending: boolean;
  runNowPending: boolean;
  lastRun: ScheduledRun | undefined;
  lastRunsStatus: LastRunsState["status"];
  onSetEnabled: (enabled: boolean) => void;
  onRunNow: () => void;
  onOpenHistory: (viaKeyboard: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const words = cadenceWords(schedule.cadence);
  const agentName = scheduleAgentName(schedule.launch.agentId);

  return (
    <div data-schedule-id={schedule.id} className="px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0">
          <AgentMark agentId={schedule.launch.agentId} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <TruncatedTooltip content={schedule.name} focusable={false}>
              <span className="truncate text-sm font-medium text-text-primary">
                {schedule.name}
              </span>
            </TruncatedTooltip>
            {worktreeLabel && <Badge size="xs">{worktreeLabel}</Badge>}
          </div>
          <p className="mt-1 truncate text-xs text-text-secondary">
            {words ?? <span className="font-mono">{schedule.cadence.cron}</span>}
            <span aria-hidden="true"> · </span>
            {agentName}
          </p>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 text-xs text-text-secondary">
            <NextRun schedule={schedule} now={now} schedulesOn={schedulesOn} />
            <LastRun run={lastRun} status={lastRunsStatus} now={now} />
          </div>
        </div>
        {/* Every action keeps its column, so the icons line up down the list. */}
        <div className="flex shrink-0 items-center gap-1">
          {/* aria-disabled while saving, not disabled: a disabled switch drops the focus
              a keyboard toggle left on it. It holds main's answer until main replies. */}
          <SettingsSwitch
            checked={schedule.enabled}
            aria-disabled={enabledPending || undefined}
            onCheckedChange={(enabled) => {
              if (!enabledPending) onSetEnabled(enabled);
            }}
            aria-label={`Enable ${schedule.name}`}
            className="mr-2"
          />
          <RowAction
            label={`Run ${schedule.name} now`}
            tooltip="Run now"
            action="run"
            loading={runNowPending}
            onClick={onRunNow}
          >
            <Play />
          </RowAction>
          <RowAction
            label={`Run history of ${schedule.name}`}
            tooltip="Run history"
            action="history"
            // A keyboard press is a click with no pointer detail.
            onClick={(event) => onOpenHistory(event.detail === 0)}
          >
            <History />
          </RowAction>
          <RowAction
            label={`Edit schedule ${schedule.name}`}
            tooltip="Edit schedule"
            action="edit"
            onClick={onEdit}
          >
            <Pencil />
          </RowAction>
          <RowAction
            label={`Delete schedule ${schedule.name}`}
            tooltip="Delete schedule"
            action="delete"
            danger
            onClick={onDelete}
          >
            <Trash2 />
          </RowAction>
        </div>
      </div>
    </div>
  );
}

export function ScheduleList({
  state,
  now,
  switches,
  worktreeLabels,
  pendingEnabled,
  enabledError,
  pendingRunNow,
  runNowError,
  runNowRetrying,
  onRetryRunNow,
  lastRuns,
  addButtonRef,
  onRetryLastRuns,
  onCreate,
  onCreateFromStarter,
  onSetEnabled,
  onRunNow,
  onOpenHistory,
  onEdit,
  onDelete,
  onRetry,
}: ScheduleListProps) {
  const schedules = state.snapshot?.schedules ?? [];
  const listed = state.snapshot !== null && schedules.length > 0;
  const schedulesOn = state.snapshot?.switches.schedulesOn ?? false;

  return (
    <SettingsSection
      id="project-schedules"
      title="Agent schedules"
      description="Run an agent with your prompt at the times you set. While Daintree is open, each run starts as an ordinary terminal in this project, so you can see what it did."
      action={
        listed && (
          <Button
            variant="outline"
            size="sm"
            onClick={onCreate}
            ref={addButtonRef}
            data-schedules-new=""
          >
            <Plus />
            Add schedule
          </Button>
        )
      }
    >
      <div className="space-y-3">
        {state.status === "error" && (
          <Callout
            severity="error"
            title={
              state.snapshot === null
                ? "Couldn't load schedules"
                : "Couldn't refresh schedules, so this list may be out of date"
            }
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
        {switches}
        {lastRuns.status === "error" && listed && (
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
        {runNowError && (
          <Callout
            severity="error"
            role="alert"
            title="Couldn't start a run"
            data-run-now-failure=""
            action={
              // `loading` keeps the button focusable while it blocks a second try.
              <Button variant="outline" size="sm" onClick={onRetryRunNow} loading={runNowRetrying}>
                <RefreshCw />
                Retry
              </Button>
            }
          >
            {runNowError}
          </Callout>
        )}

        {state.status === "loading" ? (
          <SettingsGroup>
            <Skeleton label="Loading schedules" className="space-y-2 p-3">
              <SkeletonBone className="h-12 w-full" />
              <SkeletonBone className="h-12 w-full" />
            </Skeleton>
          </SettingsGroup>
        ) : state.snapshot === null ? null : schedules.length === 0 ? (
          <>
            <SettingsGroup>
              <SettingsEmptyRow
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onCreate}
                    ref={addButtonRef}
                    data-schedules-new=""
                  >
                    <Plus />
                    Add schedule
                  </Button>
                }
              >
                Add a schedule to run an agent with your prompt, such as every night at 2:00&nbsp;AM
              </SettingsEmptyRow>
            </SettingsGroup>
            <SettingsGroup label="Starters">
              {SCHEDULE_STARTERS.map((starter) => (
                <SettingsRow
                  key={starter.id}
                  label={starter.name}
                  description={starter.description}
                  control={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onCreateFromStarter(starter)}
                      aria-label={`Use starter: ${starter.name}`}
                      data-schedule-starter={starter.id}
                    >
                      Use starter
                    </Button>
                  }
                />
              ))}
            </SettingsGroup>
          </>
        ) : (
          <SettingsGroup>
            {schedules.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                now={now}
                schedulesOn={schedulesOn}
                worktreeLabel={scheduleWorktreeLabel(schedule.launch, worktreeLabels)}
                enabledPending={pendingEnabled.has(schedule.id)}
                runNowPending={pendingRunNow.has(schedule.id)}
                lastRun={lastRuns.byScheduleId.get(schedule.id)}
                lastRunsStatus={lastRuns.status}
                onSetEnabled={(enabled) => onSetEnabled(schedule, enabled)}
                onRunNow={() => onRunNow(schedule)}
                onOpenHistory={(viaKeyboard) => onOpenHistory(schedule, viaKeyboard)}
                onEdit={() => onEdit(schedule)}
                onDelete={() => onDelete(schedule)}
              />
            ))}
          </SettingsGroup>
        )}
      </div>
    </SettingsSection>
  );
}
