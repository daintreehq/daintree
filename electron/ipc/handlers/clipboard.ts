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

function getClipboardDir(): string {
  return path.join(os.tmpdir(), CLIPBOARD_DIR_NAME);
}

async function cleanupOldClipboardImages(): Promise<void> {
  const dir = getClipboardDir();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn("[clipboard] Failed to read clipboard dir for cleanup:", err);
    return;
  }

  const now = Date.now();
  const results = await Promise.allSettled(
    entries
      .filter(
        (dirent) =>
          dirent.isFile() && dirent.name.startsWith("clipboard-") && dirent.name.endsWith(".png")
      )
      .map(async (dirent) => {
        const filePath = path.join(dir, dirent.name);
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          await fs.unlink(filePath);
        }
      })
  );

  for (const result of results) {
    if (result.status === "rejected") {
      const code = (result.reason as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn("[clipboard] Unexpected error during cleanup:", result.reason);
      }
    }
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
