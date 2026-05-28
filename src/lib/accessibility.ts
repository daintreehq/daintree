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
