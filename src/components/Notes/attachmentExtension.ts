import { Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

export const NOTES_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export interface AttachItem {
  file: File;
  mimeType: string;
  originalName: string;
}

function collectFromFiles(files: FileList | null): AttachItem[] {
  const result: AttachItem[] = [];
  if (!files) return result;
  for (const file of Array.from(files)) {
    result.push({
      file,
      mimeType: file.type || "application/octet-stream",
      originalName: file.name || "file",
    });
  }
  return result;
}

function collectFromDataTransferItems(items: DataTransferItemList | null): AttachItem[] {
  const result: AttachItem[] = [];
  if (!items) return result;
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    result.push({
      file,
      mimeType: file.type || item.type || "application/octet-stream",
      originalName: file.name || "file",
    });
  }
  return result;
}

function partitionBySize(items: AttachItem[]): {
  accepted: AttachItem[];
  rejected: AttachItem[];
} {
  const accepted: AttachItem[] = [];
  const rejected: AttachItem[] = [];
  for (const item of items) {
    if (item.file.size > NOTES_MAX_ATTACHMENT_BYTES || item.file.size === 0) {
      rejected.push(item);
    } else {
      accepted.push(item);
    }
  }
  return { accepted, rejected };
}

export interface AttachmentExtensionHandlers {
  onAttach: (items: AttachItem[]) => void;
  onRejected?: (items: AttachItem[], reason: "oversize" | "empty") => void;
}

export function buildAttachmentExtension({
  onAttach,
  onRejected,
}: AttachmentExtensionHandlers): Extension {
  return Prec.highest(
    EditorView.domEventHandlers({
      dragover(event) {
        const types = event.dataTransfer?.types;
        if (types && (types.includes("Files") || Array.from(types).includes("Files"))) {
          return true;
        }
        return false;
      },
      drop(event) {
        const files = collectFromFiles(event.dataTransfer?.files ?? null);
        if (files.length === 0) return false;
        const { accepted, rejected } = partitionBySize(files);
        if (rejected.length > 0) {
          const allEmpty = rejected.every((item) => item.file.size === 0);
          onRejected?.(rejected, allEmpty ? "empty" : "oversize");
        }
        if (accepted.length > 0) {
          onAttach(accepted);
        }
        return true;
      },
      paste(event) {
        const items = collectFromDataTransferItems(event.clipboardData?.items ?? null);
        if (items.length === 0) return false;
        const { accepted, rejected } = partitionBySize(items);
        if (rejected.length > 0) {
          const allEmpty = rejected.every((item) => item.file.size === 0);
          onRejected?.(rejected, allEmpty ? "empty" : "oversize");
        }
        if (accepted.length > 0) {
          onAttach(accepted);
        }
        return true;
      },
    })
  );
}

export function isImageMime(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("image/");
}

function sanitizeAltText(value: string): string {
  return value.replace(/[\r\n[\]]/g, " ").trim();
}

export function buildMarkdownSnippet(
  item: { mimeType: string; originalName: string },
  relativePath: string
): string {
  const safePath = relativePath.replace(/\s/g, "%20");
  if (isImageMime(item.mimeType)) {
    const alt = sanitizeAltText(item.originalName.replace(/\.[^.]+$/, "")) || "image";
    return `![${alt}](${safePath})`;
  }
  const label = sanitizeAltText(item.originalName) || "attachment";
  return `[${label}](${safePath})`;
}
