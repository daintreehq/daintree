import {
  getVisibleTabbableElements,
  INTERACTIVE_CONTROL_SELECTOR,
  TRUNCATION_DISCLOSURE_ATTR,
} from "@/lib/accessibility";
import { APP_DIALOG_SURFACE_ATTR } from "@/lib/appDialogSurface";
import { ESCAPE_BACKSTOP_DIALOG_ATTR } from "@/lib/dialogEscapeBackstop";

/** Marks a dialog header's close button, which focus passes over on its way in. */
export const DIALOG_CLOSE_ATTR = "data-dialog-close";

const MODAL_SELECTOR =
  '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';

/**
 * Where focus lands entering a dialog: its first control, never the header's
 * close button while anything else is there (it answers nothing, so a reflexive
 * Enter there throws the dialog away), and never a truncated label made
 * tabbable only to show its full text (focus there opens its tooltip). The
 * marker can also land on a real control, so only a non-control is skipped.
 */
export function firstDialogFocusTarget(root: ParentNode): HTMLElement | null {
  const tabbable = getVisibleTabbableElements(root).filter(
    (el) => !el.hasAttribute(TRUNCATION_DISCLOSURE_ATTR) || el.matches(INTERACTIVE_CONTROL_SELECTOR)
  );
  return tabbable.find((el) => !el.hasAttribute(DIALOG_CLOSE_ATTR)) ?? tabbable[0] ?? null;
}

function isOpenModal(surface: HTMLElement, closing: Element | null): boolean {
  if (closing && (surface.contains(closing) || closing.contains(surface))) return false;
  if (surface.closest("[hidden], [inert]")) return false;
  if (surface.getAttribute("data-state") === "closed") return false;
  // An AppDialog keeps `aria-modal` through its exit; only the Escape marker
  // drops with `isOpen`.
  if (surface.hasAttribute(APP_DIALOG_SURFACE_ATTR)) {
    return surface.hasAttribute(ESCAPE_BACKSTOP_DIALOG_ATTR);
  }
  return true;
}

/** The z-index of the body-level layer a portalled surface paints in. */
function layerOf(surface: HTMLElement): number {
  let layer = surface;
  while (layer.parentElement && layer.parentElement !== document.body) {
    layer = layer.parentElement;
  }
  const z = Number.parseInt(getComputedStyle(layer).zIndex, 10);
  return Number.isNaN(z) ? 0 : z;
}

/**
 * The modal still open over the app once `closing` is out of the way: the one
 * on the highest layer, the last opened among equals. Null when none is.
 */
export function topmostOpenModal(closing: Element | null): HTMLElement | null {
  let top: HTMLElement | null = null;
  let topLayer = -Infinity;
  for (const surface of document.querySelectorAll<HTMLElement>(MODAL_SELECTOR)) {
    if (!isOpenModal(surface, closing)) continue;
    const layer = layerOf(surface);
    if (layer >= topLayer) {
      top = surface;
      topLayer = layer;
    }
  }
  return top;
}

/**
 * Whether the keyboard already belongs to a modal other than `closing`: a
 * dialog it spawned on its way out, which its restore must not pull focus
 * back out of.
 */
export function focusHeldByOtherModal(closing: Element | null): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  for (const surface of document.querySelectorAll<HTMLElement>(MODAL_SELECTOR)) {
    if (surface.contains(active) && isOpenModal(surface, closing)) return true;
  }
  return false;
}

/**
 * Hand focus somewhere sensible once nothing a closing overlay recorded can
 * take it. Inside the modal still open under it when there is one: the app
 * shell sits behind that modal's backdrop, so focus there is out of the user's
 * reach. Otherwise the shell's first tabbable element, rather than `<body>`.
 */
export function focusAfterOverlayCloses(closing: Element | null): void {
  const modal = topmostOpenModal(closing);
  if (modal) {
    if (modal.contains(document.activeElement)) return;
    const target =
      firstDialogFocusTarget(modal) ??
      (modal.hasAttribute("tabindex") ? modal : modal.querySelector<HTMLElement>("[tabindex]"));
    target?.focus();
    return;
  }
  const root = document.getElementById("root");
  const fallback = root ? getVisibleTabbableElements(root)[0] : undefined;
  fallback?.focus();
}
