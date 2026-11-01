import { useId } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { KitTimePicker } from "@/components/PluginKit/kitTimePicker";
import { formatIsoTime, parseIsoTime } from "@/components/PluginKit/kitTime";
import {
  SETTINGS_CONTROL_WIDTH,
  SettingsDependents,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { SettingsInput } from "@/components/Settings/SettingsInput";
import { SettingsSelect, type SettingsSelectOption } from "@/components/Settings/SettingsSelect";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { machineTimeZone } from "@shared/utils/cron";
import {
  INTERVAL_MINUTES,
  switchKind,
  withChoice,
  type CadenceChoice,
  type CadenceKind,
} from "./cadenceChoice";
import { formatNextRunRelative, formatRunParts } from "./scheduleWords";

const KIND_OPTIONS: SettingsSelectOption[] = [
  { value: "interval", label: "Every few minutes or hours" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Every weekday", description: "Monday to Friday" },
  { value: "days", label: "On chosen days" },
  { value: "monthly", label: "Every month" },
  { value: "custom", label: "Custom cron expression" },
];

const INTERVAL_OPTIONS: SettingsSelectOption[] = INTERVAL_MINUTES.map((minutes) => ({
  value: String(minutes),
  label: minutes < 60 ? pluralize(minutes, "minute") : pluralize(minutes / 60, "hour"),
}));

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
}

const MONTH_DAY_OPTIONS: SettingsSelectOption[] = Array.from({ length: 31 }, (_, index) => ({
  value: String(index + 1),
  label: ordinal(index + 1),
}));

/** Monday first, the way a working week is read; Sunday is 0 in cron. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

function weekdayName(day: number, width: "short" | "long"): string {
  // 2023-01-01 was a Sunday, so day 0 lands on it.
  return new Intl.DateTimeFormat(undefined, { weekday: width, timeZone: "UTC" }).format(
    Date.UTC(2023, 0, 1 + day)
  );
}

function monthDayNote(day: number): string | undefined {
  if (day === 31) return "Skipped in months without a 31st";
  if (day === 30) return "Skipped in February";
  if (day === 29) return "Skipped in February outside leap years";
  return undefined;
}

function intervalNote(minutes: number): string | undefined {
  if (minutes === 1) return undefined;
  return minutes < 60
    ? "Counted from the top of each hour"
    : minutes === 60
      ? "On the hour"
      : "On the hour, counted from midnight";
}

interface CadencePickerProps {
  choice: CadenceChoice;
  onChange: (next: CadenceChoice) => void;
  /** The row that carries the cadence's error, so a failed save can focus it. */
  errorRowId: string;
  error: string | undefined;
  onCustomBlur: () => void;
  /** Words for the expression, or null when it has no short reading. */
  words: string | null;
  /** The next runs, empty while the cadence can't be read. */
  runs: readonly number[];
  timeZone: string;
  now: number;
}

/**
 * The rows of a schedule's cadence, for a `SettingsGroup`: what kind of
 * repeat, that kind's own fields under it, then what it comes to in words and
 * the next runs in the schedule's zone.
 */
export function CadencePicker({
  choice,
  onChange,
  errorRowId,
  error,
  onCustomBlur,
  words,
  runs,
  timeZone,
  now,
}: CadencePickerProps) {
  const set = (change: Partial<CadenceChoice>) => onChange(withChoice(choice, change));
  const kind = choice.kind;
  const showsTime =
    kind === "daily" || kind === "weekdays" || kind === "days" || kind === "monthly";

  return (
    <>
      <SettingsSelect
        id={kind === "custom" || kind === "days" ? undefined : errorRowId}
        label="Repeats"
        controlWidth="wide"
        value={kind}
        onValueChange={(value) => onChange(switchKind(choice, value as CadenceKind))}
        options={KIND_OPTIONS}
        error={kind === "custom" || kind === "days" ? undefined : error}
      />
      <SettingsDependents>
        {kind === "interval" && (
          <SettingsSelect
            label="Every"
            description={intervalNote(choice.everyMinutes)}
            value={String(choice.everyMinutes)}
            onValueChange={(value) => set({ everyMinutes: Number(value) })}
            options={INTERVAL_OPTIONS}
          />
        )}
        {kind === "days" && (
          <DaysRow
            rowId={errorRowId}
            days={choice.days}
            error={error}
            onChange={(days) => set({ days })}
          />
        )}
        {kind === "monthly" && (
          <SettingsSelect
            label="Day of the month"
            description={monthDayNote(choice.monthDay)}
            value={String(choice.monthDay)}
            onValueChange={(value) => set({ monthDay: Number(value) })}
            options={MONTH_DAY_OPTIONS}
          />
        )}
        {showsTime && (
          <SettingsRow
            label="Time"
            // Typed in the schedule's own zone, which after travel isn't the clock on the wall.
            description={timeZone === machineTimeZone() ? undefined : `In ${timeZone}`}
            control={({ labelId, descriptionId, disabled }) => (
              // The field's own "wasn't changed" line goes under it, in the rail's
              // column, rather than beside it pushing the field off the rail.
              <div className={cn("flex flex-col", SETTINGS_CONTROL_WIDTH.select)}>
                <KitTimePicker
                  value={formatIsoTime(choice.time)}
                  onValueChange={(value) => {
                    const minutes = parseIsoTime(value);
                    if (minutes !== null) set({ time: minutes });
                  }}
                  clearable={false}
                  required
                  disabled={disabled}
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                />
              </div>
            )}
          />
        )}
        {kind === "custom" && (
          <SettingsInput
            rowId={errorRowId}
            label="Expression"
            description="Five fields: minute, hour, day of month, month, day of week"
            layout="inline"
            controlWidth="wide"
            className="font-mono"
            spellCheck={false}
            autoComplete="off"
            value={choice.cron}
            placeholder="0 9 * * *"
            onChange={(event) => set({ cron: event.target.value })}
            onBlur={onCustomBlur}
            error={error}
          />
        )}
      </SettingsDependents>
      <CadencePreview
        words={words}
        runs={runs}
        timeZone={timeZone}
        now={now}
        problem={error !== undefined || runs.length === 0}
      />
    </>
  );
}

function DaysRow({
  rowId,
  days,
  error,
  onChange,
}: {
  rowId: string;
  days: readonly number[];
  error: string | undefined;
  onChange: (days: number[]) => void;
}) {
  const baseId = useId();
  return (
    <SettingsRow
      id={rowId}
      label="Days"
      layout="stacked"
      error={error}
      control={({ labelId, descriptionId, disabled }) => (
        <div
          role="group"
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          className="flex flex-wrap gap-x-5 gap-y-2"
        >
          {WEEK_ORDER.map((day) => {
            const id = `${baseId}-${day}`;
            const checked = days.includes(day);
            return (
              <label
                key={day}
                htmlFor={id}
                className="flex items-center gap-2 text-sm text-text-primary"
              >
                <Checkbox
                  id={id}
                  checked={checked}
                  disabled={disabled}
                  invalid={error !== undefined}
                  aria-label={weekdayName(day, "long")}
                  onCheckedChange={(next) =>
                    onChange(next === true ? [...days, day] : days.filter((d) => d !== day))
                  }
                />
                <span aria-hidden="true">{weekdayName(day, "short")}</span>
              </label>
            );
          })}
        </div>
      )}
    />
  );
}

function CadencePreview({
  words,
  runs,
  timeZone,
  now,
  problem,
}: {
  words: string | null;
  runs: readonly number[];
  timeZone: string;
  now: number;
  problem: boolean;
}) {
  const listId = useId();
  const foreign = timeZone !== machineTimeZone();
  if (problem) {
    return (
      <SettingsRow
        rootAttributes={{ "data-testid": "schedule-cadence-preview" }}
        label="Next runs"
        description="Shown once the cadence is complete"
      />
    );
  }
  return (
    <SettingsRow
      rootAttributes={{ "data-testid": "schedule-cadence-preview" }}
      layout="stacked"
      label={words ?? "Runs on a custom schedule"}
      description={
        foreign ? `Times in ${timeZone}, where this schedule was made` : `Times in ${timeZone}`
      }
      control={
        <div className="flex gap-4 text-xs">
          <span id={listId} className="shrink-0 text-text-secondary">
            Next runs
          </span>
          <ol
            aria-labelledby={listId}
            className="grid grid-cols-[auto_auto_1fr] gap-x-3 gap-y-1 tabular-nums"
          >
            {runs.map((run, index) => {
              const parts = formatRunParts(run, timeZone, now);
              return (
                <li key={run} className="col-span-3 grid grid-cols-subgrid">
                  <span className="text-text-primary">{parts.day}</span>
                  <span className="text-text-primary">{parts.time}</span>
                  {index === 0 && (
                    <span className="text-text-secondary">
                      {formatNextRunRelative(run, now, timeZone)}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      }
    />
  );
}
