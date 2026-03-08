import { useState, useEffect } from "react";
import { Play, Bell, Volume2 } from "lucide-react";
import { SettingsSection } from "./SettingsSection";
import { SettingsCheckbox } from "./SettingsCheckbox";
import type { NotificationSettings } from "@shared/types";

const AVAILABLE_SOUNDS: { file: string; label: string }[] = [
  { file: "chime.wav", label: "Chime (default)" },
  { file: "ping.wav", label: "Ping" },
  { file: "complete.wav", label: "Complete" },
  { file: "waiting.wav", label: "Waiting" },
  { file: "error.wav", label: "Error" },
];

const DEFAULT_SETTINGS: NotificationSettings = {
  completedEnabled: false,
  waitingEnabled: false,
  failedEnabled: false,
  soundEnabled: false,
  soundFile: "chime.wav",
};

type LoadState = "loading" | "ready" | "error";

export function NotificationSettingsTab() {
  const [settings, setSettings] = useState<NotificationSettings>(DEFAULT_SETTINGS);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  useEffect(() => {
    window.electron?.notification
      ?.getSettings()
      .then((s) => {
        setSettings(s);
        setLoadState("ready");
      })
      .catch(() => setLoadState("error"));
  }, []);

  const update = async (patch: Partial<NotificationSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      window.electron?.notification?.setSettings(patch).catch(() => setSettings(prev));
      return next;
    });
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
          <SettingsCheckbox
            id="notif-failed"
            label="Agent failed"
            description="Show a notification when an agent encounters an error"
            checked={settings.failedEnabled}
            onChange={(v) => update({ failedEnabled: v })}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        icon={Volume2}
        title="Sound"
        description="Play a sound when a notification fires."
      >
        <div className="space-y-4">
          <SettingsCheckbox
            id="notif-sound"
            label="Play sound"
            description="Enable audio alerts for agent notifications"
            checked={settings.soundEnabled}
            onChange={(v) => update({ soundEnabled: v })}
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
                  className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg text-canopy-text hover:bg-white/[0.06] transition-colors"
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
  );
}
