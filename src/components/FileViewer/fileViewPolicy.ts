import { ExternalLink, Globe, type LucideIcon } from "lucide-react";
import type { FileViewMode } from "@shared/types/panel";
import { isHtmlFilePath } from "@/components/Html/isHtmlFile";
import { isMarkdownFilePath } from "@/components/Markdown/isMarkdownFile";
import {
  isAudioFilePath,
  isImageFilePath,
  isPdfFilePath,
  isSvgFilePath,
  isUnsupportedAudioFilePath,
  isUnsupportedVideoFilePath,
  isVideoFilePath,
} from "./filePreviewKinds";

// Shared by the file panel and the file browser's viewer so the same file
// offers the same way out, and opens in the same mode, on either surface.

export type FileOpenTarget = "editor" | "default-app" | "browser";

/**
 * Which external surface a file's open action aims at, by type rather than by
 * view mode. Text belongs in the editor; media, PDFs and raster images open
 * with whatever the OS uses for that type; an HTML page opens in the browser.
 * Never the OS default for an unknown or binary file — that handler may
 * execute it.
 */
export function fileOpenTarget(filePath: string): FileOpenTarget {
  if (isHtmlFilePath(filePath)) return "browser";
  if (isImageFilePath(filePath) && !isSvgFilePath(filePath)) return "default-app";
  if (
    isVideoFilePath(filePath) ||
    isAudioFilePath(filePath) ||
    isPdfFilePath(filePath) ||
    isUnsupportedVideoFilePath(filePath) ||
    isUnsupportedAudioFilePath(filePath)
  ) {
    return "default-app";
  }
  return "editor";
}

export const FILE_OPEN_ACTION_COPY: Record<FileOpenTarget, { label: string; icon: LucideIcon }> = {
  editor: { label: "Open in editor", icon: ExternalLink },
  "default-app": { label: "Open in default app", icon: ExternalLink },
  browser: { label: "Open in browser", icon: Globe },
};

/**
 * The mode a file opens in when nothing has been chosen for it yet: markdown is
 * a document you read rendered, while HTML in a repo is code you opened to
 * read, and a page that renders near-blank otherwise looks like a broken file
 * (#12205).
 */
export function defaultFileViewMode(filePath: string): FileViewMode {
  return isMarkdownFilePath(filePath) ? "rendered" : "source";
}
