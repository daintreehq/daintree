import { useEffect, useRef } from "react";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { escapeShellArgOptional } from "@shared/utils/shellEscape.js";

/**
 * Image file extension pattern shared with HybridInputBar.
 * Exported so both the input bar and terminal can use the same detection.
 */
export const IMAGE_EXTENSIONS = /\.(png|jpe?g|bmp|tiff?|avif|heic)$/i;

/**
 * Checks whether a ClipboardEvent contains an image MIME type item.
 */
function hasImageClipboardItem(event: ClipboardEvent): boolean {
  const items = event.clipboardData?.items;
  if (!items) return false;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith("image/")) return true;
  }
  return false;
}

interface UseTerminalFileTransferOptions {
  terminalId: string;
  isInputLocked?: boolean;
  onInput?: (data: string) => void;
}

/**
 * Attaches paste and drag-and-drop handlers to the xterm container element.
 *
 * - **Image paste:** Intercepts in capture phase before xterm processes the event.
 *   Calls `clipboard.saveImage()` and writes the resulting file path into the terminal.
 * - **Text paste:** Passes through to xterm's native handler (bracketed paste, etc.).
 * - **File drop:** Resolves file paths via `webUtils.getPathForFile()` and writes them
 *   into the terminal as text. Works for both image and non-image files.
 *
 * Paths are shell-escaped so filenames with spaces or metacharacters are safe.
 */
export function useTerminalFileTransfer(
  containerRef: React.RefObject<HTMLDivElement | null>,
  { terminalId, isInputLocked, onInput }: UseTerminalFileTransferOptions
) {
  const dragDepthRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handlePaste = async (event: ClipboardEvent) => {
      if (isInputLocked) return;
      if (!hasImageClipboardItem(event)) return;

      // Prevent xterm from processing the image paste as text
      event.preventDefault();
      event.stopPropagation();

      try {
        const result = await window.electron.clipboard.saveImage();
        if (!result.ok) return;

        const escaped = escapeShellArgOptional(result.filePath);
        terminalClient.write(terminalId, escaped);
        terminalInstanceService.notifyUserInput(terminalId);
        onInput?.(escaped);
      } catch {
        // IPC may fail if window is closing
      }
    };

    const handleDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current++;
    };

    const handleDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    };

    const handleDragLeave = (e: DragEvent) => {
      e.stopPropagation();
      dragDepthRef.current--;
      if (dragDepthRef.current <= 0) {
        dragDepthRef.current = 0;
      }
    };

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = 0;

      if (isInputLocked) return;
      if (!e.dataTransfer?.files.length) return;

      const escapedPaths: string[] = [];
      for (const file of Array.from(e.dataTransfer.files)) {
        const filePath = window.electron.webUtils.getPathForFile(file);
        if (filePath) escapedPaths.push(escapeShellArgOptional(filePath));
      }

      if (escapedPaths.length === 0) return;

      const text = escapedPaths.join(" ");
      terminalClient.write(terminalId, text);
      terminalInstanceService.notifyUserInput(terminalId);
      onInput?.(text);
    };

    // Use capture phase for paste so we intercept before xterm's own handler
    container.addEventListener("paste", handlePaste, true);
    container.addEventListener("dragenter", handleDragEnter);
    container.addEventListener("dragover", handleDragOver);
    container.addEventListener("dragleave", handleDragLeave);
    container.addEventListener("drop", handleDrop);

    return () => {
      container.removeEventListener("paste", handlePaste, true);
      container.removeEventListener("dragenter", handleDragEnter);
      container.removeEventListener("dragover", handleDragOver);
      container.removeEventListener("dragleave", handleDragLeave);
      container.removeEventListener("drop", handleDrop);
    };
  }, [containerRef, terminalId, isInputLocked, onInput]);
}
