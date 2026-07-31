import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentState } from "@shared/types/agent";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { escapeShellArgOptional } from "@shared/utils/shellEscape.js";
import { formatWithBracketedPaste } from "@shared/utils/terminalInputProtocol.js";
import { formatAtFileTokenForCwd } from "./hybridInputParsing";

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
export interface TerminalFileTransferIdentity {
  launchAgentId?: string;
  detectedAgentId?: string;
  agentState?: AgentState;
}

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

const ESC = String.fromCharCode(27);

/**
 * Control characters that cannot be delivered safely as terminal input.
 *
 * CR and LF read as Enter to a program that is not in bracketed-paste mode,
 * which would submit rather than insert; ESC can open an escape sequence. All
 * three are legal in a POSIX filename, so a dropped path really can carry them.
 * Such a path is skipped exactly like one that failed to resolve — there is no
 * sanitized form that still points at the same file.
 */
function isDeliverablePath(filePath: string): boolean {
  return !filePath.includes("\r") && !filePath.includes("\n") && !filePath.includes(ESC);
}

interface UseTerminalFileTransferOptions extends TerminalFileTransferIdentity {
  terminalId: string;
  isInputLocked?: boolean;
  onInput?: (data: string) => void;
  /**
   * Reads the terminal's live cwd, called at gesture time so a `cd` between
   * mount and drop relativizes against where the terminal actually is.
   * Omitted (or empty) leaves every path absolute, which is what
   * `formatAtFileTokenForCwd` already does for an out-of-tree file.
   */
  cwdProvider?: () => string;
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
 *   hybrid-input paste/drop, voice "link to") — including its cwd-relative
 *   spelling (#11575), so dropping a file on the terminal and dropping it on
 *   the input bar cannot disagree about what the reference looks like. A plain
 *   shell keeps an absolute shell-escaped path, which is what a shell can
 *   actually consume.
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
    cwdProvider,
    launchAgentId,
    detectedAgentId,
    agentState,
  }: UseTerminalFileTransferOptions
): boolean {
  const dragDepthRef = useRef(0);
  // Physical presence of a file drag, independent of whether we would accept a
  // drop. Masking happens on the way out, so unlocking mid-drag restores the
  // affordance without waiting for the pointer to leave and re-enter.
  const [isDragOverFiles, setIsDragOverFiles] = useState(false);

  // Runtime identity and lock state are read at gesture time, not captured in
  // the listener closure: a detected-agent flip must change the next drop's
  // format without tearing down and re-registering the DOM listeners, and the
  // image-paste path has to re-read both across its `await saveImage()`.
  //
  // Layout phase, not passive: a promise continuation or a native drag event
  // can run after a commit but before passive effects flush, and would then
  // read a lock or identity the UI has already moved on from.
  const identityRef = useRef<TerminalFileTransferIdentity>({
    launchAgentId,
    detectedAgentId,
    agentState,
  });
  const isInputLockedRef = useRef(isInputLocked);
  const cwdProviderRef = useRef(cwdProvider);
  const isMountedRef = useRef(true);

  useLayoutEffect(() => {
    identityRef.current = { launchAgentId, detectedAgentId, agentState };
    isInputLockedRef.current = isInputLocked;
    cwdProviderRef.current = cwdProvider;
  });

  useLayoutEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    const isAgentTerminal = (): boolean => deriveTerminalChrome(identityRef.current).isAgent;

    // The OS hands drop and clipboard-save an absolute path, so the agent
    // branch relativizes exactly like the hybrid input's drop and paste do —
    // same helper, cwd read at gesture time. The shell branch stays absolute:
    // a relative path only resolves if the shell's own cwd still matches.
    const formatPath = (filePath: string, isAgent: boolean): string =>
      isAgent
        ? formatAtFileTokenForCwd(filePath, cwdProviderRef.current?.() ?? "")
        : escapeShellArgOptional(filePath);

    /**
     * Writes one already-formatted batch as a single insertion, wrapping it in
     * bracketed paste when the foreground program has asked for it.
     *
     * The renderer instance is created asynchronously, so `get()` can return
     * null while a live PTY is already attached. "Unknown" is not evidence of
     * either mode, so fall back on identity: an agent almost certainly enabled
     * bracketed paste and must not be fed raw `@` keystrokes, whereas a shell
     * that never enabled it would render the delimiters as literal input.
     */
    const writeToTerminal = (text: string, isAgent: boolean) => {
      const managed = terminalInstanceService.get(terminalId);
      const useBracketedPaste = managed ? managed.terminal.modes.bracketedPasteMode : isAgent;
      const payload = useBracketedPaste ? formatWithBracketedPaste(text) : text;

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
        if (cancelled || !isMountedRef.current || isInputLockedRef.current) return;
        if (!filePath || !isDeliverablePath(filePath)) return;
        const isAgent = isAgentTerminal();
        writeToTerminal(`${formatPath(filePath, isAgent)} `, isAgent);
      } catch {
        // Empty clipboard, IPC failure during window close, etc. — nothing to do.
      }
    };

    const handleDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
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

      const isAgent = isAgentTerminal();
      const formatted: string[] = [];
      for (const file of Array.from(e.dataTransfer.files)) {
        const filePath = window.electron.webUtils.getPathForFile(file);
        if (filePath && isDeliverablePath(filePath)) formatted.push(formatPath(filePath, isAgent));
      }

      if (formatted.length === 0) return;

      // Trailing space terminates the last token and leaves the caret ready for
      // the next argument or prompt word, matching the hybrid input's drop.
      writeToTerminal(`${formatted.join(" ")} `, isAgent);
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

  return isDragOverFiles && !isInputLocked;
}
