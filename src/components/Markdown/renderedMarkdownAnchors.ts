import { MARKDOWN_ID_PREFIX, markdownFragmentIds } from "./headingIds";
import { paneScroller } from "./renderedFind";

/** How far below the top of the pane a followed link's target lands by default. */
export const ANCHOR_TOP_GAP = 8;

/**
 * The element a same-document link (`#risks`, `#user-content-fn-1`) names,
 * looked up inside its own document only: panels in a project share one page,
 * so two plans open side by side both carry `user-content-risks`, and
 * `getElementById` would find whichever came first. Only ids the pipeline
 * minted count; a Mermaid diagram's SVG carries ids of its own.
 */
export function findMarkdownTarget(root: Element, href: string): HTMLElement | null {
  const candidates = markdownFragmentIds(href);
  if (candidates.length === 0) return null;
  const byId = new Map<string, HTMLElement>();
  for (const element of root.querySelectorAll(`[id^="${MARKDOWN_ID_PREFIX}"]`)) {
    if (!(element instanceof HTMLElement) || element.closest("svg")) continue;
    if (!byId.has(element.id)) byId.set(element.id, element);
  }
  for (const id of candidates) {
    const target = byId.get(id);
    if (target) return target;
  }
  return null;
}

/**
 * Follows a same-document link: scrolls the pane the document scrolls in so
 * the target sits `topGap` below its top, and moves focus there, so the next
 * Tab carries on from the section rather than back at the link. Only that
 * pane scrolls, never the panel or window around it, which is why this isn't
 * `scrollIntoView`. Returns whether the link named anything.
 */
export function followMarkdownFragment(
  root: Element,
  href: string,
  topGap = ANCHOR_TOP_GAP
): boolean {
  const target = findMarkdownTarget(root, href);
  if (!target) return false;
  const scroller = paneScroller(root);
  if (scroller) {
    const offset =
      target.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      scroller.clientTop -
      topGap;
    scroller.scrollTop = Math.max(0, scroller.scrollTop + offset);
  }
  // A heading takes focus only with a tabindex; a footnote's back-link target
  // is a link already, and `-1` would drop it from the Tab order.
  if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) {
    target.setAttribute("tabindex", "-1");
  }
  target.focus({ preventScroll: true });
  return true;
}
