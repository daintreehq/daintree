import type { NotificationSettings } from "../../../shared/types/ipc/api.js";
import type { HybridSplit } from "../../ipc/endpoint.js";
import type { SettingOwner } from "../../storeOwnership.js";
import { mergeByOwnership, splitByOwnership } from "./fieldOwnership.js";

/**
 * notificationSettings in a remote-bound window. The host decides when its
 * agents notify, so the policy (what notifies, escalation, quiet hours) is
 * the host's. How a notification reaches this person (sounds, the flash, how
 * the bell groups them) is this screen's.
 */
export const NOTIFICATION_SETTINGS_FIELD_OWNERSHIP = {
  enabled: "host",
  completedEnabled: "host",
  waitingEnabled: "host",
  waitingEscalationEnabled: "host",
  waitingEscalationDelayMs: "host",
  workingPulseEnabled: "host",
  quietHoursEnabled: "host",
  quietHoursStartMin: "host",
  quietHoursEndMin: "host",
  quietHoursWeekdays: "host",
  soundEnabled: "device",
  completedSoundFile: "device",
  waitingSoundFile: "device",
  escalationSoundFile: "device",
  workingPulseSoundFile: "device",
  uiFeedbackSoundEnabled: "device",
  flashEnabled: "device",
  groupByContext: "device",
} as const satisfies Record<keyof NotificationSettings, SettingOwner>;

export const notificationSettingsGet: HybridSplit = async ({ local, remote }) => {
  const [device, host] = await Promise.all([local(), remote()]);
  return mergeByOwnership<NotificationSettings>(
    device,
    host,
    NOTIFICATION_SETTINGS_FIELD_OWNERSHIP
  );
};

/** Each machine sanitises its half with its own handler (sound files are checked where they play). */
export const notificationSettingsSet: HybridSplit = async ({ args, local, remote }) => {
  const { device, host } = splitByOwnership(args[0], NOTIFICATION_SETTINGS_FIELD_OWNERSHIP);
  await Promise.all([
    Object.keys(device).length > 0 ? local([device]) : undefined,
    Object.keys(host).length > 0 ? remote(undefined, [host]) : undefined,
  ]);
};
