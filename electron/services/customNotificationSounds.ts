import path from "path";
import { randomUUID } from "crypto";
import { lstatSync, promises as fsp } from "fs";
import { app } from "electron";
import { store } from "../store.js";
import { resilientAtomicWriteFile } from "../utils/fs.js";
import {
  customSoundFileName,
  customSoundId,
  isCustomSoundId,
  type CustomNotificationSound,
  type CustomNotificationSoundEntry,
} from "../../shared/types/ipc/notificationSounds.js";
import { isNotificationWav, sanitizeSoundLabel } from "../../shared/utils/notificationSoundWav.js";

const FALLBACK_LABEL = "Custom sound";

export function getCustomSoundsDir(): string {
  return path.join(app.getPath("userData"), "sounds", "custom");
}

function readCatalog(): CustomNotificationSound[] {
  const raw: unknown = store.get("customNotificationSounds");
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CustomNotificationSound[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, label } = entry as Record<string, unknown>;
    if (!isCustomSoundId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: sanitizeSoundLabel(label) || FALLBACK_LABEL });
  }
  return out;
}

/**
 * The stored WAV for an import this device registered, or null for any other
 * value or a file that has gone. The path is built from the id's uuid alone, so
 * no caller-supplied text reaches the filesystem, and a symlink is refused.
 */
export function resolveCustomSoundPath(id: string): string | null {
  if (!isCustomSoundId(id) || !readCatalog().some((entry) => entry.id === id)) return null;
  return storedFile(id);
}

/** The file for an id already known to be registered, or null if it isn't there. */
function storedFile(id: string): string | null {
  const fileName = customSoundFileName(id);
  if (!fileName) return null;
  const filePath = path.join(getCustomSoundsDir(), fileName);
  try {
    return lstatSync(filePath).isFile() ? filePath : null;
  } catch {
    return null;
  }
}

/** A registered import whose file is still there: what a picker may newly select. */
export function isPlayableCustomSound(id: string): boolean {
  return resolveCustomSoundPath(id) !== null;
}

export function listCustomSounds(): CustomNotificationSoundEntry[] {
  return readCatalog().map((entry) => ({ ...entry, available: storedFile(entry.id) !== null }));
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

/**
 * Store a sound the window already decoded and encoded. The window is not
 * trusted to have done that: anything but the canonical WAV is refused, so
 * every stored import plays through the same players as the bundled sounds.
 */
export async function importCustomSound(payload: unknown): Promise<CustomNotificationSound> {
  if (!payload || typeof payload !== "object") throw new Error("Invalid sound import");
  const { label: rawLabel, wav } = payload as Record<string, unknown>;
  const bytes = toBytes(wav);
  if (!bytes || !isNotificationWav(bytes)) {
    throw new Error("The sound isn't a 16-bit mono 44.1 kHz WAV of 3 seconds or less");
  }
  const label = sanitizeSoundLabel(rawLabel) || FALLBACK_LABEL;
  const id = customSoundId(randomUUID());
  const dir = getCustomSoundsDir();
  const filePath = path.join(dir, customSoundFileName(id)!);
  await fsp.mkdir(dir, { recursive: true });
  try {
    // The write can fail after its rename (the directory sync), so its file is
    // cleaned up too: an unlisted WAV would never be offered or played anyway.
    await resilientAtomicWriteFile(filePath, bytes);
    // Read and write with no await between, so two windows importing at once both land.
    store.set("customNotificationSounds", [...readCatalog(), { id, label }]);
  } catch (error) {
    await fsp.unlink(filePath).catch(() => {});
    throw error;
  }
  return { id, label };
}
