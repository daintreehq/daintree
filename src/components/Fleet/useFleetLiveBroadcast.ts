import { useEffect, useLayoutEffect, useRef } from "react";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useNotificationStore } from "@/store/notificationStore";
import { logWarn } from "@/utils/logger";
import { needsFleetBroadcastConfirmation, resolveFleetBroadcastTargetIds } from "./fleetBroadcast";
import { broadcastFleetKeySequence, broadcastFleetLiteralPaste } from "./fleetExecution";

export interface FleetLiveBroadcastOptions {
  enabled: boolean;
  onPasteConfirm: (text: string) => void;
}

/**
 * Map a DOM keydown event to the terminal byte sequence the PTY expects.
 * Returns null for modifier-only presses, meta-accelerators (Cmd/Win) that
 * should reach the browser, and keys we don't have a mapping for.
 *
 * Uses normal (not application) cursor mode for arrows — works for shells and
 * is tolerated by most TUIs. Application-mode tracking per-PTY is a later
 * refinement.
 */
export function mapKeyToSequence(event: KeyboardEvent): string | null {
  if (["Meta", "Control", "Alt", "Shift", "CapsLock"].includes(event.key)) return null;
  if (event.metaKey) return null;

  switch (event.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return event.shiftKey ? "\x1b[Z" : "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "Delete":
      return "\x1b[3~";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    case "Insert":
      return "\x1b[2~";
  }

  if (event.ctrlKey && !event.altKey && event.key.length === 1) {
    const lower = event.key.toLowerCase();
    const code = lower.charCodeAt(0);
    if (code >= 0x61 && code <= 0x7a) {
      return String.fromCharCode(code - 0x60);
    }
    if (event.key === " ") return "\x00";
    if (event.key === "[") return "\x1b";
    if (event.key === "\\") return "\x1c";
    if (event.key === "]") return "\x1d";
  }

  if (event.altKey && !event.ctrlKey && event.key.length === 1) {
    return "\x1b" + event.key;
  }

  if (!event.ctrlKey && !event.altKey && event.key.length === 1) {
    return event.key;
  }

  // AltGr on Windows/Linux layouts synthesizes ctrlKey=true AND altKey=true;
  // the resulting event.key is the composed printable char (e.g. "@" on DE,
  // "{" on PL). Forward it as a literal keystroke.
  if (event.ctrlKey && event.altKey && event.key.length === 1) {
    const code = event.key.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) return event.key;
  }

  return null;
}

/**
 * Document-level capture: when a fleet of 2+ terminals is armed, raw
 * keystrokes and pastes that originate inside an armed pane's xterm body
 * fan out to every armed PTY. Hybrid-input editor keystrokes are LEFT
 * ALONE here — they stay in the local editor and are mirrored to follower
 * drafts by `HybridInputBar` (per-pane lifecycle: tokens, history, etc).
 *
 * Surface classification:
 *  - Inside an `[data-hybrid-input-editor]` element → skip; per-pane
 *    editor handles the keystroke locally and the bar mirrors via
 *    `terminalInputStore`.
 *  - Inside an `[data-panel-id]` pane that is armed (xterm body) → raw
 *    PTY broadcast. The origin pane's xterm never sees the event.
 *  - Anywhere else → ignore.
 *
 * Escape is intentionally excluded so the ribbon's ⌘Esc / bare-Esc exit
 * and the targets' own Esc handling (menus, prompts under live echo —
 * #5750) keep working. Cmd/Win keys are filtered by `mapKeyToSequence`
 * so app shortcuts still reach the keybinding service.
 */
export function useFleetLiveBroadcast({
  enabled,
  onPasteConfirm,
}: FleetLiveBroadcastOptions): void {
  const onPasteConfirmRef = useRef(onPasteConfirm);
  useLayoutEffect(() => {
    onPasteConfirmRef.current = onPasteConfirm;
  }, [onPasteConfirm]);

  const isComposingRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    type Surface = "hybrid-input" | "armed-xterm" | "ignore";

    const classifyTarget = (target: EventTarget | null): Surface => {
      if (!(target instanceof Element)) return "ignore";
      // Hybrid input takes priority — the editor handles its own
      // keystrokes; mirroring to followers is done at the bar level via
      // `terminalInputStore`, not here.
      if (target.closest<HTMLElement>("[data-hybrid-input-editor]")) {
        return "hybrid-input";
      }
      const pane = target.closest<HTMLElement>("[data-panel-id]");
      if (!pane) return "ignore";
      const id = pane.dataset.panelId;
      if (!id) return "ignore";
      if (!useFleetArmingStore.getState().armedIds.has(id)) return "ignore";
      return "armed-xterm";
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") return;
      if (event.isComposing || event.keyCode === 229 || isComposingRef.current) return;
      if (classifyTarget(event.target) !== "armed-xterm") return;

      const sequence = mapKeyToSequence(event);
      if (sequence == null) return;

      event.preventDefault();
      event.stopPropagation();

      const targets = resolveFleetBroadcastTargetIds();
      broadcastFleetKeySequence(sequence, targets);
    };

    const handleCompositionStart = (event: CompositionEvent) => {
      if (classifyTarget(event.target) !== "armed-xterm") return;
      isComposingRef.current = true;
    };

    const handleCompositionEnd = (event: CompositionEvent) => {
      if (classifyTarget(event.target) !== "armed-xterm") return;
      isComposingRef.current = false;
      const data = event.data ?? "";
      if (!data) return;
      const targets = resolveFleetBroadcastTargetIds();
      broadcastFleetKeySequence(data, targets);
    };

    const handlePaste = (event: ClipboardEvent) => {
      if (classifyTarget(event.target) !== "armed-xterm") return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      event.preventDefault();
      event.stopPropagation();
      if (!text) return;

      if (needsFleetBroadcastConfirmation(text)) {
        onPasteConfirmRef.current(text);
        return;
      }

      const targets = resolveFleetBroadcastTargetIds();
      void (async () => {
        const result = await broadcastFleetLiteralPaste(text, targets);
        if (result.failureCount === 0) return;
        logWarn("[FleetLiveBroadcast] paste broadcast had rejections", {
          failureCount: result.failureCount,
          failedIds: result.failedIds,
        });
        useNotificationStore.getState().addNotification({
          type: result.successCount > 0 ? "warning" : "error",
          priority: "low",
          message:
            result.successCount > 0
              ? `Sent to ${result.successCount} agent${result.successCount === 1 ? "" : "s"} (${result.failureCount} failed)`
              : "Paste failed — no agents received the payload",
        });
      })();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("compositionstart", handleCompositionStart, true);
    document.addEventListener("compositionend", handleCompositionEnd, true);
    document.addEventListener("paste", handlePaste, true);

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("compositionstart", handleCompositionStart, true);
      document.removeEventListener("compositionend", handleCompositionEnd, true);
      document.removeEventListener("paste", handlePaste, true);
      isComposingRef.current = false;
    };
  }, [enabled]);
}
