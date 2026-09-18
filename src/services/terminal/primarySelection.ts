import {
  formatWithBracketedPaste,
  neutralizeControlCharacters,
} from "@shared/utils/terminalInputProtocol";

export interface PrimarySelectionDeps {
  hostElement: HTMLElement;
  terminalId: string;
  getCachedSelection: () => string | undefined;
  getBracketedPasteMode: () => boolean;
  isDisposed: () => boolean;
  isInputLocked: () => boolean;
  writeToPty: (id: string, data: string) => void;
  notifyUserInput: (id: string) => void;
  writeSelection: (text: string) => Promise<void>;
  readSelection: () => Promise<{ text: string }>;
}

// Installs Linux PRIMARY selection listeners on the terminal host element:
// - mouseup writes the cached selection to PRIMARY (copy-on-select)
// - auxclick (button 1) reads PRIMARY and pastes into the PTY (middle-click paste)
//
// Write-on-mouseup avoids Chromium's per-mousemove selection spam during drag.
// auxclick uses capture phase because xterm.js 6.0 stopPropagation()s on bubble.
export function installLinuxPrimarySelectionListeners(deps: PrimarySelectionDeps): () => void {
  const {
    hostElement,
    terminalId,
    getCachedSelection,
    getBracketedPasteMode,
    isDisposed,
    isInputLocked,
    writeToPty,
    notifyUserInput,
    writeSelection,
    readSelection,
  } = deps;

  const onMouseUp = (event: MouseEvent) => {
    // Only respond to primary-button releases — middle/right-click releases
    // after an existing selection would otherwise re-issue a redundant write.
    if (event.button !== 0) return;
    const sel = getCachedSelection();
    if (!sel) return;
    void writeSelection(sel).catch(() => {
      // Silent — PRIMARY writes fail on minimal Wayland compositors without
      // zwp_primary_selection_v1. Copy-on-select is a convenience, not critical.
    });
  };

  const onAuxClick = async (event: MouseEvent) => {
    if (event.button !== 1) return;
    if (isInputLocked()) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const { text } = await readSelection();
      if (!text) return;
      if (isDisposed() || isInputLocked()) return;
      // A PRIMARY selection is whatever was on screen, escape sequences from a
      // program's own output included, so neither branch may hand it to the
      // parser as it stands. Each branch neutralises for itself, because `\r`
      // means different things in the two: inside a bracketed paste it is the
      // line separator and must survive, and the wrapper keeps it. Unwrapped it
      // submits, which is what middle-click has always done — so every line
      // ending, CRLF and bare CR and bare LF alike, is folded to `\n` first,
      // neutralised, and only then turned back into the `\r` we mean. Folding
      // only CRLF would leave a bare CR for the sanitiser to glyph, and a
      // selection off a screen that uses them would paste as a single line.
      const payload = getBracketedPasteMode()
        ? formatWithBracketedPaste(text)
        : neutralizeControlCharacters(text.replace(/\r\n|\r/g, "\n")).replace(/\n/g, "\r");
      writeToPty(terminalId, payload);
      notifyUserInput(terminalId);
    } catch {
      // UNSUPPORTED on non-Linux, IPC failure during shutdown, etc.
    }
  };

  hostElement.addEventListener("mouseup", onMouseUp);
  hostElement.addEventListener("auxclick", onAuxClick, { capture: true });

  return () => {
    hostElement.removeEventListener("mouseup", onMouseUp);
    hostElement.removeEventListener("auxclick", onAuxClick, { capture: true });
  };
}
