import type { NotificationSettings } from "../../shared/types/ipc/api.js";

const writeListeners = new Set<() => void>();

/**
 * Hears each runtime write of the notification settings, from Settings or a
 * config import or its undo, so a reader that follows them (Decisions'
 * presence, #17240) reads them again. Nothing listens unless one subscribed.
 */
export function onNotificationSettingsWritten(listener: () => void): () => void {
  writeListeners.add(listener);
  return () => {
    writeListeners.delete(listener);
  };
}

/** Called by every runtime writer once its write is done. */
export function notificationSettingsWritten(): void {
  for (const listener of Array.from(writeListeners)) {
    try {
      listener();
    } catch (error) {
      console.error("[Notifications] A settings listener threw:", error);
    }
  }
}

/** Minimal shape of the allowed-sound-file set, so callers needn't import SoundService. */
export interface AllowedSoundFileLookup {
  has(value: string): boolean;
}

/**
 * Narrow an untrusted notification-settings patch to the fields this build
 * accepts, clamping numeric ranges and dropping sound files that don't exist on
 * this machine.
 *
 * Extracted from the `notification:settings-set` handler so the config-bundle
 * importer (#11889) applies imported settings through exactly the same
 * validation as the settings UI. Duplicating the rules here would drift, and a
 * silently-dropped field is invisible to the caller — the importer relies on
 * comparing this function's output against what it asked for to report a value
 * as skipped rather than applied.
 */
export function sanitizeNotificationSettingsPatch(
  raw: unknown,
  allowedSoundFiles: AllowedSoundFileLookup
): Partial<NotificationSettings> {
  const allowed: Partial<NotificationSettings> = {};
  if (!raw || typeof raw !== "object") return allowed;

  const s = raw as Record<string, unknown>;

  if (typeof s.enabled === "boolean") allowed.enabled = s.enabled;
  if (typeof s.completedEnabled === "boolean") allowed.completedEnabled = s.completedEnabled;
  if (typeof s.waitingEnabled === "boolean") allowed.waitingEnabled = s.waitingEnabled;
  if (typeof s.soundEnabled === "boolean") allowed.soundEnabled = s.soundEnabled;
  if (typeof s.completedSoundFile === "string" && allowedSoundFiles.has(s.completedSoundFile)) {
    allowed.completedSoundFile = s.completedSoundFile;
  }
  if (typeof s.waitingSoundFile === "string" && allowedSoundFiles.has(s.waitingSoundFile)) {
    allowed.waitingSoundFile = s.waitingSoundFile;
  }
  if (typeof s.escalationSoundFile === "string" && allowedSoundFiles.has(s.escalationSoundFile)) {
    allowed.escalationSoundFile = s.escalationSoundFile;
  }
  if (typeof s.waitingEscalationEnabled === "boolean") {
    allowed.waitingEscalationEnabled = s.waitingEscalationEnabled;
  }
  if (
    typeof s.waitingEscalationDelayMs === "number" &&
    Number.isFinite(s.waitingEscalationDelayMs)
  ) {
    allowed.waitingEscalationDelayMs = Math.max(
      30_000,
      Math.min(3_600_000, s.waitingEscalationDelayMs)
    );
  }
  if (typeof s.workingPulseEnabled === "boolean") {
    allowed.workingPulseEnabled = s.workingPulseEnabled;
  }
  if (
    typeof s.workingPulseSoundFile === "string" &&
    allowedSoundFiles.has(s.workingPulseSoundFile)
  ) {
    allowed.workingPulseSoundFile = s.workingPulseSoundFile;
  }
  if (typeof s.uiFeedbackSoundEnabled === "boolean") {
    allowed.uiFeedbackSoundEnabled = s.uiFeedbackSoundEnabled;
  }
  if (typeof s.soundVolume === "number" && Number.isFinite(s.soundVolume)) {
    allowed.soundVolume = Math.max(0, Math.min(1, s.soundVolume));
  }
  if (typeof s.flashEnabled === "boolean") {
    allowed.flashEnabled = s.flashEnabled;
  }
  if (typeof s.quietHoursEnabled === "boolean") {
    allowed.quietHoursEnabled = s.quietHoursEnabled;
  }
  if (typeof s.quietHoursStartMin === "number" && Number.isFinite(s.quietHoursStartMin)) {
    allowed.quietHoursStartMin = Math.max(0, Math.min(1439, Math.floor(s.quietHoursStartMin)));
  }
  if (typeof s.quietHoursEndMin === "number" && Number.isFinite(s.quietHoursEndMin)) {
    allowed.quietHoursEndMin = Math.max(0, Math.min(1439, Math.floor(s.quietHoursEndMin)));
  }
  if (Array.isArray(s.quietHoursWeekdays)) {
    const days = s.quietHoursWeekdays
      .filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)
      .sort((a, b) => a - b);
    allowed.quietHoursWeekdays = Array.from(new Set(days));
  }
  if (typeof s.groupByContext === "boolean") {
    allowed.groupByContext = s.groupByContext;
  }

  return allowed;
}
