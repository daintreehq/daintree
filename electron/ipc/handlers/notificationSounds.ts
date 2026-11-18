import { defineIpcNamespace, op } from "../define.js";
import { checkRateLimit } from "../utils.js";
import { NOTIFICATION_SOUNDS_METHOD_CHANNELS } from "./notificationSounds.preload.js";
import type {
  CustomNotificationSound,
  CustomNotificationSoundEntry,
  ImportNotificationSoundPayload,
} from "../../../shared/types/ipc/notificationSounds.js";

// Each import writes a file of up to ~265 KB, so a runaway caller can't fill the disk.
const IMPORT_MAX_CALLS = 10;
const IMPORT_WINDOW_MS = 60_000;

async function handleList(): Promise<CustomNotificationSoundEntry[]> {
  const { listCustomSounds } = await import("../../services/customNotificationSounds.js");
  return listCustomSounds();
}

async function handleImportSound(
  payload: ImportNotificationSoundPayload
): Promise<CustomNotificationSound> {
  checkRateLimit(
    NOTIFICATION_SOUNDS_METHOD_CHANNELS.importSound,
    IMPORT_MAX_CALLS,
    IMPORT_WINDOW_MS
  );
  const { importCustomSound } = await import("../../services/customNotificationSounds.js");
  return importCustomSound(payload);
}

async function handleGetCustomDir(): Promise<string> {
  const { getCustomSoundsDir } = await import("../../services/customNotificationSounds.js");
  return getCustomSoundsDir();
}

export const notificationSoundsNamespace = defineIpcNamespace({
  name: "notificationSounds",
  ops: {
    list: op(NOTIFICATION_SOUNDS_METHOD_CHANNELS.list, handleList),
    importSound: op(NOTIFICATION_SOUNDS_METHOD_CHANNELS.importSound, handleImportSound),
    getCustomDir: op(NOTIFICATION_SOUNDS_METHOD_CHANNELS.getCustomDir, handleGetCustomDir),
  },
});

export function registerNotificationSoundsHandlers(): () => void {
  return notificationSoundsNamespace.register();
}
