import { useEffect, useLayoutEffect, useRef } from "react";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { useNotificationStore } from "@/store/notificationStore";
import { logWarn } from "@/utils/logger";
import {
  needsFleetBroadcastConfirmation,
  resolveFleetBroadcastByOrigin,
  resolveFleetBroadcastTargetIds,
} from "./fleetBroadcast";
import { broadcastFleetKeySequence, broadcastFleetLiteralPaste } from "./fleetExecution";

const FLEET_DIVERGENCE_CORRELATION = "fleet-broadcast-divergence";
const FLEET_DIVERGENCE_NOTIFY_INTERVAL_MS = 2000;

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
  const lastDivergenceNotifyAtRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    type Surface =
      | { kind: "hybrid-input" }
      | { kind: "armed-xterm"; originId: string }
      | { kind: "ignore" };

    const classifyTarget = (target: EventTarget | null): Surface => {
      if (!(target instanceof Element)) return { kind: "ignore" };
      // Hybrid input takes priority — the editor handles its own
      // keystrokes; mirroring to followers is done at the bar level via
      // `terminalInputStore`, not here.
      if (target.closest<HTMLElement>("[data-hybrid-input-editor]")) {
        return { kind: "hybrid-input" };
      }
      const pane = target.closest<HTMLElement>("[data-panel-id]");
      if (!pane) return { kind: "ignore" };
      const id = pane.dataset.panelId;
      if (!id) return { kind: "ignore" };
      if (!useFleetArmingStore.getState().armedIds.has(id)) return { kind: "ignore" };
      return { kind: "armed-xterm", originId: id };
    };

    /**
     * Surface a coalesced "Sent to N/M — K in different state" pill when a
     * keystroke fans out to fewer panes than the armed set. The notification
     * store collapses by `correlationId`, so a typing burst against a divergent
     * fleet shows one toast that updates in place rather than a fresh toast
     * per keystroke. We additionally rate-limit to once per
     * FLEET_DIVERGENCE_NOTIFY_INTERVAL_MS so a fast typist doesn't churn the
     * store on every character.
     */
    const notifyDivergence = (matchedCount: number, divergedCount: number): void => {
      const now = Date.now();
      if (now - lastDivergenceNotifyAtRef.current < FLEET_DIVERGENCE_NOTIFY_INTERVAL_MS) return;
      lastDivergenceNotifyAtRef.current = now;
      const sentTo = matchedCount + 1; // +1 for the origin pane
      const totalArmed = sentTo + divergedCount;
      useNotificationStore.getState().addNotification({
        type: "info",
        priority: "low",
        correlationId: FLEET_DIVERGENCE_CORRELATION,
        message: `Sent to ${sentTo}/${totalArmed} — ${divergedCount} in different state`,
      });
    };

    /**
     * Live keystroke fan-out with origin-state gating. The keystroke goes to
     * the origin pane plus every armed peer in a compatible state group
     * (working/running together, completed/exited together, otherwise exact
     * match). Peers in a divergent state are silently dropped — sending `y`
     * from a `[y/N]` waiting prompt should never accidentally inject a `y`
     * into a peer's vim normal-mode buffer. `notifyDivergence` keeps the user
     * aware without crowding the surface.
     */
    const fanOutKeystroke = (sequence: string, originId: string): void => {
      const { matched, diverged } = resolveFleetBroadcastByOrigin(originId);
      const targets = [originId, ...matched];
      broadcastFleetKeySequence(sequence, targets);
      if (diverged.length > 0) notifyDivergence(matched.length, diverged.length);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") return;
      if (event.isComposing || event.keyCode === 229 || isComposingRef.current) return;
      const surface = classifyTarget(event.target);
      if (surface.kind !== "armed-xterm") return;

      const sequence = mapKeyToSequence(event);
      if (sequence == null) return;

      event.preventDefault();
      event.stopPropagation();

      fanOutKeystroke(sequence, surface.originId);
    };

    const handleCompositionStart = (event: CompositionEvent) => {
      if (classifyTarget(event.target).kind !== "armed-xterm") return;
      isComposingRef.current = true;
    };

    const handleCompositionEnd = (event: CompositionEvent) => {
      const surface = classifyTarget(event.target);
      if (surface.kind !== "armed-xterm") return;
      isComposingRef.current = false;
      const data = event.data ?? "";
      if (!data) return;
      fanOutKeystroke(data, surface.originId);
    };

    const handlePaste = (event: ClipboardEvent) => {
      if (classifyTarget(event.target).kind !== "armed-xterm") return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      event.preventDefault();
      event.stopPropagation();
      if (!text) return;

      if (needsFleetBroadcastConfirmation(text)) {
        onPasteConfirmRef.current(text);
        return;
      }

      // Pastes ignore the state-divergence gate: a multi-line paste is an
      // intentional bulk action the user explicitly took, and bracketed-paste
      // semantics protect TUIs from interpreting the contents as keystrokes.
      const targets = resolveFleetBroadcastTargetIds();
      void (async () => {
        const result = await broadcastFleetLiteralPaste(text, targets);
        if (result.failureCount === 0) {
          // A successful broadcast clears any stale failure dot on these
          // targets so the user isn't left with an out-of-date red dot from
          // a prior partial failure that this paste implicitly retried.
          for (const id of targets) useFleetFailureStore.getState().dismissId(id);
          return;
        }
        logWarn("[FleetLiveBroadcast] paste broadcast had rejections", {
          failureCount: result.failureCount,
          failedIds: result.failedIds,
        });
        useFleetFailureStore.getState().recordFailure(text, result.failedIds);
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
