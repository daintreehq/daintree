import { WebContents, clipboard } from "electron";
import fs from "fs/promises";
import path from "path";
import os from "os";

const MAX_SAFE_SIZE = 50 * 1024 * 1024; // 50 MB

export class ClipboardFileInjector {
  /**
   * Synchronously check if clipboard contains file data.
   * This is a fast check to decide whether to intercept paste.
   */
  static hasFileDataInClipboard(): boolean {
    const formats = clipboard.availableFormats();
    const platform = process.platform;

    if (platform === "darwin") {
      return formats.includes("public.file-url");
    } else if (platform === "win32") {
      return formats.includes("FileNameW") || formats.includes("FileName");
    } else if (platform === "linux") {
      // On Linux, file URIs are often in text/uri-list format
      return formats.includes("text/uri-list");
    }

    return false;
  }

  static async getFilePathsFromClipboard(): Promise<string[]> {
    const platform = process.platform;

    try {
      if (platform === "darwin") {
        const fileUrl = clipboard.read("public.file-url");
        if (fileUrl) {
          const filePath = decodeURI(fileUrl.replace("file://", ""));
          return await this.validateFilePaths([filePath]);
        }
      } else if (platform === "win32") {
        const rawBuffer = clipboard.readBuffer("FileNameW");
        if (rawBuffer.length > 0) {
          const decoded = rawBuffer.toString("ucs2");
          const paths: string[] = [];
          let current = "";

          for (let i = 0; i < decoded.length; i++) {
            const char = decoded[i];
            if (char === "\0") {
              if (current.trim()) {
                paths.push(current.trim());
                current = "";
              }
            } else {
              current += char;
            }
          }

          if (current.trim()) {
            paths.push(current.trim());
          }

          return await this.validateFilePaths(paths);
        }
      } else if (platform === "linux") {
        const uriList = clipboard.readText();
        if (uriList) {
          const paths = uriList
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("file://"))
            .map((line) => decodeURI(line.replace("file://", "")));

          return await this.validateFilePaths(paths);
        }
      }
    } catch (e) {
      console.error("[ClipboardFileInjector] Error reading clipboard:", e);
    }

    return [];
  }

  private static async validateFilePaths(paths: string[]): Promise<string[]> {
    const validated: string[] = [];
    const homeDir = os.homedir();

    for (const filePath of paths) {
      try {
        if (!path.isAbsolute(filePath)) {
          console.warn(`[ClipboardFileInjector] Rejecting relative path: ${filePath}`);
          continue;
        }

        const normalized = path.normalize(filePath);
        const realPath = await fs.realpath(normalized);

        if (!realPath.startsWith(homeDir) && !realPath.startsWith("/tmp")) {
          console.warn(`[ClipboardFileInjector] Rejecting path outside user home: ${realPath}`);
          continue;
        }

        const stats = await fs.stat(realPath);
        if (!stats.isFile()) {
          console.warn(`[ClipboardFileInjector] Rejecting non-file path: ${realPath}`);
          continue;
        }

        if (stats.size > MAX_SAFE_SIZE) {
          console.warn(
            `[ClipboardFileInjector] File too large: ${realPath} (${(stats.size / 1024 / 1024).toFixed(1)} MB, limit ${MAX_SAFE_SIZE / 1024 / 1024} MB)`
          );
          continue;
        }

        validated.push(realPath);
      } catch (e) {
        console.warn(`[ClipboardFileInjector] Failed to validate path ${filePath}:`, e);
      }
    }

    return validated;
  }

  static async readFileAsBase64(filePath: string): Promise<{
    base64: string;
    mimeType: string;
    fileName: string;
    size: number;
  }> {
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        throw new Error(`Path is not a regular file: ${filePath}`);
      }

      if (stats.size > MAX_SAFE_SIZE) {
        throw new Error(
          `File size (${(stats.size / 1024 / 1024).toFixed(1)} MB) exceeds maximum (${MAX_SAFE_SIZE / 1024 / 1024} MB): ${filePath}`
        );
      }

      const fileBuffer = await fs.readFile(filePath);
      const base64Data = fileBuffer.toString("base64");

      const fileName = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = this.getMimeType(ext);

      return {
        base64: base64Data,
        mimeType,
        fileName,
        size: fileBuffer.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read file ${filePath}: ${message}`);
    }
  }

  private static getMimeType(ext: string): string {
    const mimeTypes: Record<string, string> = {
      ".txt": "text/plain",
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
      ".ts": "application/typescript",
      ".jsx": "application/javascript",
      ".tsx": "application/typescript",
      ".json": "application/json",
      ".ndjson": "application/x-ndjson",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".zip": "application/zip",
      ".md": "text/markdown",
      ".xml": "application/xml",
      ".yaml": "text/yaml",
      ".yml": "text/yaml",
      ".csv": "text/csv",
      ".py": "text/x-python",
      ".rb": "text/x-ruby",
      ".go": "text/x-go",
      ".rs": "text/x-rust",
      ".c": "text/x-c",
      ".cpp": "text/x-c++",
      ".h": "text/x-c",
      ".hpp": "text/x-c++",
      ".java": "text/x-java",
      ".kt": "text/x-kotlin",
      ".swift": "text/x-swift",
      ".sh": "application/x-sh",
      ".bash": "application/x-sh",
      ".zsh": "application/x-sh",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xls": "application/vnd.ms-excel",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".ppt": "application/vnd.ms-powerpoint",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };
    return mimeTypes[ext] || "application/octet-stream";
  }

  static async injectFileIntoPaste(webContents: WebContents, filePath: string): Promise<void> {
    try {
      const { base64, mimeType, fileName, size } = await this.readFileAsBase64(filePath);

      const script = this.generateInjectionScript(base64, fileName, mimeType);
      await webContents.executeJavaScript(script);
      console.log(
        `[ClipboardFileInjector] Injected file: ${fileName} (${(size / 1024).toFixed(1)} KB)`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[ClipboardFileInjector] Failed to inject file paste for ${filePath}:`,
        message
      );
      throw error;
    }
  }

  private static generateInjectionScript(
    base64Data: string,
    fileName: string,
    mimeType: string
  ): string {
    const safeBase64 = JSON.stringify(base64Data);
    const safeFileName = JSON.stringify(fileName);
    const safeMimeType = JSON.stringify(mimeType);

    return `
(async () => {
  const base64ToBlob = (base64, contentType = '', sliceSize = 512) => {
    const byteCharacters = atob(base64);
    const byteArrays = [];
    for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
      const slice = byteCharacters.slice(offset, offset + sliceSize);
      const byteNumbers = new Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i);
      }
      byteArrays.push(new Uint8Array(byteNumbers));
    }
    return new Blob(byteArrays, { type: contentType });
  };

  const base64Data = ${safeBase64};
  const fileName = ${safeFileName};
  const mimeType = ${safeMimeType};

  const targetElement = document.activeElement;

  if (!targetElement) {
    console.error('[Paste Injection] No active element to receive paste');
    return;
  }

  const blob = base64ToBlob(base64Data, mimeType);
  const file = new File([blob], fileName, {
    type: mimeType,
    lastModified: Date.now()
  });

  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);

  const pasteEvent = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dataTransfer
  });

  targetElement.dispatchEvent(pasteEvent);
  console.log('[Paste Injection] Dispatched paste event with file:', fileName);
})();
    `.trim();
  }
}
