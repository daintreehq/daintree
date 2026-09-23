import { useState, useEffect } from "react";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitch } from "./SettingsSwitch";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { SettingsDependents, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { Button } from "@/components/ui/button";
import type { NotificationSettings } from "@shared/types";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";

const AVAILABLE_SOUNDS: { file: string; label: string }[] = [
  { file: "chime.wav", label: "Chime" },
  { file: "ping.wav", label: "Ping" },
  { file: "complete.wav", label: "Complete" },
  { file: "waiting.wav", label: "Waiting" },
  { file: "error.wav", label: "Error" },
  { file: "pulse.wav", label: "Pulse" },
];

const ESCALATION_DELAY_OPTIONS: { value: number; label: string }[] = [
  { value: 60_000, label: "1 minute" },
  { value: 180_000, label: "3 minutes" },
  { value: 300_000, label: "5 minutes" },
  { value: 600_000, label: "10 minutes" },
];

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

const HOUR_OPTIONS: { value: number; label: string }[] = Array.from({ length: 24 }, (_, h) => ({
  value: h,
  label: String(h).padStart(2, "0"),
}));

const MINUTE_OPTIONS: { value: number; label: string }[] = [0, 15, 30, 45].map((m) => ({
  value: m,
  label: String(m).padStart(2, "0"),
}));

const WEEKDAYS: { value: number; label: string }[] = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

function splitMinutes(total: number): { hour: number; minute: number } {
  const safe = Math.max(0, Math.min(1439, Math.floor(total)));
  return { hour: Math.floor(safe / 60), minute: safe % 60 };
}

function joinMinutes(hour: number, minute: number): number {
  return Math.max(0, Math.min(1439, hour * 60 + minute));
}

const NATIVE_SELECT_CLASS =
  "px-3 pr-8 py-1.5 text-sm rounded-[var(--radius-md)] border border-border-strong bg-surface-canvas text-text-primary focus:border-daintree-accent/40 focus:outline-hidden transition-colors disabled:opacity-50";

/**
 * A switch row whose `id` lands on the switch itself rather than the row, so the
 * control stays addressable by the ids end-to-end specs and deep links already use.
 */
function SwitchRow({
  id,
  label,
  description,
  checked,
  onChange,
  isModified,
  onReset,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  isModified?: boolean;
  onReset?: () => void;
}) {
  return (
    <SettingsRow
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

function SoundFileRow({
  label,
  value,
  defaultValue,
  onChange,
  onPreview,
}: {
  label: string;
  value: string;
  defaultValue: string;
  onChange: (value: string) => void;
  onPreview: () => void;
}) {
  return (
    <SettingsRow
      label={label}
      isModified={value !== defaultValue}
      onReset={() => onChange(defaultValue)}
      control={({ labelId, descriptionId, disabled }) => (
        <div className="flex items-center gap-2">
          <select
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className={cn(NATIVE_SELECT_CLASS, "w-36")}
          >
            {AVAILABLE_SOUNDS.map(({ file, label: soundLabel }) => (
              <option key={file} value={file}>
                {soundLabel}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            onClick={onPreview}
            disabled={disabled}
            aria-label={`Preview ${label.toLowerCase()}`}
          >
            <Play aria-hidden="true" />
            Preview
          </Button>
        </div>
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
  workingPulseEnabled: "agent",
  groupByContext: "agent",
  soundEnabled: "sound",
  completedSoundFile: "sound",
  waitingSoundFile: "sound",
  escalationSoundFile: "sound",
  workingPulseSoundFile: "sound",
  uiFeedbackSoundEnabled: "sound",
  flashEnabled: "agent",
  quietHoursEnabled: "quiet",
  quietHoursStartMin: "quiet",
  quietHoursEndMin: "quiet",
  quietHoursWeekdays: "quiet",
};

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
  // registered — so the failure stays on the group until a save there succeeds.
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);
  const loading = loadState === "loading";
  // Gate the inline "Loading…" hint past the Doherty threshold so fast IPC
  // resolutions don't flash a loading state for sub-400ms work.
  const showInlineLoading = useDeferredLoading(loading, UI_DOHERTY_THRESHOLD);

  useEffect(() => {
    setLoadState("loading");
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) setLoadState("error");
    }, 10_000);

    window.electron?.notification
      ?.getSettings()
      .then((s) => {
        settled = true;
        clearTimeout(timer);
        setSettings(s);
        setLoadState("ready");
      })
      .catch(() => {
        settled = true;
        clearTimeout(timer);
        setLoadState("error");
      });

    return () => clearTimeout(timer);
  }, [loadNonce]);

  const update = async (patch: Partial<NotificationSettings>) => {
    const prevStore = useNotificationSettingsStore.getState();
    const group = saveGroupOf(patch);
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      window.electron?.notification
        ?.setSettings(patch)
        .then(() => {
          setSaveFailure((current) => (current?.group === group ? null : current));
        })
        .catch(() => {
          setSaveFailure({ group, patch });
          setSettings(prev);
          const revert: Partial<{
            enabled: boolean;
            completedEnabled: boolean;
            waitingEnabled: boolean;
            workingPulseEnabled: boolean;
            uiFeedbackSoundEnabled: boolean;
            flashEnabled: boolean;
            quietHoursEnabled: boolean;
            quietHoursStartMin: number;
            quietHoursEndMin: number;
            quietHoursWeekdays: number[];
          }> = {};
          if (patch.enabled !== undefined) revert.enabled = prevStore.enabled;
          if (patch.completedEnabled !== undefined)
            revert.completedEnabled = prevStore.completedEnabled;
          if (patch.waitingEnabled !== undefined) revert.waitingEnabled = prevStore.waitingEnabled;
          if (patch.workingPulseEnabled !== undefined)
            revert.workingPulseEnabled = prevStore.workingPulseEnabled;
          if (patch.uiFeedbackSoundEnabled !== undefined)
            revert.uiFeedbackSoundEnabled = prevStore.uiFeedbackSoundEnabled;
          if (patch.flashEnabled !== undefined) revert.flashEnabled = prevStore.flashEnabled;
          if (patch.quietHoursEnabled !== undefined)
            revert.quietHoursEnabled = prevStore.quietHoursEnabled;
          if (patch.quietHoursStartMin !== undefined)
            revert.quietHoursStartMin = prevStore.quietHoursStartMin;
          if (patch.quietHoursEndMin !== undefined)
            revert.quietHoursEndMin = prevStore.quietHoursEndMin;
          if (patch.quietHoursWeekdays !== undefined)
            revert.quietHoursWeekdays = prevStore.quietHoursWeekdays;
          if (Object.keys(revert).length > 0) {
            useNotificationSettingsStore.setState(revert);
          }
        });
      return next;
    });
    const storePatch: Partial<{
      enabled: boolean;
      completedEnabled: boolean;
      waitingEnabled: boolean;
      workingPulseEnabled: boolean;
      uiFeedbackSoundEnabled: boolean;
      flashEnabled: boolean;
      quietHoursEnabled: boolean;
      quietHoursStartMin: number;
      quietHoursEndMin: number;
      quietHoursWeekdays: number[];
    }> = {};
    if (patch.enabled !== undefined) storePatch.enabled = patch.enabled;
    if (patch.completedEnabled !== undefined) storePatch.completedEnabled = patch.completedEnabled;
    if (patch.waitingEnabled !== undefined) storePatch.waitingEnabled = patch.waitingEnabled;
    if (patch.workingPulseEnabled !== undefined)
      storePatch.workingPulseEnabled = patch.workingPulseEnabled;
    if (patch.uiFeedbackSoundEnabled !== undefined)
      storePatch.uiFeedbackSoundEnabled = patch.uiFeedbackSoundEnabled;
    if (patch.flashEnabled !== undefined) storePatch.flashEnabled = patch.flashEnabled;
    if (patch.quietHoursEnabled !== undefined)
      storePatch.quietHoursEnabled = patch.quietHoursEnabled;
    if (patch.quietHoursStartMin !== undefined)
      storePatch.quietHoursStartMin = patch.quietHoursStartMin;
    if (patch.quietHoursEndMin !== undefined) storePatch.quietHoursEndMin = patch.quietHoursEndMin;
    if (patch.quietHoursWeekdays !== undefined)
      storePatch.quietHoursWeekdays = patch.quietHoursWeekdays;
    if (Object.keys(storePatch).length > 0) {
      useNotificationSettingsStore.setState(storePatch);
    }
  };

  const handlePreview = (soundFile: string) => {
    window.electron?.notification?.playSound(soundFile).catch(() => {});
  };

  const loadFailed = loadState === "error";
  // Until the real settings arrive every row shows a default, and editing one would
  // save over a value the user never saw — so nothing is editable while loading or
  // after a failed load.
  const unavailable = loading || loadFailed;
  const reset = <K extends keyof NotificationSettings>(key: K) => ({
    isModified: !unavailable && settings[key] !== DEFAULT_SETTINGS[key],
    onReset: () => void update({ [key]: DEFAULT_SETTINGS[key] } as Partial<NotificationSettings>),
  });

  // The master switch gates every section below. Each row takes the disabled state
  // explicitly: a group resets the dependents context, so it can't reach across
  // sections from one wrapper.
  const masterOff = !settings.enabled || unavailable;
  const masterOffReason = unavailable ? undefined : "Turn on notifications to use this";

  const saveError = (group: SaveGroup) =>
    saveFailure?.group === group ? (
      <SettingsLoadErrorBanner
        title="Couldn't save that change"
        message="The setting is back to its previous value."
        onRetry={() => void update(saveFailure.patch)}
      />
    ) : null;

  return (
    <div className="space-y-8">
      {showInlineLoading && <p className="text-xs text-text-secondary">Loading…</p>}

      <SettingsSection
        title="Agent notifications"
        description="Suppressed while you're already viewing the relevant worktree."
      >
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
            subtitle="Show toast popups and the notification bell. When off, notifications are still recorded in history"
            isEnabled={settings.enabled}
            onChange={() => update({ enabled: !settings.enabled })}
            ariaLabel="Enable notifications"
            disabled={unavailable}
            {...reset("enabled")}
          />

          <SettingsDependents disabled={masterOff} reason={masterOffReason}>
            <SwitchRow
              id="notif-completed"
              label="Agent completed"
              description="Send an OS notification when an agent finishes its task"
              checked={settings.completedEnabled}
              onChange={(v) => update({ completedEnabled: v })}
              {...reset("completedEnabled")}
            />
            <SwitchRow
              id="notif-waiting"
              label="Agent waiting for input"
              description="Send an OS notification as soon as an agent needs input, whatever has focus"
              checked={settings.waitingEnabled}
              onChange={(v) => update({ waitingEnabled: v })}
              {...reset("waitingEnabled")}
            />
            <SettingsDependents
              disabled={!settings.waitingEnabled}
              reason={
                masterOff ? undefined : "Turn on Agent waiting for input to escalate reminders"
              }
            >
              <SwitchRow
                id="notif-waiting-escalation"
                label="Escalate if still waiting"
                description="Send a second OS notification if a docked agent is still waiting after the delay"
                checked={settings.waitingEscalationEnabled}
                onChange={(v) => update({ waitingEscalationEnabled: v })}
                {...reset("waitingEscalationEnabled")}
              />
              <SettingsRow
                label="Escalation delay"
                disabled={!settings.waitingEscalationEnabled}
                disabledReason={
                  masterOff || !settings.waitingEnabled
                    ? undefined
                    : "Turn on Escalate if still waiting to choose a delay"
                }
                {...reset("waitingEscalationDelayMs")}
                control={({ labelId, descriptionId, disabled }) => (
                  <select
                    aria-labelledby={labelId}
                    aria-describedby={descriptionId}
                    value={settings.waitingEscalationDelayMs}
                    disabled={disabled}
                    onChange={(e) => update({ waitingEscalationDelayMs: Number(e.target.value) })}
                    className={NATIVE_SELECT_CLASS}
                  >
                    {ESCALATION_DELAY_OPTIONS.map(({ value, label }) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
              />
            </SettingsDependents>
            <SwitchRow
              id="notif-working-pulse"
              label="Working pulse"
              description="Play a quiet periodic sound while a watched or docked agent is working in the background"
              checked={settings.workingPulseEnabled}
              onChange={(v) => update({ workingPulseEnabled: v })}
              {...reset("workingPulseEnabled")}
            />
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
            title="Play sound"
            subtitle="Master switch for every sound, including UI feedback sounds"
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
            <SoundFileRow
              label="Completed sound"
              value={settings.completedSoundFile}
              defaultValue={DEFAULT_SETTINGS.completedSoundFile}
              onChange={(v) => update({ completedSoundFile: v })}
              onPreview={() => handlePreview(settings.completedSoundFile)}
            />
            <SoundFileRow
              label="Waiting sound"
              value={settings.waitingSoundFile}
              defaultValue={DEFAULT_SETTINGS.waitingSoundFile}
              onChange={(v) => update({ waitingSoundFile: v })}
              onPreview={() => handlePreview(settings.waitingSoundFile)}
            />
            <SoundFileRow
              label="Escalation sound"
              value={settings.escalationSoundFile}
              defaultValue={DEFAULT_SETTINGS.escalationSoundFile}
              onChange={(v) => update({ escalationSoundFile: v })}
              onPreview={() => handlePreview(settings.escalationSoundFile)}
            />
            <SoundFileRow
              label="Working pulse sound"
              value={settings.workingPulseSoundFile}
              defaultValue={DEFAULT_SETTINGS.workingPulseSoundFile}
              onChange={(v) => update({ workingPulseSoundFile: v })}
              onPreview={() => handlePreview(settings.workingPulseSoundFile)}
            />
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
        description="History still records everything, and agents waiting for input always get through."
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
              <QuietHoursTimeRow
                label="Starts at"
                totalMinutes={settings.quietHoursStartMin}
                onChange={(value) => update({ quietHoursStartMin: value })}
              />
              <QuietHoursTimeRow
                label="Ends at"
                description={
                  settings.quietHoursStartMin === settings.quietHoursEndMin
                    ? "Start and end match, so the schedule does nothing until the times differ"
                    : undefined
                }
                totalMinutes={settings.quietHoursEndMin}
                onChange={(value) => update({ quietHoursEndMin: value })}
              />
              <SettingsRow
                label="Active days"
                description="Leave every day selected to apply the schedule daily"
                layout="stacked"
                control={({ labelId, descriptionId, disabled }) => (
                  <div
                    role="group"
                    aria-labelledby={labelId}
                    aria-describedby={descriptionId}
                    className="flex flex-wrap gap-2"
                  >
                    {WEEKDAYS.map(({ value, label }) => {
                      const active =
                        settings.quietHoursWeekdays.length === 0 ||
                        settings.quietHoursWeekdays.includes(value);
                      return (
                        <button
                          key={value}
                          type="button"
                          disabled={disabled}
                          onClick={() => {
                            const current = settings.quietHoursWeekdays;
                            const allDays = current.length === 0;
                            const next = allDays
                              ? WEEKDAYS.map((d) => d.value).filter((d) => d !== value)
                              : current.includes(value)
                                ? current.filter((d) => d !== value)
                                : [...current, value].sort((a, b) => a - b);
                            const normalized = next.length === WEEKDAYS.length ? [] : next;
                            update({ quietHoursWeekdays: normalized });
                          }}
                          className={cn(
                            "px-2.5 py-1 text-xs rounded-[var(--radius-md)] border transition-colors disabled:opacity-50",
                            active
                              ? "border-border-strong bg-overlay-medium text-text-primary"
                              : "border-border-default bg-surface-canvas text-text-secondary hover:text-text-primary"
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
            </SettingsDependents>
          )}
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}

function QuietHoursTimeRow({
  label,
  description,
  totalMinutes,
  onChange,
}: {
  label: string;
  description?: string;
  totalMinutes: number;
  onChange: (value: number) => void;
}) {
  const { hour, minute } = splitMinutes(totalMinutes);
  return (
    <SettingsRow
      label={label}
      description={description}
      control={({ descriptionId, disabled }) => (
        <div className="flex items-center gap-2">
          <select
            aria-label={`${label} hour`}
            aria-describedby={descriptionId}
            value={hour}
            disabled={disabled}
            onChange={(e) => onChange(joinMinutes(Number(e.target.value), minute))}
            className={NATIVE_SELECT_CLASS}
          >
            {HOUR_OPTIONS.map(({ value, label: hourLabel }) => (
              <option key={value} value={value}>
                {hourLabel}
              </option>
            ))}
          </select>
          <span className="text-sm text-text-secondary" aria-hidden="true">
            :
          </span>
          <select
            aria-label={`${label} minute`}
            aria-describedby={descriptionId}
            value={minute}
            disabled={disabled}
            onChange={(e) => onChange(joinMinutes(hour, Number(e.target.value)))}
            className={NATIVE_SELECT_CLASS}
          >
            {MINUTE_OPTIONS.map(({ value, label: minuteLabel }) => (
              <option key={value} value={value}>
                {minuteLabel}
              </option>
            ))}
          </select>
        </div>
      )}
    />
  );
}
