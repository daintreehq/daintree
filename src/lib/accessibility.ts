import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

/**
 * Elements that are actually in the tab order.
 *
 * Every branch excludes `tabindex="-1"`, not just the generic `[tabindex]` one. A
 * roving-tabindex widget — a tablist, a radiogroup, a listbox — marks its inactive
 * members `-1` precisely so they are not tab stops, and a native tag does not change
 * that. Without the guard, `<button role="radio" tabindex="-1">` counted as the first
 * tabbable element of a dialog, so opening one focused the *unchecked* radio, and a
 * focus trap computed its boundary at an element Tab could never reach.
 */
export const TABBABLE_SELECTOR =
  'a[href]:not([tabindex^="-"]), area[href]:not([tabindex^="-"]), input:not([disabled]):not([type="hidden"]):not([tabindex^="-"]), select:not([disabled]):not([tabindex^="-"]), textarea:not([disabled]):not([tabindex^="-"]), button:not([disabled]):not([tabindex^="-"]), audio[controls]:not([tabindex^="-"]), video[controls]:not([tabindex^="-"]), [contenteditable]:not([contenteditable="false"]):not([tabindex^="-"]), [tabindex]:not([tabindex^="-"])';

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
 * Hand focus to the first candidate that actually accepts it, falling back to
 * the app shell's first tabbable element so focus never drops silently to
 * `<body>` (which strands keyboard users with nothing to tab from).
 *
 * Candidates are tried in preference order — typically the element focused
 * before an overlay opened, then a logical successor for when that element has
 * since been unmounted. `<body>` never counts as a candidate: it is what
 * `document.activeElement` reports when nothing is focused at all.
 *
 * Being connected is not enough to accept focus: a candidate that is `disabled`,
 * `inert`, or hidden makes `.focus()` a silent no-op, which would drop focus to
 * `<body>` — so each attempt is verified and the chain continues on failure.
 * Strict equality is the right check even for a candidate that delegates focus
 * into a shadow tree (an Electron `<webview>` hosts the guest page that way):
 * focus inside a shadow tree is reported at the document level as the host.
 */
export function restoreFocusTo(...candidates: (HTMLElement | null | undefined)[]): void {
  for (const candidate of candidates) {
    if (!candidate || candidate === document.body) continue;
    if (!document.contains(candidate)) continue;

    candidate.focus();
    if (document.activeElement === candidate) return;
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
