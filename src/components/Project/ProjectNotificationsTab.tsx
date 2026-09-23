import { useState, useEffect, useCallback } from "react";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SettingsDependents,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { SettingsSelect } from "@/components/Settings/SettingsSelect";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import type { NotificationSettings } from "@shared/types/ipc/api";
import { logError } from "@/utils/logger";

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

const SOUND_FIELDS = [
  { label: "Completed sound", field: "completedSoundFile" },
  { label: "Waiting sound", field: "waitingSoundFile" },
  { label: "Escalation sound", field: "escalationSoundFile" },
] as const;

interface ProjectNotificationsTabProps {
  overrides: Partial<NotificationSettings>;
  onChange: (overrides: Partial<NotificationSettings>) => void;
}

export function ProjectNotificationsTab({ overrides, onChange }: ProjectNotificationsTabProps) {
  const [globalSettings, setGlobalSettings] = useState<NotificationSettings | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);

  useEffect(() => {
    if (!window.electron?.notification) return;

    let mounted = true;
    window.electron.notification
      .getSettings()
      .then((settings) => {
        if (mounted) setGlobalSettings(settings);
      })
      .catch((err) => {
        logError("[ProjectNotificationsTab] Failed to load global settings", err);
        if (mounted) setGlobalError("Failed to load global settings");
      });

    return () => {
      mounted = false;
    };
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

  const retryGlobals = () => {
    setGlobalError(null);
    window.electron.notification
      .getSettings()
      .then(setGlobalSettings)
      .catch((err) => {
        logError("[ProjectNotificationsTab] Retry failed", err);
        setGlobalError("Failed to load global settings");
      });
  };

  if (!window.electron?.notification) {
    return <div className="text-sm text-text-secondary">Notification API not available</div>;
  }

  // The structure renders straight away; until the globals resolve, a row with no
  // project override has no value to show, so it stays disabled rather than guessing.
  const loaded = globalSettings !== null;

  const effective = <K extends keyof NotificationSettings>(key: K) =>
    overrides[key] !== undefined ? overrides[key] : globalSettings?.[key];

  const isOverridden = (key: keyof NotificationSettings) => overrides[key] !== undefined;

  const describe = (
    key: keyof NotificationSettings,
    base: string | undefined,
    format: (value: unknown) => string
  ) => {
    let origin: string;
    if (isOverridden(key)) {
      origin = globalSettings
        ? `Set for this project · global default is ${format(globalSettings[key])}`
        : "Set for this project";
    } else {
      origin = globalSettings
        ? `Using global default · ${format(globalSettings[key])}`
        : "Loading global default…";
    }
    return base ? `${base}. ${origin}` : origin;
  };

  const onOff = (value: unknown) => (value ? "On" : "Off");
  const soundName = (value: unknown) =>
    AVAILABLE_SOUNDS.find((s) => s.file === value)?.label ?? String(value);
  const delayName = (value: unknown) =>
    ESCALATION_DELAY_OPTIONS.find((o) => o.value === value)?.label ?? String(value);

  const booleanRow = (
    key: "completedEnabled" | "waitingEnabled" | "waitingEscalationEnabled" | "soundEnabled",
    title: string,
    subtitle: string,
    resetKeys: (keyof NotificationSettings)[],
    ariaLabel?: string
  ) => {
    const value = effective(key) === true;
    return (
      <SettingsSwitchCard
        title={title}
        subtitle={describe(key, subtitle, onOff)}
        isEnabled={value}
        onChange={() => setOverride(key, !value)}
        ariaLabel={ariaLabel}
        disabled={!loaded && !isOverridden(key)}
        isModified={isOverridden(key)}
        onReset={() => clearOverrides(key, ...resetKeys)}
        resetAriaLabel={`Reset ${title.toLowerCase()} to global default`}
      />
    );
  };

  const waitingOn = effective("waitingEnabled") === true;
  const escalationOn = effective("waitingEscalationEnabled") === true;
  const soundOn = effective("soundEnabled") === true;

  return (
    <div className="space-y-8">
      {globalError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-border-default px-4 py-3 text-xs text-status-error"
        >
          <span>{globalError}</span>
          <Button variant="outline" size="xs" onClick={retryGlobals}>
            Retry
          </Button>
        </div>
      )}

      <SettingsSection
        title="Agent notifications"
        description="Changing a setting overrides the global value for this project; reset it to inherit again."
      >
        <SettingsGroup>
          {booleanRow(
            "completedEnabled",
            "Agent completed",
            "Show a notification when an agent finishes its task",
            []
          )}
          {booleanRow(
            "waitingEnabled",
            "Agent waiting for input",
            "Show a notification immediately when an agent needs input",
            ["waitingEscalationEnabled", "waitingEscalationDelayMs"]
          )}
          <SettingsDependents
            disabled={!waitingOn}
            reason="Turn on Agent waiting for input to escalate reminders"
          >
            {booleanRow(
              "waitingEscalationEnabled",
              "Escalate if still waiting",
              "Fire an additional OS notification if a docked agent remains waiting",
              ["waitingEscalationDelayMs"]
            )}
            {escalationOn && (
              <SettingsSelect
                label="Escalation delay"
                description={describe("waitingEscalationDelayMs", undefined, delayName)}
                value={String(effective("waitingEscalationDelayMs") ?? "")}
                onValueChange={(v) => setOverride("waitingEscalationDelayMs", Number(v))}
                disabled={!loaded && !isOverridden("waitingEscalationDelayMs")}
                isModified={isOverridden("waitingEscalationDelayMs")}
                onReset={() => clearOverrides("waitingEscalationDelayMs")}
                resetAriaLabel="Reset escalation delay to global default"
                options={ESCALATION_DELAY_OPTIONS.map(({ value, label }) => ({
                  value: String(value),
                  label,
                }))}
              />
            )}
          </SettingsDependents>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Sound">
        <SettingsGroup>
          {booleanRow(
            "soundEnabled",
            "Play sound",
            "Enable audio alerts for agent notifications",
            ["completedSoundFile", "waitingSoundFile", "escalationSoundFile"],
            "Play sound for notifications"
          )}
          <SettingsDependents disabled={!soundOn} reason="Turn on Play sound to choose sounds">
            {SOUND_FIELDS.map(({ label, field }) => {
              const value = effective(field);
              return (
                <SettingsRow
                  key={field}
                  label={label}
                  description={describe(field, undefined, soundName)}
                  isModified={isOverridden(field)}
                  onReset={() => clearOverrides(field)}
                  resetAriaLabel={`Reset ${label.toLowerCase()} to global default`}
                  disabled={!loaded && !isOverridden(field)}
                  control={({ labelId, descriptionId, disabled }) => (
                    <div className="flex items-center gap-2">
                      <Select
                        value={typeof value === "string" ? value : ""}
                        onValueChange={(v) => setOverride(field, v)}
                        disabled={disabled}
                      >
                        <SelectTrigger
                          aria-labelledby={labelId}
                          aria-describedby={descriptionId}
                          className="w-36"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {AVAILABLE_SOUNDS.map(({ file, label: soundLabel }) => (
                            <SelectItem key={file} value={file}>
                              {soundLabel}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={disabled || typeof value !== "string"}
                        onClick={() => {
                          if (typeof value === "string") handlePreview(value);
                        }}
                        aria-label={`Preview ${label.toLowerCase()}`}
                      >
                        <Play aria-hidden="true" />
                        Preview
                      </Button>
                    </div>
                  )}
                />
              );
            })}
          </SettingsDependents>
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
