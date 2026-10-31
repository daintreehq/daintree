import { APP_MODAL_SELECTOR } from "@/lib/appModal";

/**
 * Enter and Escape for a voice send that is waiting on its transcript or its
 * cleanup (#14780). The wait locks the editor, and Chromium blurs a
 * contenteditable that stops being editable, so these keys reach the page, not
 * the composer's keymap. Enter sends what stands; Escape calls the send off,
 * and so does Enter on the wait's own Cancel send (`data-voice-wait-cancel`).
 *
 * Other window capture listeners give the same keys meaning at the page (the
 * fleet's Enter-to-confirm, its double-Escape, the Escape stack), so each asks
 * `routeVoiceWaitKey` first. Whichever listener sees the key first routes it,
 * and the rest stand down.
 */
export interface VoiceWaitKeyClaim {
  /** Whether `element` is in this composer: its editor, in either host, or its bar. */
  holds: (element: Element) => boolean;
  /** The composer's editor, so a modal can be told apart from one that holds it. */
  editor: () => Element | null;
  /** Whether the composer's pane is the selected one. */
  isSelected: () => boolean;
  sendNow: () => void;
  cancel: () => void;
}

const claims: VoiceWaitKeyClaim[] = [];
const routed = new WeakSet<KeyboardEvent>();
let listening = false;

function isWaitKey(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" && event.key !== "Escape") return false;
  if (event.isComposing || event.keyCode === 229) return false;
  return !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}

// Enter on the wait's Cancel send is that button's, not a second press of the
// send. It is still consumed, so the fleet's Enter-to-confirm stands down.
function isOnCancelControl(event: KeyboardEvent): boolean {
  const target = event.target;
  return target instanceof Element && target.closest("[data-voice-wait-cancel]") !== null;
}

/** The waiting composer a key typed at `target` belongs to. */
function claimAt(target: EventTarget | null): VoiceWaitKeyClaim | null {
  if (
    target instanceof Element &&
    target !== document.body &&
    target !== document.documentElement
  ) {
    return claims.find((claim) => claim.holds(target)) ?? null;
  }
  // The keyboard is nowhere. A modal that doesn't hold a waiting composer owns
  // the page; past that, the one waiting composer, or the selected pane's.
  const modals = document.querySelectorAll(APP_MODAL_SELECTOR);
  const modal = modals.length > 0 ? modals[modals.length - 1]! : null;
  const candidates = modal
    ? claims.filter((claim) => {
        const editor = claim.editor();
        return editor !== null && modal.contains(editor);
      })
    : claims;
  if (candidates.length === 1) return candidates[0]!;
  const selected = candidates.filter((claim) => claim.isSelected());
  return selected.length === 1 ? selected[0]! : null;
}

/**
 * Hands Enter or Escape to the waiting composer the keyboard belongs to, and
 * returns whether one took it. A routed key is consumed, and asking again for
 * the same event says so without acting twice.
 */
export function routeVoiceWaitKey(event: KeyboardEvent): boolean {
  if (routed.has(event)) return true;
  if (claims.length === 0 || !isWaitKey(event)) return false;
  const claim = claimAt(event.target);
  if (!claim) return false;
  routed.add(event);
  event.preventDefault();
  event.stopImmediatePropagation();
  // The Enter that started the wait, held down, repeats at the page once the
  // lock blurs the editor: it is still the composer's, and still not a second
  // press, so it neither sends nor confirms a fleet action behind it.
  if (event.repeat) return true;
  if (event.key === "Enter" && !isOnCancelControl(event)) claim.sendNow();
  else claim.cancel();
  return true;
}

function onKeyDown(event: KeyboardEvent): void {
  routeVoiceWaitKey(event);
}

/** Which of Enter and Escape, typed where the keyboard is now, reach a waiting send. */
export interface VoiceWaitKeysReach {
  /** Enter sends what stands. */
  enter: boolean;
  /** Escape calls the send off. */
  escape: boolean;
}

export const NO_VOICE_WAIT_KEYS: VoiceWaitKeysReach = { enter: false, escape: false };
const REACHES_BOTH: VoiceWaitKeysReach = { enter: true, escape: true };
const REACHES_ESCAPE: VoiceWaitKeysReach = { enter: false, escape: true };

/**
 * Where Enter and Escape typed now would go, by the same rule that routes
 * them, so a wait names only the keys that reach it. One of three shared
 * values, so a caller can tell a change by identity.
 */
export function voiceWaitKeysReach(claim: VoiceWaitKeyClaim): VoiceWaitKeysReach {
  const active = document.activeElement;
  if (claimAt(active) !== claim) return NO_VOICE_WAIT_KEYS;
  // Enter on Cancel send calls the send off rather than sending it.
  return active instanceof Element && active.closest("[data-voice-wait-cancel]") !== null
    ? REACHES_ESCAPE
    : REACHES_BOTH;
}

const reachListeners = new Set<() => void>();

function notifyReach(): void {
  for (const listener of [...reachListeners]) listener();
}

// Focus leaving for nowhere fires no focusin, and `activeElement` settles on
// the body only after the focusout.
function onFocusOut(): void {
  queueMicrotask(notifyReach);
}

/**
 * Calls `listener` whenever where the wait keys go may have changed: the
 * keyboard moved, or a waiting composer claimed or released them.
 */
export function observeVoiceWaitKeysReach(listener: () => void): () => void {
  if (reachListeners.size === 0) {
    window.addEventListener("focusin", notifyReach, true);
    window.addEventListener("focusout", onFocusOut, true);
  }
  reachListeners.add(listener);
  return () => {
    if (!reachListeners.delete(listener) || reachListeners.size > 0) return;
    window.removeEventListener("focusin", notifyReach, true);
    window.removeEventListener("focusout", onFocusOut, true);
  };
}

/**
 * Claims Enter and Escape for a waiting send until the returned release runs.
 * Capture phase, so the key that started the wait, already past the window
 * when the claim is made, is never routed to it.
 */
export function claimVoiceWaitKeys(claim: VoiceWaitKeyClaim): () => void {
  claims.push(claim);
  if (!listening) {
    listening = true;
    window.addEventListener("keydown", onKeyDown, true);
  }
  // With the keyboard nowhere, how many composers wait decides which gets the keys.
  notifyReach();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const index = claims.indexOf(claim);
    if (index !== -1) claims.splice(index, 1);
    if (claims.length === 0 && listening) {
      listening = false;
      window.removeEventListener("keydown", onKeyDown, true);
    }
    notifyReach();
  };
}
