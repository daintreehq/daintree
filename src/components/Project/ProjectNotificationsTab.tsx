import { useState, useEffect, useCallback } from "react";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsDependents, SettingsGroup } from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { SettingsPresetGroup } from "@/components/Settings/SettingsPresetGroup";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import {
  ESCALATION_DELAY_OPTIONS,
  NOTIFICATION_COPY,
  SoundPickerRow,
  escalationDelayLabel,
  previewNotificationSound,
  soundLabel,
  type SoundFileKey,
} from "@/components/Settings/notificationSettingsShared";
import type { NotificationSettings } from "@shared/types/ipc/api";
import { logError } from "@/utils/logger";

interface ProjectNotificationsTabProps {
  overrides: Partial<NotificationSettings>;
  onChange: (overrides: Partial<NotificationSettings>) => void;
}

type BooleanKey =
  | "completedEnabled"
  | "waitingEnabled"
  | "waitingEscalationEnabled"
  | "soundEnabled"
  | "workingPulseEnabled";

export function ProjectNotificationsTab({ overrides, onChange }: ProjectNotificationsTabProps) {
  const [globalSettings, setGlobalSettings] = useState<NotificationSettings | null>(null);
  const [globalLoadFailed, setGlobalLoadFailed] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);

  useEffect(() => {
    if (!window.electron?.notification) return;

    let mounted = true;
    setGlobalLoadFailed(false);
    window.electron.notification
      .getSettings()
      .then((settings) => {
        if (mounted) setGlobalSettings(settings);
      })
      .catch((err) => {
        logError("[ProjectNotificationsTab] Failed to load global settings", err);
        if (mounted) setGlobalLoadFailed(true);
      });

    return () => {
      mounted = false;
    };
  }, [loadNonce]);

  const setOverride = useCallback(
    <K extends keyof NotificationSettings>(key: K, value: NotificationSettings[K]) => {
      onChange({ ...overrides, [key]: value });
    },
    [overrides, onChange]
  );

  // A reset returns one row to inheriting. It never clears a dependent's override too:
  // an escalation delay chosen for this project is a separate decision from whether
  // waiting notifications are on, and it survives the parent being reset.
  const clearOverride = useCallback(
    (key: keyof NotificationSettings) => {
      const next = { ...overrides };
      delete next[key];
      onChange(next);
    },
    [overrides, onChange]
  );

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
    // Non-breaking around the value so a wrap never strands "Off" alone on a line.
    let origin: string;
    if (isOverridden(key)) {
      origin = globalSettings
        ? `Set for this project · global default\u00a0is\u00a0${format(globalSettings[key])}`
        : "Set for this project";
    } else if (globalSettings) {
      origin = `Using global\u00a0default\u00a0·\u00a0${format(globalSettings[key])}`;
    } else {
      origin = globalLoadFailed ? "Global default unavailable" : "Loading global default…";
    }
    return base ? `${base}. ${origin}` : origin;
  };

  const onOff = (value: unknown) => (value ? "On" : "Off");

  // Every project value only applies while notifications are on globally: the project
  // can override each event, but never the master switch. Rows stay at their own depth
  // and each group says why once, on its first row.
  const globalMasterOff = globalSettings?.enabled === false;
  const MASTER_OFF_REASON =
    "Notifications are turned off in global settings, so nothing here takes effect";

  const unknownValue = (key: keyof NotificationSettings) => !loaded && !isOverridden(key);

  const booleanRow = (
    key: BooleanKey,
    copy: { label: string; description: string },
    masterReason?: string
  ) => {
    const value = effective(key) === true;
    return (
      <SettingsSwitchCard
        title={copy.label}
        subtitle={describe(key, copy.description, onOff)}
        isEnabled={value}
        onChange={() => setOverride(key, !value)}
        ariaLabel={key === "soundEnabled" ? "Play sound for notifications" : undefined}
        disabled={unknownValue(key) || globalMasterOff}
        disabledReason={globalMasterOff ? masterReason : undefined}
        isModified={isOverridden(key)}
        onReset={() => clearOverride(key)}
        resetAriaLabel={`Reset ${copy.label.toLowerCase()} to global default`}
      />
    );
  };

  const soundRow = (key: SoundFileKey) => {
    const value = effective(key);
    const label = NOTIFICATION_COPY.soundFiles[key];
    return (
      <SoundPickerRow
        label={label}
        description={describe(key, undefined, soundLabel)}
        value={typeof value === "string" ? value : undefined}
        onChange={(v) => setOverride(key, v)}
        onPreview={previewNotificationSound}
        disabled={unknownValue(key)}
        isModified={isOverridden(key)}
        onReset={() => clearOverride(key)}
        resetAriaLabel={`Reset ${label.toLowerCase()} to global default`}
      />
    );
  };

  const waitingOn = effective("waitingEnabled") === true;
  const escalationOn = effective("waitingEscalationEnabled") === true;
  const soundOn = effective("soundEnabled") === true;
  const pulseOn = effective("workingPulseEnabled") === true;
  const delay = effective("waitingEscalationDelayMs");

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Agent notifications"
        description="A change here overrides the global value for this project; reset a row to inherit it again"
      >
        {globalLoadFailed && (
          <SettingsLoadErrorBanner
            title="Couldn't load the global notification settings"
            message="Rows you haven't set for this project stay unavailable until they load."
            onRetry={() => setLoadNonce((n) => n + 1)}
          />
        )}
        <SettingsGroup>
          {booleanRow("completedEnabled", NOTIFICATION_COPY.completed, MASTER_OFF_REASON)}
          {booleanRow("waitingEnabled", NOTIFICATION_COPY.waiting)}
          <SettingsDependents
            disabled={!waitingOn || globalMasterOff}
            reason={globalMasterOff || waitingOn ? undefined : NOTIFICATION_COPY.waitingOffReason}
          >
            {booleanRow("waitingEscalationEnabled", NOTIFICATION_COPY.escalation)}
            <SettingsPresetGroup<number>
              label={NOTIFICATION_COPY.escalationDelay.label}
              description={describe(
                "waitingEscalationDelayMs",
                NOTIFICATION_COPY.escalationDelay.description,
                escalationDelayLabel
              )}
              options={ESCALATION_DELAY_OPTIONS}
              value={typeof delay === "number" ? delay : null}
              onChange={(v) => setOverride("waitingEscalationDelayMs", v)}
              disabled={!escalationOn || unknownValue("waitingEscalationDelayMs")}
              disabledReason={
                globalMasterOff || !waitingOn || escalationOn
                  ? undefined
                  : NOTIFICATION_COPY.escalationOffReason
              }
              isModified={isOverridden("waitingEscalationDelayMs")}
              onReset={() => clearOverride("waitingEscalationDelayMs")}
            />
          </SettingsDependents>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Sound">
        <SettingsGroup>
          {booleanRow("soundEnabled", NOTIFICATION_COPY.sound, MASTER_OFF_REASON)}
          <SettingsDependents
            disabled={!soundOn || globalMasterOff}
            reason={globalMasterOff || soundOn ? undefined : "Turn on Play sound to choose sounds"}
          >
            {soundRow("completedSoundFile")}
            {soundRow("waitingSoundFile")}
            {soundRow("escalationSoundFile")}
            {booleanRow("workingPulseEnabled", NOTIFICATION_COPY.workingPulse)}
            <SettingsDependents
              disabled={!pulseOn}
              reason={
                globalMasterOff || !soundOn || pulseOn
                  ? undefined
                  : NOTIFICATION_COPY.workingPulseOffReason
              }
            >
              {soundRow("workingPulseSoundFile")}
            </SettingsDependents>
          </SettingsDependents>
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
