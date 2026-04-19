import { formatWithBracketedPaste } from "@shared/utils/terminalInputProtocol";

export interface PrimarySelectionDeps {
  hostElement: HTMLElement;
  terminalId: string;
  getCachedSelection: () => string | undefined;
  getBracketedPasteMode: () => boolean;
  isDisposed: () => boolean;
  isInputLocked: () => boolean;
  writeToPty: (id: string, data: string) => void;
  notifyUserInput: (id: string) => void;
  writeSelection: (text: string) => Promise<unknown>;
  readSelection: () => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
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

  const onMouseUp = () => {
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
      const result = await readSelection();
      if (!result.ok || !result.text) return;
      if (isDisposed() || isInputLocked()) return;
      const payload = getBracketedPasteMode()
        ? formatWithBracketedPaste(result.text)
        : result.text.replace(/\r?\n/g, "\r");
      writeToPty(terminalId, payload);
      notifyUserInput(terminalId);
    } catch {
      // IPC can reject if the main process is unavailable.
    }
  };

  hostElement.addEventListener("mouseup", onMouseUp);
  hostElement.addEventListener("auxclick", onAuxClick, { capture: true });

  return () => {
    hostElement.removeEventListener("mouseup", onMouseUp);
    hostElement.removeEventListener("auxclick", onAuxClick, { capture: true });
  };
}
