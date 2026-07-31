import { useEffect, useRef, useState } from "react";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { deriveTerminalChrome, type TerminalChromeInput } from "@/utils/terminalChrome";
import { escapeShellArgOptional } from "@shared/utils/shellEscape.js";
import { formatWithBracketedPaste } from "@shared/utils/terminalInputProtocol.js";
import { formatAtFileToken } from "./hybridInputParsing";

/**
 * Image file extension pattern shared with HybridInputBar.
 * Exported so both the input bar and terminal can use the same detection.
 */
export const IMAGE_EXTENSIONS = /\.(png|jpe?g|bmp|tiff?|avif|heic)$/i;

/**
 * Runtime identity inputs used to decide whether an agent CLI — rather than a
 * shell — owns this terminal. Passed straight to `deriveTerminalChrome`, which
 * owns the precedence rules (`detectedAgentId` first, `launchAgentId` only
 * while no explicit exit has been observed).
 */
export type TerminalFileTransferIdentity = Pick<
  TerminalChromeInput,
  "launchAgentId" | "detectedAgentId" | "agentState"
>;

/**
 * Checks whether a ClipboardEvent contains an image MIME type item.
 */
function hasImageClipboardItem(event: ClipboardEvent): boolean {
  const items = event.clipboardData?.items;
  if (!items) return false;
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.type.startsWith("image/")) return true;
  }
  return false;
}

interface UseTerminalFileTransferOptions extends TerminalFileTransferIdentity {
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
 * Two independent axes decide what reaches the PTY (#11574):
 *
 * - **Content** follows the terminal's runtime identity. An agent CLI gets the
 *   same `@path` token every other attach surface produces (`@` autocomplete,
 *   hybrid-input paste/drop, voice "link to"); a plain shell keeps a
 *   shell-escaped path, which is what a shell can actually consume.
 * - **Delivery** follows the live xterm bracketed-paste mode. Agent CLIs read
 *   raw stdin and cannot distinguish an injected byte from a typed one, so an
 *   unwrapped `@` would drive their own interactive file picker character by
 *   character. Wrapping the batch marks it as a paste instead. This mirrors
 *   `sendSelectionToTarget` in `useSendToAgentPalette`, including its fallback
 *   to wrapping when no managed instance is available.
 *
 * Never appends a carriage return — a drop inserts text, it does not submit.
 *
 * @returns Whether files are currently dragged over the container, so the pane
 *   can render drop feedback. Always `false` while input is locked: advertising
 *   a drop target for a gesture that will be discarded is false feedback.
 */
export function useTerminalFileTransfer(
  containerRef: React.RefObject<HTMLDivElement | null>,
  {
    terminalId,
    isInputLocked,
    onInput,
    launchAgentId,
    detectedAgentId,
    agentState,
  }: UseTerminalFileTransferOptions
): boolean {
  const dragDepthRef = useRef(0);
  const [isDragOverFiles, setIsDragOverFiles] = useState(false);

  // Runtime identity and lock state are read at gesture time, not captured in
  // the listener closure: a detected-agent flip must change the next drop's
  // format without tearing down and re-registering five DOM listeners, and the
  // image-paste path has to re-read both across its `await saveImage()`.
  const identityRef = useRef<TerminalFileTransferIdentity>({
    launchAgentId,
    detectedAgentId,
    agentState,
  });
  const isInputLockedRef = useRef(isInputLocked);

  useEffect(() => {
    identityRef.current = { launchAgentId, detectedAgentId, agentState };
  }, [launchAgentId, detectedAgentId, agentState]);

  useEffect(() => {
    isInputLockedRef.current = isInputLocked;
  }, [isInputLocked]);

  // Locking mid-drag strands the hover state on: the drop that would clear it
  // is now a no-op, so clear it here instead.
  useEffect(() => {
    if (!isInputLocked) return;
    dragDepthRef.current = 0;
    setIsDragOverFiles(false);
  }, [isInputLocked]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    const formatPath = (filePath: string): string =>
      deriveTerminalChrome(identityRef.current).isAgent
        ? formatAtFileToken(filePath)
        : escapeShellArgOptional(filePath);

    /**
     * Writes one already-formatted batch as a single insertion, wrapping it in
     * bracketed paste when the foreground program has asked for it.
     */
    const writeToTerminal = (text: string) => {
      const managed = terminalInstanceService.get(terminalId);
      const payload =
        !managed || managed.terminal.modes.bracketedPasteMode
          ? formatWithBracketedPaste(text)
          : text;

      terminalClient.write(terminalId, payload);
      terminalInstanceService.notifyUserInput(terminalId);
      // The unwrapped text — bracket markers must not reach input tracking.
      onInput?.(text);
    };

    const handlePaste = async (event: ClipboardEvent) => {
      if (isInputLockedRef.current) return;
      if (!hasImageClipboardItem(event)) return;

      // Prevent xterm from processing the image paste as text
      event.preventDefault();
      event.stopPropagation();

      try {
        const { filePath } = await window.electron.clipboard.saveImage();
        // Re-check after the await: the pane may have unmounted or locked, and
        // the running agent may have changed, while the image was being saved.
        if (cancelled || isInputLockedRef.current) return;
        writeToTerminal(`${formatPath(filePath)} `);
      } catch {
        // Empty clipboard, IPC failure during window close, etc. — nothing to do.
      }
    };

    const handleDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      if (isInputLockedRef.current) return;
      dragDepthRef.current++;
      if (dragDepthRef.current === 1) setIsDragOverFiles(true);
    };

    const handleDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = isInputLockedRef.current ? "none" : "copy";
    };

    const handleDragLeave = (e: DragEvent) => {
      e.stopPropagation();
      dragDepthRef.current--;
      if (dragDepthRef.current <= 0) {
        dragDepthRef.current = 0;
        setIsDragOverFiles(false);
      }
    };

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = 0;
      setIsDragOverFiles(false);

      if (isInputLockedRef.current) return;
      if (!e.dataTransfer?.files.length) return;

      const formatted: string[] = [];
      for (const file of Array.from(e.dataTransfer.files)) {
        const filePath = window.electron.webUtils.getPathForFile(file);
        if (filePath) formatted.push(formatPath(filePath));
      }

      if (formatted.length === 0) return;

      // Trailing space terminates the last token and leaves the caret ready for
      // the next argument or prompt word, matching the hybrid input's drop.
      writeToTerminal(`${formatted.join(" ")} `);
    };

    // Use capture phase for paste so we intercept before xterm's own handler
    container.addEventListener("paste", handlePaste, true);
    container.addEventListener("dragenter", handleDragEnter);
    container.addEventListener("dragover", handleDragOver);
    container.addEventListener("dragleave", handleDragLeave);
    container.addEventListener("drop", handleDrop);

    return () => {
      cancelled = true;
      container.removeEventListener("paste", handlePaste, true);
      container.removeEventListener("dragenter", handleDragEnter);
      container.removeEventListener("dragover", handleDragOver);
      container.removeEventListener("dragleave", handleDragLeave);
      container.removeEventListener("drop", handleDrop);
    };
  }, [containerRef, terminalId, onInput]);

  return isDragOverFiles;
}
