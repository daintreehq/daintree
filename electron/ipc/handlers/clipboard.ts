import { clipboard, ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import * as os from "node:os";

const CLIPBOARD_DIR_NAME = "canopy-clipboard";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function getClipboardDir(): string {
  return path.join(os.tmpdir(), CLIPBOARD_DIR_NAME);
}

async function cleanupOldClipboardImages(): Promise<void> {
  const dir = getClipboardDir();
  let entries: fs.Dirent[];
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

export function registerClipboardHandlers(): () => void {
  cleanupOldClipboardImages().catch((err) => {
    console.warn("[clipboard] Cleanup failed unexpectedly:", err);
  });
  const handleSaveImage = async (
    _event: Electron.IpcMainInvokeEvent
  ): Promise<
    { ok: true; filePath: string; thumbnailDataUrl: string } | { ok: false; error: string }
  > => {
    try {
      const image = clipboard.readImage();
      if (image.isEmpty()) {
        return { ok: false, error: "No image in clipboard" };
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

      return { ok: true, filePath, thumbnailDataUrl };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  };

  ipcMain.handle(CHANNELS.CLIPBOARD_SAVE_IMAGE, handleSaveImage);

  return () => {
    ipcMain.removeHandler(CHANNELS.CLIPBOARD_SAVE_IMAGE);
  };
}
