import { useState, useEffect } from "react";
import { Play, Bell, BellOff, Volume2 } from "lucide-react";
import { SettingsSection } from "./SettingsSection";
import { SettingsCheckbox } from "./SettingsCheckbox";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import type { NotificationSettings } from "@shared/types";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";

const AVAILABLE_SOUNDS: { file: string; label: string }[] = [
  { file: "chime.wav", label: "Chime (default)" },
  { file: "ping.wav", label: "Ping" },
  { file: "complete.wav", label: "Complete" },
  { file: "waiting.wav", label: "Waiting" },
  { file: "error.wav", label: "Error" },
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
  waitingEnabled: false,
  soundEnabled: false,
  soundFile: "chime.wav",
  waitingEscalationEnabled: true,
  waitingEscalationDelayMs: 180_000,
};

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
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      window.electron?.notification?.setSettings(patch).catch(() => setSettings(prev));
      return next;
    });
    if (patch.enabled !== undefined) {
      useNotificationSettingsStore.setState({ enabled: patch.enabled });
    }
  };

  const handlePreview = () => {
    window.electron?.notification?.playSound(settings.soundFile).catch(() => {});
  };

  if (loadState === "loading") {
    return <div className="text-sm text-canopy-text/50">Loading…</div>;
  }

  if (loadState === "error") {
    return (
      <div className="text-sm text-canopy-text/60">
        Could not load notification settings. Restart Canopy and try again.
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

      <div className={settings.enabled ? undefined : "opacity-50 pointer-events-none"}>
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
            <div className="ml-6 space-y-3 border-l border-canopy-border pl-4">
              <SettingsCheckbox
                id="notif-waiting-escalation"
                label="Escalate if still waiting"
                description="Fire an additional OS notification if a docked agent remains waiting after the delay below"
                checked={settings.waitingEscalationEnabled}
                onChange={(v) => update({ waitingEscalationEnabled: v })}
              />
              {settings.waitingEscalationEnabled && (
                <div className="space-y-1">
                  <label className="text-sm font-medium text-canopy-text block">
                    Escalation delay
                  </label>
                  <select
                    value={settings.waitingEscalationDelayMs}
                    onChange={(e) => update({ waitingEscalationDelayMs: Number(e.target.value) })}
                    className="px-3 py-2 text-sm rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg text-canopy-text focus:border-canopy-accent focus:outline-none transition-colors"
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
            <div className="space-y-2">
              <label className="text-sm font-medium text-canopy-text block">Sound</label>
              <div className="flex items-center gap-2">
                <select
                  value={settings.soundFile}
                  onChange={(e) => update({ soundFile: e.target.value })}
                  className="flex-1 px-3 py-2 text-sm rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg text-canopy-text focus:border-canopy-accent focus:outline-none transition-colors"
                >
                  {AVAILABLE_SOUNDS.map(({ file, label }) => (
                    <option key={file} value={file}>
                      {label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={handlePreview}
                  title="Preview sound"
                  className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg text-canopy-text hover:bg-tint/[0.06] transition-colors"
                >
                  <Play className="h-3.5 w-3.5" />
                  Preview
                </button>
              </div>
            </div>
          )}
        </div>
      </SettingsSection>
      </div>
    </div>
  );
}
