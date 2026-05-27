import { clipboard, nativeImage } from "electron";
import * as path from "node:path";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { defineIpcNamespace, op } from "../define.js";
import { CLIPBOARD_METHOD_CHANNELS } from "./clipboard.preload.js";
import { AppError } from "../../utils/errorTypes.js";

const CLIPBOARD_DIR_NAME = "daintree-clipboard";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Cap the number of surviving clipboard images so a long session can't
// accumulate temp PNGs without bound even when they're all under MAX_AGE_MS.
const MAX_FILE_COUNT = 20;
// Reject oversized clipboard writes before any native API call. Binary
// (Uint8Array) payloads skip the IPC envelope budget check (see
// electron/setup/security.ts), so these handler-level caps are the backstop.
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

function getClipboardDir(): string {
  return path.join(os.tmpdir(), CLIPBOARD_DIR_NAME);
}

function logCleanupRejections(results: PromiseSettledResult<unknown>[]): void {
  for (const result of results) {
    if (result.status === "rejected") {
      const code = (result.reason as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn("[clipboard] Unexpected error during cleanup:", result.reason);
      }
    }
  }
}

export async function cleanupOldClipboardImages(): Promise<void> {
  const dir = getClipboardDir();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn("[clipboard] Failed to read clipboard dir for cleanup:", err);
    return;
  }

  const clipboardFiles = entries.filter(
    (dirent) =>
      dirent.isFile() && dirent.name.startsWith("clipboard-") && dirent.name.endsWith(".png")
  );

  // Pass 1 — stat every clipboard file; tolerate races where a file vanishes.
  const statResults = await Promise.allSettled(
    clipboardFiles.map(async (dirent) => {
      const filePath = path.join(dir, dirent.name);
      const stat = await fs.stat(filePath);
      return { filePath, mtimeMs: stat.mtimeMs };
    })
  );

  const surviving: { filePath: string; mtimeMs: number }[] = [];
  const now = Date.now();
  const ageEvictions: Promise<void>[] = [];

  // Pass 2 — age eviction: delete anything older than the 24h window.
  for (const result of statResults) {
    if (result.status === "rejected") {
      const code = (result.reason as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn("[clipboard] Unexpected error during cleanup:", result.reason);
      }
      continue;
    }
    const { filePath, mtimeMs } = result.value;
    if (now - mtimeMs > MAX_AGE_MS) {
      ageEvictions.push(fs.unlink(filePath));
    } else {
      surviving.push({ filePath, mtimeMs });
    }
  }

  logCleanupRejections(await Promise.allSettled(ageEvictions));

  // Pass 3 — count cap: if too many recent files survive, evict the oldest.
  if (surviving.length > MAX_FILE_COUNT) {
    surviving.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const toEvict = surviving.slice(0, surviving.length - MAX_FILE_COUNT);
    logCleanupRejections(
      await Promise.allSettled(toEvict.map((entry) => fs.unlink(entry.filePath)))
    );
  }
}

async function handleSaveImage(): Promise<{ filePath: string; thumbnailDataUrl: string }> {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    throw new AppError({
      code: "CLIPBOARD_EMPTY",
      message: "No image in clipboard",
      userMessage: "There's no image on the clipboard to save.",
    });
  }

  const pngBuffer = image.toPNG();
  const dir = getClipboardDir();
  await fs.mkdir(dir, { recursive: true });

  const id = crypto.randomBytes(3).toString("hex");
  const filename = `clipboard-${Date.now()}-${id}.png`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, pngBuffer);

  // Fire-and-forget — bound temp-file accumulation after every save without
  // blocking the save's return path. Mirrors the startup cleanup call.
  void cleanupOldClipboardImages().catch((err) => {
    console.warn("[clipboard] Cleanup failed unexpectedly:", err);
  });

  const size = image.getSize();
  const thumbHeight = 40;
  const thumbWidth = Math.max(1, Math.round((size.width / size.height) * thumbHeight));
  const thumbnail = image.resize({ width: thumbWidth, height: thumbHeight });
  const thumbnailDataUrl = `data:image/png;base64,${thumbnail.toPNG().toString("base64")}`;

  return { filePath, thumbnailDataUrl };
}

async function handleThumbnailFromPath(
  filePath: string
): Promise<{ filePath: string; thumbnailDataUrl: string }> {
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) {
    throw new AppError({
      code: "CLIPBOARD_INVALID",
      message: "Unsupported image format or file not found",
      userMessage: "Couldn't read that image — the format isn't supported or the file is missing.",
      context: { filePath },
    });
  }

  const size = image.getSize();
  const thumbHeight = 40;
  const thumbWidth = Math.max(1, Math.round((size.width / size.height) * thumbHeight));
  const thumbnail = image.resize({ width: thumbWidth, height: thumbHeight });
  const thumbnailDataUrl = `data:image/png;base64,${thumbnail.toPNG().toString("base64")}`;

  return { filePath, thumbnailDataUrl };
}

async function handleWriteImage(pngData: Uint8Array): Promise<void> {
  if (pngData.byteLength > MAX_IMAGE_BYTES) {
    throw new AppError({
      code: "PAYLOAD_TOO_LARGE",
      message: `Image payload exceeds ${MAX_IMAGE_BYTES} byte limit`,
      userMessage: "The image is too large to copy to the clipboard.",
    });
  }
  const buffer = Buffer.from(pngData.buffer, pngData.byteOffset, pngData.byteLength);
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) {
    throw new AppError({
      code: "CLIPBOARD_INVALID",
      message: "Invalid image data",
      userMessage: "Couldn't write the image — the data is corrupt or unsupported.",
    });
  }
  clipboard.writeImage(image);
}

async function handleWriteText(text: string): Promise<void> {
  if (typeof text !== "string") {
    throw new AppError({
      code: "VALIDATION",
      message: "Text must be a string",
    });
  }
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new AppError({
      code: "PAYLOAD_TOO_LARGE",
      message: `Text payload exceeds ${MAX_TEXT_BYTES} byte limit`,
      userMessage: "The text is too large to copy to the clipboard.",
    });
  }
  clipboard.writeText(text);
}

// Linux PRIMARY selection — underpins copy-on-select and middle-click paste.
// The 'selection' clipboard type only exists on Linux; short-circuit elsewhere.
async function handleWriteSelection(text: string): Promise<void> {
  if (process.platform !== "linux") {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "PRIMARY selection is only available on Linux",
    });
  }
  if (typeof text !== "string") {
    throw new AppError({
      code: "VALIDATION",
      message: "Text must be a string",
    });
  }
  if (text.length === 0) {
    throw new AppError({
      code: "VALIDATION",
      message: "Text must not be empty",
    });
  }
  clipboard.writeText(text, "selection");
}

async function handleReadSelection(): Promise<{ text: string }> {
  if (process.platform !== "linux") {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "PRIMARY selection is only available on Linux",
    });
  }
  const text = clipboard.readText("selection");
  return { text };
}

export const clipboardNamespace = defineIpcNamespace({
  name: "clipboard",
  ops: {
    saveImage: op(CLIPBOARD_METHOD_CHANNELS.saveImage, handleSaveImage),
    thumbnailFromPath: op(CLIPBOARD_METHOD_CHANNELS.thumbnailFromPath, handleThumbnailFromPath),
    writeImage: op(CLIPBOARD_METHOD_CHANNELS.writeImage, handleWriteImage),
    writeText: op(CLIPBOARD_METHOD_CHANNELS.writeText, handleWriteText),
    writeSelection: op(CLIPBOARD_METHOD_CHANNELS.writeSelection, handleWriteSelection),
    readSelection: op(CLIPBOARD_METHOD_CHANNELS.readSelection, handleReadSelection),
  },
});

export function registerClipboardHandlers(): () => void {
  // Ensure the clipboard directory exists at startup so agents like Gemini
  // can reference it via --include-directories without errors (#4048)
  fs.mkdir(getClipboardDir(), { recursive: true }).catch((err) => {
    console.warn("[clipboard] Failed to create clipboard directory:", err);
  });
  cleanupOldClipboardImages().catch((err) => {
    console.warn("[clipboard] Cleanup failed unexpectedly:", err);
  });

  return clipboardNamespace.register();
}
