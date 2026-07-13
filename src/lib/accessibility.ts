import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

export const TABBABLE_SELECTOR =
  'a[href], area[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex^="-"])';

function isHiddenFromFocus(element: HTMLElement): boolean {
  if (element.closest("[hidden], [inert], [aria-hidden='true']")) return true;

  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  return style?.display === "none" || style?.visibility === "hidden";
}

export function isVisibleTabbableElement(element: HTMLElement): boolean {
  if (isHiddenFromFocus(element)) return false;

  const checkVisibility = element.checkVisibility;
  if (typeof checkVisibility === "function") {
    try {
      return checkVisibility.call(element, {
        checkOpacity: false,
        checkVisibilityCSS: true,
      });
    } catch {
      return checkVisibility.call(element);
    }
  }

  return true;
}

export function getVisibleTabbableElements(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter(
    isVisibleTabbableElement
  );
}

/**
 * Hand focus to the first candidate that is still connected to the document,
 * falling back to the app shell's first tabbable element so focus never drops
 * silently to `<body>` (which strands keyboard users).
 *
 * Candidates are tried in preference order — typically the element focused
 * before an overlay opened, then a logical successor for when that element has
 * since been unmounted. `<body>` never counts as a candidate: it is what
 * `document.activeElement` reports when nothing is focused at all.
 *
 * Deliberately does not verify that `.focus()` actually moved focus. An Electron
 * `<webview>` is a custom element hosting the guest page behind a shadow root,
 * so a false-negative check would yank focus into the app shell — worse than
 * leaving it where it landed.
 */
export function restoreFocusTo(...candidates: (HTMLElement | null | undefined)[]): void {
  for (const candidate of candidates) {
    if (!candidate || candidate === document.body) continue;
    if (!document.contains(candidate)) continue;
    candidate.focus();
    return;
  }

  const root = document.getElementById("root");
  getVisibleTabbableElements(root ?? document.body)[0]?.focus();
}

/**
 * Close a modal/dialog/popover, then announce a result to assistive tech.
 *
 * macOS VoiceOver drops `aria-live` updates that originate outside the focused
 * `aria-modal="true"` subtree (Chromium 354736464), so announcing before the
 * modal closes silently loses the message. Closing first hands focus back to
 * the main tree before the announcement fires. Delivery routes through the
 * announcer store, which prefers `document.ariaNotify` (bypassing the subtree
 * filter) and falls back to a live-region mutation — never call `ariaNotify`
 * directly. If `closeFn` throws, the announcement is skipped so a failed close
 * can't produce a misleading success message.
 */
export function closeAndAnnounce(
  closeFn: () => void,
  message: string,
  priority?: "polite" | "assertive"
): void {
  closeFn();
  useAnnouncerStore.getState().announce(message, priority);
}
