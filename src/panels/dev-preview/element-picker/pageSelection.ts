import type { ElementContext, SiteSelection, Viewport } from "./legacyBridge.js";

/**
 * A selection with no source behind it: what the page showed, in the page's
 * own terms. Any framework's dev server produces one; a SvelteKit app whose
 * source resolves produces a {@link SiteSelection} instead. Nothing in it was
 * checked against the worktree, so a request built from it says so.
 */
export interface PageSelection {
  kind: "page";
  selectionId: string;
  previewPanelId: string;
  documentEpoch: number;
  /** Redacted the same way a resolved selection's address is. */
  displayedUrl: string;
  viewport: Viewport;
  nodes: PageNode[];
  capturedAt: string;
}

export interface PageNode {
  /** The page's label for the element, collapsed to one line. */
  label: string;
  tagName: string;
  /** Null when the page's DOM refused to be read, or from a runtime that predates it. */
  context: ElementContext | null;
}

/**
 * What the page showed of an element whose source was traced: its own account
 * of it, and the location it stamped on it, verbatim — which is not always
 * where main found it, so the two are kept apart.
 */
export interface ShownNode extends PageNode {
  stamp: { file: string; line: number; column: number } | null;
}

/** The picture of a selection, cropped from the preview, or why there isn't one. */
export type PageScreenshot =
  { status: "attached"; path: string } | { status: "omitted"; reason: string };

export type ComposerSubjectSelection = SiteSelection | PageSelection;

export function isPageSelection(selection: ComposerSubjectSelection): selection is PageSelection {
  return "kind" in selection && selection.kind === "page";
}

/**
 * The box a picture of these elements needs: every measured rect, joined.
 * Null when nothing had a size, which is nothing to take a picture of.
 */
export function unionBounds(
  rects: ReadonlyArray<{ x: number; y: number; width: number; height: number }>
): { x: number; y: number; width: number; height: number } | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    if (!(rect.width > 0 && rect.height > 0)) continue;
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
