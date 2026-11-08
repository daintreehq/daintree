import { useEffect, useRef, type RefObject } from "react";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { actionService } from "@/services/ActionService";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import {
  useFleetPendingActionStore,
  type FleetPendingActionSnapshot,
} from "@/store/fleetPendingActionStore";
import { routeVoiceWaitKey } from "@/lib/voiceWaitKeys";
import { isInPaneDialog } from "@/lib/paneDialog";
import { hasAppModal } from "@/lib/appModal";
import { buildConfirmLabels, confirmActionId } from "./buildConfirmMessage";

/** How long an unanswered confirmation stays armed. */
export const FLEET_CONFIRM_TTL_MS = 30_000;

// The xterm body and the agent prompt editor both type into the pane.
const TERMINAL_INPUT_SELECTOR = ".xterm, [data-hybrid-input-editor]";
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
// Custom fields (time pickers, sliders, comboboxes) take Enter as their own
// commit even where nothing in them is editable.
const CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="spinbutton"]',
  '[role="slider"]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="treeitem"]',
].join(", ");
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);

type KeyTarget = "banner" | "terminal" | "editable" | "control" | "page";

function classifyTarget(target: EventTarget | null, banner: HTMLElement | null): KeyTarget {
  if (!(target instanceof Element)) return "page";
  if (banner?.contains(target)) return "banner";
  // A surface typing to one terminal outside the grid (Canopy's reply, the
  // assistant) is not the fleet's pane: its keys stay its own.
  if (target.closest("[data-keybindings-isolated]") !== null) return "editable";
  if (target.closest(TERMINAL_INPUT_SELECTOR) !== null) return "terminal";
  if (
    (target instanceof HTMLElement && target.isContentEditable) ||
    target.closest(EDITABLE_SELECTOR) !== null
  ) {
    return "editable";
  }
  if (target.closest(CONTROL_SELECTOR) !== null) return "control";
  return "page";
}

/**
 * A held Enter or Escape keeps repeating after the press that answered the
 * confirmation, when the confirmation (and its listeners) are already gone;
 * each repeat would reach the terminal and the fleet. Swallow them until the
 * key comes up.
 */
function swallowRepeatsOf(key: string): void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== key || !e.repeat) {
      release();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === key) release();
  };
  function release() {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", release);
  }
  // Added while this key's own event is still dispatching, so that event never reaches them.
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", release);
}

function isCurrent(snapshot: FleetPendingActionSnapshot): boolean {
  return useFleetPendingActionStore.getState().pending === snapshot;
}

function clearIfCurrent(snapshot: FleetPendingActionSnapshot): void {
  if (isCurrent(snapshot)) useFleetPendingActionStore.getState().clear();
}

function expire(snapshot: FleetPendingActionSnapshot): void {
  if (!isCurrent(snapshot)) return;
  useFleetPendingActionStore.getState().clear();
  useAnnouncerStore
    .getState()
    .announce(buildConfirmLabels(snapshot.kind, snapshot.targetCount).expired);
}

function confirm(
  snapshot: FleetPendingActionSnapshot,
  deadline: number,
  source: "user" | "keybinding"
): void {
  if (!isCurrent(snapshot)) return;
  // A timer held back (a frozen or throttled view) must not leave a lapsed
  // confirmation live for the key that wakes it.
  if (Date.now() >= deadline) {
    expire(snapshot);
    return;
  }
  // Cleared before dispatch so a second Enter or click while the action runs
  // can't send it twice.
  useFleetPendingActionStore.getState().clear();
  void actionService.dispatch(confirmActionId(snapshot.kind), { confirmed: true }, { source });
}

export interface FleetPendingConfirmControls {
  confirm: () => void;
  cancel: () => void;
}

/**
 * The keyboard, pointer and lifetime rules of a pending fleet confirmation.
 *
 * The chord that asks for one is nearly always pressed in an agent terminal,
 * so the Enter and Escape the banner names are taken from the terminal before
 * xterm or the prompt editor sees them; anything that slipped through was
 * typed into every armed pane (#16435). The confirmation lapses once the user
 * moves on (a press elsewhere, a key, leaving the window) and after
 * `FLEET_CONFIRM_TTL_MS` regardless, so a later Enter meant for something else
 * can't set it off. Focus changes alone don't count: Electron refocuses the
 * terminal on its own.
 */
export function useFleetPendingConfirm(
  pending: FleetPendingActionSnapshot | null,
  bannerRef: RefObject<HTMLElement | null>
): FleetPendingConfirmControls {
  const deadlineRef = useRef<{ snapshot: FleetPendingActionSnapshot; at: number } | null>(null);

  const cancel = () => {
    const current = useFleetPendingActionStore.getState().pending;
    if (current !== null) clearIfCurrent(current);
  };

  // Escape from anywhere the terminal doesn't own reaches the escape stack.
  useEscapeStack(pending !== null, cancel);

  useEffect(() => {
    if (pending === null) return;
    const deadline = Date.now() + FLEET_CONFIRM_TTL_MS;
    deadlineRef.current = { snapshot: pending, at: deadline };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isCurrent(pending)) return;
      // A dictated send waiting on its cleanup takes the Enter and Escape meant for it.
      if (routeVoiceWaitKey(e)) return;
      const target = classifyTarget(e.target, bannerRef.current);
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
      const composing = e.isComposing || e.keyCode === 229;
      // A modal owns the keyboard while it is open. This listener is capture-
      // phase, so without the guard it beat a focused Cancel button to the Enter
      // and confirmed the fleet action instead of activating that button
      // (issue #11106). Tested by existence rather than ancestry because modal
      // content can be portaled outside the dialog's subtree (Radix menus and
      // selects mount under <body>). A page's dialog blocks only its own pane,
      // so it holds the keys only while focus is inside it (#15037).
      const inModal = hasAppModal() || isInPaneDialog(e.target);

      // A consumed key stops here, later window listeners included: React can
      // commit the cleared confirm between listeners, and useFleetEscapeChords
      // would then take the cancelling Escape as the first tap of an interrupt.
      if (e.key === "Escape") {
        if (!plain || composing || inModal || target !== "terminal") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.repeat) return;
        clearIfCurrent(pending);
        swallowRepeatsOf(e.key);
        return;
      }

      if (e.key === "Enter") {
        // The banner's own buttons activate natively, so Enter on Cancel cancels.
        if (target === "banner") return;
        if (plain && !composing && !inModal && (target === "terminal" || target === "page")) {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (e.repeat) return;
          confirm(pending, deadline, "keybinding");
          swallowRepeatsOf(e.key);
          return;
        }
        // An Enter for a field, a control or a modified send is the user's
        // next move, not an answer: it goes where it was aimed.
        clearIfCurrent(pending);
        return;
      }

      // A held key is no new move: the chord that asked for this confirmation,
      // held, repeats here (its first press never does, since this listener
      // only exists once that press has asked). Shortcuts and terminal control
      // keys (Ctrl+C) otherwise count, as anything else typed does.
      if (MODIFIER_KEYS.has(e.key) || e.repeat) return;
      if (target === "banner") return;
      // Tab outside a terminal is the keyboard's way to the banner's buttons.
      if (e.key === "Tab" && target !== "terminal") return;
      clearIfCurrent(pending);
    };

    const onPointerDown = (e: PointerEvent) => {
      const banner = bannerRef.current;
      if (banner && e.target instanceof Node && banner.contains(e.target)) return;
      clearIfCurrent(pending);
    };

    // The window's own blur only: element blurs don't bubble to a
    // non-capture window listener.
    const onBlur = () => clearIfCurrent(pending);

    const timer = setTimeout(() => expire(pending), FLEET_CONFIRM_TTL_MS);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [pending, bannerRef]);

  return {
    confirm: () => {
      const current = useFleetPendingActionStore.getState().pending;
      if (current === null) return;
      const tracked = deadlineRef.current;
      const deadline = tracked?.snapshot === current ? tracked.at : Infinity;
      confirm(current, deadline, "user");
    },
    cancel,
  };
}
