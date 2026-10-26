import type { NotificationSettings } from "../../../shared/types/ipc/api.js";
import type { HybridSplit } from "../../ipc/endpoint.js";
import { NOTIFICATION_SETTINGS_FIELD_OWNERSHIP } from "../../storeOwnership.js";
import { mergeByOwnership, splitByOwnership } from "./fieldOwnership.js";

/**
 * notificationSettings in a remote-bound window: the policy fields from the
 * host, the delivery fields (sounds, the flash, the bell's grouping) from this
 * screen, as the settings catalog declares them.
 */
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
