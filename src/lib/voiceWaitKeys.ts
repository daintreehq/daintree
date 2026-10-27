/**
 * Enter and Escape for a voice send that is waiting on its transcript or its
 * cleanup (#14780). The wait locks the editor, and Chromium blurs a
 * contenteditable that stops being editable, so these keys reach the page, not
 * the composer's keymap. Enter sends what stands; Escape calls the send off.
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

// A destructive AppDialog without a preview is an alertdialog.
const MODAL_SELECTOR =
  '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';

function isWaitKey(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" && event.key !== "Escape") return false;
  if (event.isComposing || event.keyCode === 229) return false;
  return !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}

function claimFor(event: KeyboardEvent): VoiceWaitKeyClaim | null {
  const target = event.target;
  if (
    target instanceof Element &&
    target !== document.body &&
    target !== document.documentElement
  ) {
    return claims.find((claim) => claim.holds(target)) ?? null;
  }
  // The keyboard is nowhere. A modal that doesn't hold a waiting composer owns
  // the page; past that, the one waiting composer, or the selected pane's.
  const modals = document.querySelectorAll(MODAL_SELECTOR);
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
  const claim = claimFor(event);
  if (!claim) return false;
  routed.add(event);
  event.preventDefault();
  event.stopImmediatePropagation();
  // The Enter that started the wait, held down, repeats at the page once the
  // lock blurs the editor: it is still the composer's, and still not a second
  // press, so it neither sends nor confirms a fleet action behind it.
  if (event.repeat) return true;
  if (event.key === "Enter") claim.sendNow();
  else claim.cancel();
  return true;
}

function onKeyDown(event: KeyboardEvent): void {
  routeVoiceWaitKey(event);
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
  };
}
