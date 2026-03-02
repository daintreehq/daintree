import { clipboard, ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";

async function ensureGitignoreEntry(projectPath: string, entry: string): Promise<void> {
  const gitignorePath = path.join(projectPath, ".gitignore");
  try {
    const content = await fs.readFile(gitignorePath, "utf-8");
    if (content.split("\n").some((line) => line.trim() === entry)) return;
    const separator = content.endsWith("\n") ? "" : "\n";
    await fs.writeFile(gitignorePath, `${content}${separator}${entry}\n`, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.writeFile(gitignorePath, `${entry}\n`, "utf-8");
    } else {
      throw err;
    }
  }
}

export function registerClipboardHandlers(): () => void {
  const handleSaveImage = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { projectPath: string }
  ): Promise<
    { ok: true; filePath: string; thumbnailDataUrl: string } | { ok: false; error: string }
  > => {
    try {
      if (!payload?.projectPath || !path.isAbsolute(payload.projectPath)) {
        return { ok: false, error: "Invalid project path" };
      }

      const image = clipboard.readImage();
      if (image.isEmpty()) {
        return { ok: false, error: "No image in clipboard" };
      }

      const pngBuffer = image.toPNG();
      const dir = path.join(payload.projectPath, ".canopy", "clipboard");
      await fs.mkdir(dir, { recursive: true });

      const id = crypto.randomBytes(3).toString("hex");
      const filename = `clipboard-${Date.now()}-${id}.png`;
      const filePath = path.join(dir, filename);
      await fs.writeFile(filePath, pngBuffer);

      await ensureGitignoreEntry(payload.projectPath, ".canopy/clipboard/");

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
