import { useState, useEffect, useCallback } from "react";
import { Bell, Volume2, Play } from "lucide-react";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsCheckbox } from "@/components/Settings/SettingsCheckbox";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import type { NotificationSettings } from "@shared/types/ipc/api";

const AVAILABLE_SOUNDS: { file: string; label: string }[] = [
  { file: "chime.wav", label: "Chime" },
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

interface ProjectNotificationsTabProps {
  overrides: Partial<NotificationSettings>;
  onChange: (overrides: Partial<NotificationSettings>) => void;
}

export function ProjectNotificationsTab({ overrides, onChange }: ProjectNotificationsTabProps) {
  const [globalSettings, setGlobalSettings] = useState<NotificationSettings | null>(null);

  useEffect(() => {
    window.electron?.notification
      ?.getSettings()
      .then(setGlobalSettings)
      .catch(() => {});
  }, []);

  const setOverride = useCallback(
    <K extends keyof NotificationSettings>(key: K, value: NotificationSettings[K]) => {
      onChange({ ...overrides, [key]: value });
    },
    [overrides, onChange]
  );

  const clearOverrides = useCallback(
    (...keys: (keyof NotificationSettings)[]) => {
      const next = { ...overrides };
      for (const key of keys) delete next[key];
      onChange(next);
    },
    [overrides, onChange]
  );

  const handlePreview = (soundFile: string) => {
    window.electron?.notification?.playSound(soundFile).catch(() => {});
  };

  if (!globalSettings) {
    return <div className="text-sm text-canopy-text/50">Loading global settings…</div>;
  }

  const effective = (key: keyof NotificationSettings) =>
    overrides[key] !== undefined ? overrides[key] : globalSettings[key];

  return (
    <div className="space-y-6">
      <div className="text-sm text-canopy-text/60 mb-4">
        Override global notification settings for this project. Unchecked overrides inherit the
        global default.
      </div>

      <SettingsSection
        icon={Bell}
        title="Agent Notifications"
        description="Override which agent events trigger OS notifications for this project."
      >
        <div className="space-y-3">
          <OverrideRow
            label="Agent completed"
            description="Show a notification when an agent finishes its task"
            isOverridden={overrides.completedEnabled !== undefined}
            onToggleOverride={(on) => {
              if (on) setOverride("completedEnabled", globalSettings.completedEnabled);
              else clearOverrides("completedEnabled");
            }}
          >
            <SettingsCheckbox
              id="proj-notif-completed"
              label="Enabled"
              description="Override the global completed notification setting"
              checked={effective("completedEnabled") as boolean}
              onChange={(v) => setOverride("completedEnabled", v)}
            />
          </OverrideRow>

          <OverrideRow
            label="Agent waiting for input"
            description="Show a notification immediately when an agent needs input"
            isOverridden={overrides.waitingEnabled !== undefined}
            onToggleOverride={(on) => {
              if (on) setOverride("waitingEnabled", globalSettings.waitingEnabled);
              else {
                clearOverrides(
                  "waitingEnabled",
                  "waitingEscalationEnabled",
                  "waitingEscalationDelayMs"
                );
              }
            }}
          >
            <SettingsCheckbox
              id="proj-notif-waiting"
              label="Enabled"
              description="Override the global waiting notification setting"
              checked={effective("waitingEnabled") as boolean}
              onChange={(v) => setOverride("waitingEnabled", v)}
            />
            {(effective("waitingEnabled") as boolean) && (
              <div className="ml-6 space-y-3 border-l border-canopy-border pl-4 mt-2">
                <OverrideRow
                  label="Escalate if still waiting"
                  description="Fire an additional OS notification if a docked agent remains waiting"
                  isOverridden={overrides.waitingEscalationEnabled !== undefined}
                  onToggleOverride={(on) => {
                    if (on)
                      setOverride(
                        "waitingEscalationEnabled",
                        globalSettings.waitingEscalationEnabled
                      );
                    else {
                      clearOverrides("waitingEscalationEnabled", "waitingEscalationDelayMs");
                    }
                  }}
                >
                  <SettingsCheckbox
                    id="proj-notif-escalation"
                    label="Enabled"
                    description="Override the global escalation setting"
                    checked={effective("waitingEscalationEnabled") as boolean}
                    onChange={(v) => setOverride("waitingEscalationEnabled", v)}
                  />
                </OverrideRow>

                {(effective("waitingEscalationEnabled") as boolean) && (
                  <OverrideRow
                    label="Escalation delay"
                    isOverridden={overrides.waitingEscalationDelayMs !== undefined}
                    onToggleOverride={(on) => {
                      if (on)
                        setOverride(
                          "waitingEscalationDelayMs",
                          globalSettings.waitingEscalationDelayMs
                        );
                      else clearOverrides("waitingEscalationDelayMs");
                    }}
                  >
                    <select
                      value={effective("waitingEscalationDelayMs") as number}
                      onChange={(e) =>
                        setOverride("waitingEscalationDelayMs", Number(e.target.value))
                      }
                      className="px-3 py-2 text-sm rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg text-canopy-text focus:border-canopy-accent focus:outline-none transition-colors"
                    >
                      {ESCALATION_DELAY_OPTIONS.map(({ value, label }) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </OverrideRow>
                )}
              </div>
            )}
          </OverrideRow>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={Volume2}
        title="Sound"
        description="Override sound settings for this project."
      >
        <div className="space-y-4">
          <OverrideRow
            label="Play sound"
            description="Enable audio alerts for agent notifications"
            isOverridden={overrides.soundEnabled !== undefined}
            onToggleOverride={(on) => {
              if (on) setOverride("soundEnabled", globalSettings.soundEnabled);
              else {
                clearOverrides(
                  "soundEnabled",
                  "completedSoundFile",
                  "waitingSoundFile",
                  "escalationSoundFile"
                );
              }
            }}
          >
            <SettingsSwitchCard
              variant="compact"
              title="Play sound"
              subtitle="Enable audio alerts for agent notifications"
              isEnabled={effective("soundEnabled") as boolean}
              onChange={() => setOverride("soundEnabled", !(effective("soundEnabled") as boolean))}
              ariaLabel="Play sound for notifications"
            />
          </OverrideRow>

          {(effective("soundEnabled") as boolean) &&
            (
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
              ] as const
            ).map(({ label, field }) => (
              <OverrideRow
                key={field}
                label={label}
                isOverridden={overrides[field] !== undefined}
                onToggleOverride={(on) => {
                  if (on) setOverride(field, globalSettings[field]);
                  else clearOverrides(field);
                }}
              >
                <div className="flex items-center gap-2">
                  <select
                    value={effective(field) as string}
                    onChange={(e) => setOverride(field, e.target.value)}
                    className="flex-1 px-3 py-2 text-sm rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg text-canopy-text focus:border-canopy-accent focus:outline-none transition-colors"
                  >
                    {AVAILABLE_SOUNDS.map(({ file, label: soundLabel }) => (
                      <option key={file} value={file}>
                        {soundLabel}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => handlePreview(effective(field) as string)}
                    title={`Preview ${label.toLowerCase()}`}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg text-canopy-text hover:bg-tint/[0.06] transition-colors"
                  >
                    <Play className="h-3.5 w-3.5" />
                    Preview
                  </button>
                </div>
              </OverrideRow>
            ))}
        </div>
      </SettingsSection>
    </div>
  );
}

function OverrideRow({
  label,
  description,
  isOverridden,
  onToggleOverride,
  children,
}: {
  label: string;
  description?: string;
  isOverridden: boolean;
  onToggleOverride: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={isOverridden}
          onChange={(e) => onToggleOverride(e.target.checked)}
          className="rounded border-canopy-border text-canopy-accent focus:ring-canopy-accent"
        />
        <span className="text-sm font-medium text-canopy-text">{label}</span>
        {!isOverridden && (
          <span className="text-xs text-canopy-text/40">(using global default)</span>
        )}
      </label>
      {description && !isOverridden && (
        <p className="text-xs text-canopy-text/50 ml-6">{description}</p>
      )}
      {isOverridden && <div className="ml-6">{children}</div>}
    </div>
  );
}
