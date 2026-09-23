import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitch } from "./SettingsSwitch";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { SettingsDependents, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsPresetGroup } from "./SettingsPresetGroup";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { NotificationSettings } from "@shared/types";
import { formatTimeOfDay } from "@shared/utils/quietHours";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import {
  ESCALATION_DELAY_OPTIONS,
  NOTIFICATION_COPY,
  SoundPickerRow,
  previewNotificationSound,
  type SoundFileKey,
} from "./notificationSettingsShared";

const DEFAULT_SETTINGS: NotificationSettings = {
  enabled: true,
  completedEnabled: false,
  waitingEnabled: true,
  soundEnabled: false,
  completedSoundFile: "complete.wav",
  waitingSoundFile: "waiting.wav",
  escalationSoundFile: "ping.wav",
  waitingEscalationEnabled: false,
  waitingEscalationDelayMs: 180_000,
  workingPulseEnabled: false,
  workingPulseSoundFile: "pulse.wav",
  uiFeedbackSoundEnabled: false,
  flashEnabled: false,
  quietHoursEnabled: false,
  quietHoursStartMin: 22 * 60,
  quietHoursEndMin: 8 * 60,
  quietHoursWeekdays: [],
};

/** Every quarter hour, as minutes since midnight. */
const TIME_OPTIONS = Array.from({ length: 96 }, (_, i) => i * 15);

const WEEKDAYS: { value: number; label: string; name: string }[] = [
  { value: 0, label: "Sun", name: "Sunday" },
  { value: 1, label: "Mon", name: "Monday" },
  { value: 2, label: "Tue", name: "Tuesday" },
  { value: 3, label: "Wed", name: "Wednesday" },
  { value: 4, label: "Thu", name: "Thursday" },
  { value: 5, label: "Fri", name: "Friday" },
  { value: 6, label: "Sat", name: "Saturday" },
];

function clampMinutes(total: number): number {
  return Math.max(0, Math.min(1439, Math.floor(total)));
}

function describeSchedule(startMin: number, endMin: number): string {
  if (startMin === endMin) {
    return "Start and end match, so the schedule does nothing until the times differ";
  }
  const range = `${formatTimeOfDay(startMin)} to ${formatTimeOfDay(endMin)}`;
  return endMin < startMin ? `${range} the next day` : range;
}

/**
 * A switch row whose `id` lands on the switch itself rather than the row, so the
 * control stays addressable by the ids end-to-end specs and deep links already use.
 */
function SwitchRow({
  id,
  rowId,
  label,
  description,
  checked,
  onChange,
  isModified,
  onReset,
}: {
  id: string;
  /** Search deep-link anchor for the row. */
  rowId?: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  isModified?: boolean;
  onReset?: () => void;
}) {
  return (
    <SettingsRow
      id={rowId}
      label={label}
      description={description}
      isModified={isModified}
      onReset={onReset}
      onRowClick={() => onChange(!checked)}
      control={({ labelId, descriptionId, disabled }) => (
        <SettingsSwitch
          id={id}
          checked={checked}
          onCheckedChange={onChange}
          disabled={disabled}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
        />
      )}
    />
  );
}

type LoadState = "loading" | "ready" | "error";

type SaveGroup = "agent" | "sound" | "quiet";

const SAVE_GROUP_BY_KEY: Record<keyof NotificationSettings, SaveGroup> = {
  enabled: "agent",
  completedEnabled: "agent",
  waitingEnabled: "agent",
  waitingEscalationEnabled: "agent",
  waitingEscalationDelayMs: "agent",
  flashEnabled: "agent",
  groupByContext: "agent",
  soundEnabled: "sound",
  completedSoundFile: "sound",
  waitingSoundFile: "sound",
  escalationSoundFile: "sound",
  workingPulseEnabled: "sound",
  workingPulseSoundFile: "sound",
  uiFeedbackSoundEnabled: "sound",
  quietHoursEnabled: "quiet",
  quietHoursStartMin: "quiet",
  quietHoursEndMin: "quiet",
  quietHoursWeekdays: "quiet",
};

/** The keys the renderer's notification store mirrors, so the notification center stays in step. */
const STORE_MIRRORED_KEYS = [
  "enabled",
  "completedEnabled",
  "waitingEnabled",
  "workingPulseEnabled",
  "uiFeedbackSoundEnabled",
  "flashEnabled",
  "quietHoursEnabled",
  "quietHoursStartMin",
  "quietHoursEndMin",
  "quietHoursWeekdays",
] as const;

type StoreMirror = Partial<Pick<NotificationSettings, (typeof STORE_MIRRORED_KEYS)[number]>>;

function storeSlice(source: object, keys: readonly string[]): StoreMirror {
  const slice: StoreMirror = {};
  for (const key of STORE_MIRRORED_KEYS) {
    const value: unknown = Reflect.get(source, key);
    if (keys.includes(key) && value !== undefined) Object.assign(slice, { [key]: value });
  }
  return slice;
}

function restoredPatch(
  patch: Partial<NotificationSettings>,
  keys: readonly string[]
): Partial<NotificationSettings> {
  const kept: Partial<NotificationSettings> = {};
  for (const key of keys) Object.assign(kept, { [key]: Reflect.get(patch, key) });
  return kept;
}

function withoutKeys(
  failures: Partial<Record<SaveGroup, SaveFailure>>,
  keys: readonly string[]
): Partial<Record<SaveGroup, SaveFailure>> {
  let changed = false;
  const next: Partial<Record<SaveGroup, SaveFailure>> = {};
  for (const failure of Object.values(failures)) {
    const remaining = Object.keys(failure.patch).filter((k) => !keys.includes(k));
    if (remaining.length !== Object.keys(failure.patch).length) changed = true;
    if (remaining.length > 0) {
      next[failure.group] = {
        group: failure.group,
        patch: restoredPatch(failure.patch, remaining),
      };
    }
  }
  return changed ? next : failures;
}

function saveGroupOf(patch: Partial<NotificationSettings>): SaveGroup {
  for (const [key, group] of Object.entries(SAVE_GROUP_BY_KEY)) {
    if (key in patch) return group;
  }
  return "agent";
}

interface SaveFailure {
  group: SaveGroup;
  patch: Partial<NotificationSettings>;
}

export function NotificationSettingsTab() {
  const [settings, setSettings] = useState<NotificationSettings>(DEFAULT_SETTINGS);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadNonce, setLoadNonce] = useState(0);
  // A failed save rolls the control back, which on its own looks like the click never
  // registered — so the failure stays on its group until a later save there covers it.
  const [saveFailures, setSaveFailures] = useState<Partial<Record<SaveGroup, SaveFailure>>>({});
  const loading = loadState === "loading";
  // What main is known to hold, per key, and the newest edit made to each key. A failed
  // save only rolls back a key it is still the newest edit for, and rolls it back to the
  // last value main confirmed — never to whatever the screen showed when it was sent.
  const confirmedRef = useRef<NotificationSettings>(DEFAULT_SETTINGS);
  const revisionRef = useRef(new Map<string, number>());
  const confirmedRevisionRef = useRef(new Map<string, number>());
  // The revision of the newest edit per key that failed and hasn't been superseded.
  const failedRevisionRef = useRef(new Map<string, number>());

  useEffect(() => {
    setLoadState("loading");
    // A retry supersedes the request before it: only the newest may settle the page.
    let current = true;
    const timer = setTimeout(() => {
      if (current) setLoadState("error");
    }, 10_000);

    window.electron?.notification
      ?.getSettings()
      .then((s) => {
        if (!current) return;
        clearTimeout(timer);
        confirmedRef.current = s;
        setSettings(s);
        setLoadState("ready");
      })
      .catch(() => {
        if (!current) return;
        clearTimeout(timer);
        setLoadState("error");
      });

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [loadNonce]);

  const update = (patch: Partial<NotificationSettings>) => {
    const group = saveGroupOf(patch);
    const keys = Object.keys(patch);
    const revisions = revisionRef.current;
    const mine = new Map<string, number>();
    for (const key of keys) {
      const next = (revisions.get(key) ?? 0) + 1;
      revisions.set(key, next);
      mine.set(key, next);
    }
    const isNewest = (key: string) => revisions.get(key) === mine.get(key);

    setSettings((current) => ({ ...current, ...patch }));
    const mirrored = storeSlice(patch, keys);
    if (Object.keys(mirrored).length > 0) useNotificationSettingsStore.setState(mirrored);

    window.electron?.notification
      ?.setSettings(patch)
      .then(() => {
        const confirmedRevisions = confirmedRevisionRef.current;
        const failedRevisions = failedRevisionRef.current;
        const confirmedNow: string[] = [];
        const retired: string[] = [];
        for (const key of keys) {
          const revision = mine.get(key) ?? 0;
          if (revision > (confirmedRevisions.get(key) ?? 0)) {
            confirmedRevisions.set(key, revision);
            confirmedRef.current = { ...confirmedRef.current, [key]: Reflect.get(patch, key) };
            confirmedNow.push(key);
          }
          const failed = failedRevisions.get(key);
          if (failed !== undefined && revision > failed) {
            failedRevisions.delete(key);
            retired.push(key);
          }
        }
        // An older write landed after the newest one had already failed and rolled the
        // screen back: main now holds this value, so the screen follows it.
        const landedBehindFailure = confirmedNow.filter(
          (key) => failedRevisions.get(key) === revisions.get(key)
        );
        if (landedBehindFailure.length > 0) {
          const landed = restoredPatch(confirmedRef.current, landedBehindFailure);
          setSettings((current) => ({ ...current, ...landed }));
          const landedStore = storeSlice(landed, landedBehindFailure);
          if (Object.keys(landedStore).length > 0) {
            useNotificationSettingsStore.setState(landedStore);
          }
        }
        // Only a newer success supersedes a failed value, so Retry never resends it
        // over something the user changed since — and an older success never hides it.
        if (retired.length > 0) setSaveFailures((failures) => withoutKeys(failures, retired));
      })
      .catch(() => {
        const stale = keys.filter(isNewest);
        if (stale.length === 0) return;
        for (const key of stale) failedRevisionRef.current.set(key, mine.get(key) ?? 0);
        const restored = restoredPatch(confirmedRef.current, stale);
        setSettings((current) => ({ ...current, ...restored }));
        const restoredStore = storeSlice(restored, stale);
        if (Object.keys(restoredStore).length > 0) {
          useNotificationSettingsStore.setState(restoredStore);
        }
        // Only the keys this save still owns are worth retrying.
        setSaveFailures((failures) => ({
          ...failures,
          [group]: { group, patch: { ...failures[group]?.patch, ...restoredPatch(patch, stale) } },
        }));
      });
  };

  const loadFailed = loadState === "error";
  // Until the real settings arrive every row shows a default, and editing one would
  // save over a value the user never saw — so nothing is editable while loading or
  // after a failed load.
  const unavailable = loading || loadFailed;
  const reset = <K extends keyof NotificationSettings>(key: K) => ({
    isModified: !unavailable && settings[key] !== DEFAULT_SETTINGS[key],
    onReset: () => update({ [key]: DEFAULT_SETTINGS[key] } as Partial<NotificationSettings>),
  });

  // The master switch gates every section below. Each row takes the disabled state
  // explicitly: a group resets the dependents context, so it can't reach across
  // sections from one wrapper.
  const masterOff = !settings.enabled || unavailable;
  const masterOffReason = unavailable ? undefined : "Turn on notifications to use this";

  const saveError = (group: SaveGroup) => {
    const failure = saveFailures[group];
    return failure ? (
      <SettingsLoadErrorBanner
        title="Couldn't save that change"
        message="The setting is back to its previous value."
        onRetry={() => update(failure.patch)}
      />
    ) : null;
  };

  const soundRow = (key: SoundFileKey) => (
    <SoundPickerRow
      label={NOTIFICATION_COPY.soundFiles[key]}
      value={settings[key]}
      onChange={(v) => {
        const patch: Partial<NotificationSettings> = {};
        patch[key] = v;
        update(patch);
      }}
      onPreview={previewNotificationSound}
      {...reset(key)}
    />
  );

  const scheduleModified =
    !unavailable &&
    (settings.quietHoursStartMin !== DEFAULT_SETTINGS.quietHoursStartMin ||
      settings.quietHoursEndMin !== DEFAULT_SETTINGS.quietHoursEndMin);

  return (
    <div className="space-y-8">
      <SettingsSection title="Agent notifications">
        {loadFailed && (
          <SettingsLoadErrorBanner
            title="Notification settings didn't load"
            message="Every setting on this page is unavailable until they do."
            onRetry={() => setLoadNonce((n) => n + 1)}
          />
        )}
        {saveError("agent")}
        <SettingsGroup>
          <SettingsSwitchCard
            title="Enable notifications"
            subtitle="Show toasts, the notification bell and OS notifications. While it's off, history still records everything."
            isEnabled={settings.enabled}
            onChange={() => update({ enabled: !settings.enabled })}
            ariaLabel="Enable notifications"
            disabled={unavailable}
            {...reset("enabled")}
          />

          <SettingsDependents disabled={masterOff} reason={masterOffReason}>
            <SwitchRow
              id="notif-completed"
              rowId="notifications-completed"
              label={NOTIFICATION_COPY.completed.label}
              description={NOTIFICATION_COPY.completed.description}
              checked={settings.completedEnabled}
              onChange={(v) => update({ completedEnabled: v })}
              {...reset("completedEnabled")}
            />
            <SwitchRow
              id="notif-waiting"
              rowId="notifications-waiting"
              label={NOTIFICATION_COPY.waiting.label}
              description={NOTIFICATION_COPY.waiting.description}
              checked={settings.waitingEnabled}
              onChange={(v) => update({ waitingEnabled: v })}
              {...reset("waitingEnabled")}
            />
            <SettingsDependents
              disabled={!settings.waitingEnabled}
              reason={masterOff ? undefined : NOTIFICATION_COPY.waitingOffReason}
            >
              <SwitchRow
                id="notif-waiting-escalation"
                label={NOTIFICATION_COPY.escalation.label}
                description={NOTIFICATION_COPY.escalation.description}
                checked={settings.waitingEscalationEnabled}
                onChange={(v) => update({ waitingEscalationEnabled: v })}
                {...reset("waitingEscalationEnabled")}
              />
              <SettingsPresetGroup<number>
                label={NOTIFICATION_COPY.escalationDelay.label}
                description={NOTIFICATION_COPY.escalationDelay.description}
                options={ESCALATION_DELAY_OPTIONS}
                value={settings.waitingEscalationDelayMs}
                onChange={(v) => update({ waitingEscalationDelayMs: v })}
                disabled={!settings.waitingEscalationEnabled}
                disabledReason={
                  masterOff || !settings.waitingEnabled
                    ? undefined
                    : NOTIFICATION_COPY.escalationOffReason
                }
                {...reset("waitingEscalationDelayMs")}
              />
            </SettingsDependents>
            <SwitchRow
              id="notif-all-clear-flash"
              label="Flash when agents stop working"
              description="Briefly flash the window, with or without sound, once two or more agents were working and none still is. An agent waiting for input counts as stopped."
              checked={settings.flashEnabled}
              onChange={(v) => update({ flashEnabled: v })}
              {...reset("flashEnabled")}
            />
          </SettingsDependents>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Sound">
        {saveError("sound")}
        <SettingsGroup>
          <SettingsSwitchCard
            id="notifications-sound"
            title={NOTIFICATION_COPY.sound.label}
            subtitle={NOTIFICATION_COPY.sound.description}
            isEnabled={settings.soundEnabled}
            onChange={() => update({ soundEnabled: !settings.soundEnabled })}
            ariaLabel="Play sound for notifications"
            disabled={masterOff}
            disabledReason={masterOffReason}
            {...reset("soundEnabled")}
          />

          <SettingsDependents
            disabled={!settings.soundEnabled || masterOff}
            reason={
              !masterOff && !settings.soundEnabled
                ? "Turn on Play sound to choose sounds and hear UI feedback"
                : undefined
            }
          >
            {soundRow("completedSoundFile")}
            {soundRow("waitingSoundFile")}
            {soundRow("escalationSoundFile")}
            <SwitchRow
              id="notif-working-pulse"
              label={NOTIFICATION_COPY.workingPulse.label}
              description={NOTIFICATION_COPY.workingPulse.description}
              checked={settings.workingPulseEnabled}
              onChange={(v) => update({ workingPulseEnabled: v })}
              {...reset("workingPulseEnabled")}
            />
            <SettingsDependents
              disabled={!settings.workingPulseEnabled}
              reason={
                masterOff || !settings.soundEnabled
                  ? undefined
                  : NOTIFICATION_COPY.workingPulseOffReason
              }
            >
              {soundRow("workingPulseSoundFile")}
            </SettingsDependents>
            <SettingsSwitchCard
              title="UI feedback sounds"
              subtitle="Short audio cues for git commit and push, worktree create and delete, agent spawn, and context injection"
              isEnabled={settings.uiFeedbackSoundEnabled}
              onChange={() => update({ uiFeedbackSoundEnabled: !settings.uiFeedbackSoundEnabled })}
              {...reset("uiFeedbackSoundEnabled")}
            />
          </SettingsDependents>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Quiet hours"
        description="History still records everything, and agents waiting for input always get through"
      >
        {saveError("quiet")}
        <SettingsGroup>
          <SettingsSwitchCard
            title="Mute on a schedule"
            subtitle="Suppress in-app toasts and OS notifications during a daily time window"
            isEnabled={settings.quietHoursEnabled}
            onChange={() => update({ quietHoursEnabled: !settings.quietHoursEnabled })}
            disabled={masterOff}
            disabledReason={masterOffReason}
            {...reset("quietHoursEnabled")}
          />

          {settings.quietHoursEnabled && (
            <SettingsDependents disabled={masterOff}>
              <SettingsRow
                label="Hours"
                description={describeSchedule(
                  settings.quietHoursStartMin,
                  settings.quietHoursEndMin
                )}
                isModified={scheduleModified}
                onReset={() =>
                  update({
                    quietHoursStartMin: DEFAULT_SETTINGS.quietHoursStartMin,
                    quietHoursEndMin: DEFAULT_SETTINGS.quietHoursEndMin,
                  })
                }
                resetAriaLabel="Reset quiet hours to 22:00 to 08:00"
                control={({ descriptionId, disabled }) => (
                  <div className="flex items-center gap-2">
                    <TimePicker
                      label="Starts at"
                      totalMinutes={settings.quietHoursStartMin}
                      describedBy={descriptionId}
                      disabled={disabled}
                      onChange={(value) => update({ quietHoursStartMin: value })}
                    />
                    <span className="text-xs text-text-secondary" aria-hidden="true">
                      to
                    </span>
                    <TimePicker
                      label="Ends at"
                      totalMinutes={settings.quietHoursEndMin}
                      describedBy={descriptionId}
                      disabled={disabled}
                      onChange={(value) => update({ quietHoursEndMin: value })}
                    />
                  </div>
                )}
              />
              <WeekdayRow
                weekdays={settings.quietHoursWeekdays}
                onChange={(next) => update({ quietHoursWeekdays: next })}
                isModified={!unavailable && settings.quietHoursWeekdays.length > 0}
                onReset={() => update({ quietHoursWeekdays: [] })}
              />
            </SettingsDependents>
          )}
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}

function TimePicker({
  label,
  totalMinutes,
  describedBy,
  disabled,
  onChange,
}: {
  label: string;
  totalMinutes: number;
  describedBy: string | undefined;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const current = clampMinutes(totalMinutes);
  // A stored time off the 15-minute grid still shows as itself rather than blank.
  const times = TIME_OPTIONS.includes(current)
    ? TIME_OPTIONS
    : [...TIME_OPTIONS, current].sort((a, b) => a - b);
  return (
    <Select value={String(current)} onValueChange={(v) => onChange(Number(v))} disabled={disabled}>
      <SelectTrigger aria-label={label} aria-describedby={describedBy} className="w-24">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {times.map((minutes) => (
          <SelectItem key={minutes} value={String(minutes)}>
            {formatTimeOfDay(minutes)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * `[]` is stored as "every day", so the schedule can never be narrowed to no days at
 * all: the last selected day stays selected, and the description says why. Clearing
 * it would otherwise flip the schedule from one day to all seven.
 */
function WeekdayRow({
  weekdays,
  onChange,
  isModified,
  onReset,
}: {
  weekdays: number[];
  onChange: (next: number[]) => void;
  isModified: boolean;
  onReset: () => void;
}) {
  const everyDay = weekdays.length === 0;
  const isActive = (day: number) => everyDay || weekdays.includes(day);
  const activeCount = everyDay ? WEEKDAYS.length : weekdays.length;

  const toggle = (day: number) => {
    const current = everyDay ? WEEKDAYS.map((d) => d.value) : weekdays;
    const next = current.includes(day)
      ? current.filter((d) => d !== day)
      : [...current, day].sort((a, b) => a - b);
    if (next.length === 0) return;
    onChange(next.length === WEEKDAYS.length ? [] : next);
  };

  return (
    <SettingsRow
      label="Active days"
      description={
        activeCount === 1
          ? "At least one day stays selected — turn off the schedule to stop it entirely"
          : "An overnight window counts toward the day it starts"
      }
      layout="stacked"
      isModified={isModified}
      onReset={onReset}
      resetAriaLabel="Reset active days to every day"
      control={({ labelId, descriptionId, disabled }) => (
        <div
          role="group"
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          className="flex flex-wrap gap-2"
        >
          {WEEKDAYS.map(({ value, label, name }) => {
            const active = isActive(value);
            const locked = active && activeCount === 1;
            return (
              <button
                key={value}
                type="button"
                disabled={disabled}
                aria-disabled={locked || undefined}
                aria-label={name}
                onClick={() => {
                  if (!locked) toggle(value);
                }}
                className={cn(
                  "px-2.5 py-1 text-xs rounded-[var(--radius-md)] border transition-colors",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  // The selected outline is a text-ramp token so it clears 3:1 against the
                  // card on every theme; the border ramp's strongest step does not.
                  active
                    ? "border-text-secondary bg-overlay-medium text-text-primary"
                    : "border-border-default bg-transparent text-text-secondary hover:text-text-primary"
                )}
                aria-pressed={active}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
    />
  );
}
