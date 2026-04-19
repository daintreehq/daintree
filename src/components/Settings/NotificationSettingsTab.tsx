import { useState, useEffect } from "react";
import { Play, Bell, BellOff, Volume2, AudioLines, Moon } from "lucide-react";
import { cn } from "@/lib/utils";
import { SettingsSection } from "./SettingsSection";
import { SettingsCheckbox } from "./SettingsCheckbox";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
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
  soundEnabled: true,
  completedSoundFile: "complete.wav",
  waitingSoundFile: "waiting.wav",
  escalationSoundFile: "ping.wav",
  waitingEscalationEnabled: false,
  waitingEscalationDelayMs: 180_000,
  workingPulseEnabled: false,
  workingPulseSoundFile: "pulse.wav",
  uiFeedbackSoundEnabled: false,
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

type LoadState = "loading" | "ready" | "error";

export function NotificationSettingsTab() {
  const [settings, setSettings] = useState<NotificationSettings>(DEFAULT_SETTINGS);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  useEffect(() => {
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
  }, []);

  const update = async (patch: Partial<NotificationSettings>) => {
    const prevStore = useNotificationSettingsStore.getState();
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      window.electron?.notification?.setSettings(patch).catch(() => {
        setSettings(prev);
        const revert: Partial<{
          enabled: boolean;
          quietHoursEnabled: boolean;
          quietHoursStartMin: number;
          quietHoursEndMin: number;
          quietHoursWeekdays: number[];
        }> = {};
        if (patch.enabled !== undefined) revert.enabled = prevStore.enabled;
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
      quietHoursEnabled: boolean;
      quietHoursStartMin: number;
      quietHoursEndMin: number;
      quietHoursWeekdays: number[];
    }> = {};
    if (patch.enabled !== undefined) storePatch.enabled = patch.enabled;
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

  if (loadState === "loading") {
    return <div className="text-sm text-daintree-text/50">Loading…</div>;
  }

  if (loadState === "error") {
    return (
      <div className="text-sm text-daintree-text/60">
        Could not load notification settings. Restart Daintree and try again.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsSwitchCard
        variant="compact"
        title="Enable notifications"
        subtitle="Show toast popups and the notification bell. When disabled, notifications are still recorded in history."
        isEnabled={settings.enabled}
        onChange={() => update({ enabled: !settings.enabled })}
        ariaLabel="Enable notifications"
        icon={settings.enabled ? Bell : BellOff}
      />

      <div className={cn("space-y-6", !settings.enabled && "opacity-50 pointer-events-none")}>
        <SettingsSection
          icon={Bell}
          title="Agent Notifications"
          description="OS notifications are off by default. Enable individual event types below to receive native alerts for agent activity. Notifications are suppressed when you are already viewing the relevant worktree."
        >
          <div className="space-y-3">
            <SettingsCheckbox
              id="notif-completed"
              label="Agent completed"
              description="Show a notification when an agent finishes its task"
              checked={settings.completedEnabled}
              onChange={(v) => update({ completedEnabled: v })}
            />
            <SettingsCheckbox
              id="notif-waiting"
              label="Agent waiting for input"
              description="Show a notification immediately when an agent needs input — always fires regardless of focus"
              checked={settings.waitingEnabled}
              onChange={(v) => update({ waitingEnabled: v })}
            />
            {settings.waitingEnabled && (
              <div className="ml-6 space-y-3 border-l border-daintree-border pl-4">
                <SettingsCheckbox
                  id="notif-waiting-escalation"
                  label="Escalate if still waiting"
                  description="Fire an additional OS notification if a docked agent remains waiting after the delay below"
                  checked={settings.waitingEscalationEnabled}
                  onChange={(v) => update({ waitingEscalationEnabled: v })}
                />
                {settings.waitingEscalationEnabled && (
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-daintree-text block">
                      Escalation delay
                    </label>
                    <select
                      value={settings.waitingEscalationDelayMs}
                      onChange={(e) => update({ waitingEscalationDelayMs: Number(e.target.value) })}
                      className="px-3 pr-8 py-1.5 text-sm rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg text-daintree-text focus:border-daintree-accent focus:outline-none transition-colors"
                    >
                      {ESCALATION_DELAY_OPTIONS.map(({ value, label }) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}
            <SettingsCheckbox
              id="notif-working-pulse"
              label="Working pulse"
              description="Play a quiet periodic sound while a watched or docked agent is working in the background"
              checked={settings.workingPulseEnabled}
              onChange={(v) => update({ workingPulseEnabled: v })}
            />
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Volume2}
          title="Sound"
          description="Play a sound when a notification fires."
        >
          <div className="space-y-4">
            <SettingsSwitchCard
              variant="compact"
              title="Play sound"
              subtitle="Enable audio alerts for agent notifications"
              isEnabled={settings.soundEnabled}
              onChange={() => update({ soundEnabled: !settings.soundEnabled })}
              ariaLabel="Play sound for notifications"
            />

            {settings.soundEnabled && (
              <div className="space-y-4">
                {(
                  [
                    {
                      label: "Completed sound",
                      field: "completedSoundFile" as const,
                    },
                    {
                      label: "Waiting sound",
                      field: "waitingSoundFile" as const,
                    },
                    {
                      label: "Escalation sound",
                      field: "escalationSoundFile" as const,
                    },
                    {
                      label: "Working pulse sound",
                      field: "workingPulseSoundFile" as const,
                    },
                  ] as const
                ).map(({ label, field }) => (
                  <div key={field} className="space-y-1">
                    <label className="text-sm font-medium text-daintree-text block">{label}</label>
                    <div className="flex items-center gap-2">
                      <select
                        value={settings[field]}
                        onChange={(e) => update({ [field]: e.target.value })}
                        className="flex-1 px-3 pr-8 py-1.5 text-sm rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg text-daintree-text focus:border-daintree-accent focus:outline-none transition-colors"
                      >
                        {AVAILABLE_SOUNDS.map(({ file, label: soundLabel }) => (
                          <option key={file} value={file}>
                            {soundLabel}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => handlePreview(settings[field])}
                        title={`Preview ${label.toLowerCase()}`}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg text-daintree-text hover:bg-tint/[0.06] transition-colors"
                      >
                        <Play className="h-3.5 w-3.5" />
                        Preview
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Moon}
          title="Quiet Hours"
          description="Suppress in-app toasts and OS notifications during a daily time window. History still records everything, and agents waiting for input always page through."
        >
          <div className="space-y-4">
            <SettingsSwitchCard
              variant="compact"
              title="Enable quiet hours"
              subtitle="Mute non-urgent notifications during the configured window"
              isEnabled={settings.quietHoursEnabled}
              onChange={() => update({ quietHoursEnabled: !settings.quietHoursEnabled })}
              ariaLabel="Enable quiet hours"
            />

            {settings.quietHoursEnabled && (
              <div className="space-y-4 ml-6 border-l border-daintree-border pl-4">
                <QuietHoursTimeRow
                  label="Starts at"
                  totalMinutes={settings.quietHoursStartMin}
                  onChange={(value) => update({ quietHoursStartMin: value })}
                />
                <QuietHoursTimeRow
                  label="Ends at"
                  totalMinutes={settings.quietHoursEndMin}
                  onChange={(value) => update({ quietHoursEndMin: value })}
                />
                {settings.quietHoursStartMin === settings.quietHoursEndMin && (
                  <div className="text-xs text-daintree-text/60">
                    Start and end match — the schedule is effectively disabled until the times
                    differ.
                  </div>
                )}
                <div className="space-y-1">
                  <label className="text-sm font-medium text-daintree-text block">
                    Active days
                  </label>
                  <div className="text-xs text-daintree-text/60 mb-2">
                    Leave all boxes checked to apply every day.
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {WEEKDAYS.map(({ value, label }) => {
                      const active =
                        settings.quietHoursWeekdays.length === 0 ||
                        settings.quietHoursWeekdays.includes(value);
                      return (
                        <button
                          key={value}
                          type="button"
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
                            "px-2.5 py-1 text-xs rounded-[var(--radius-md)] border transition-colors",
                            active
                              ? "border-daintree-accent bg-daintree-accent/10 text-daintree-text"
                              : "border-daintree-border bg-daintree-bg text-daintree-text/50 hover:text-daintree-text/80"
                          )}
                          aria-pressed={active}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </SettingsSection>

        <SettingsSection
          icon={AudioLines}
          title="UI Feedback Sounds"
          description="Play subtle audio cues for git operations, worktree lifecycle, agent spawning, and context injection. These sounds are independent of agent notification sounds above."
        >
          <SettingsSwitchCard
            variant="compact"
            title="Enable UI feedback sounds"
            subtitle="Short audio cues for git commit, push, worktree create/delete, agent spawn, and context injection"
            isEnabled={settings.uiFeedbackSoundEnabled}
            onChange={() => update({ uiFeedbackSoundEnabled: !settings.uiFeedbackSoundEnabled })}
            ariaLabel="Enable UI feedback sounds"
          />
        </SettingsSection>
      </div>
    </div>
  );
}

function QuietHoursTimeRow({
  label,
  totalMinutes,
  onChange,
}: {
  label: string;
  totalMinutes: number;
  onChange: (value: number) => void;
}) {
  const { hour, minute } = splitMinutes(totalMinutes);
  const selectClass =
    "px-3 pr-8 py-1.5 text-sm rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg text-daintree-text focus:border-daintree-accent focus:outline-none transition-colors";
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium text-daintree-text block">{label}</label>
      <div className="flex items-center gap-2">
        <select
          aria-label={`${label} hour`}
          value={hour}
          onChange={(e) => onChange(joinMinutes(Number(e.target.value), minute))}
          className={selectClass}
        >
          {HOUR_OPTIONS.map(({ value, label: hourLabel }) => (
            <option key={value} value={value}>
              {hourLabel}
            </option>
          ))}
        </select>
        <span className="text-sm text-daintree-text/60">:</span>
        <select
          aria-label={`${label} minute`}
          value={minute}
          onChange={(e) => onChange(joinMinutes(hour, Number(e.target.value)))}
          className={selectClass}
        >
          {MINUTE_OPTIONS.map(({ value, label: minuteLabel }) => (
            <option key={value} value={value}>
              {minuteLabel}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
