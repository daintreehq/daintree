import {
  isBrowserPanel,
  isDevPreviewPanel,
  isPtyPanel,
  isReviewPanel,
  type PanelInstance,
} from "@shared/types/panel";

let _prevById: Record<string, PanelInstance> | null = null;
let _prevIds: string[] | null = null;
let _prevResult: PanelInstance[] | null = null;

export function selectOrderedTerminals(
  panelsById: Record<string, PanelInstance>,
  panelIds: string[]
): PanelInstance[] {
  if (panelsById === _prevById && panelIds === _prevIds && _prevResult) {
    return _prevResult;
  }
  _prevById = panelsById;
  _prevIds = panelIds;
  _prevResult = panelIds
    .map((id) => panelsById[id])
    .filter((t): t is PanelInstance => Boolean(t));
  return _prevResult;
}

/**
 * Adapter selector: narrow a single carrier entry to the `PanelInstance`
 * discriminated union. Since the carrier now is `Record<string, PanelInstance>`
 * the narrowing is mostly a passthrough — kept around as the sanctioned read
 * path for callers that want to drop carrier entries with extension/plugin
 * `kind` values that aren't part of the built-in `PanelInstance` union.
 *
 * Returns `undefined` for an absent id and for any panel whose `kind` is
 * outside the built-in union (e.g. an extension/plugin kind).
 */
export function getNarrowPanel(
  panelsById: Record<string, PanelInstance>,
  id: string
): PanelInstance | undefined {
  const panel = panelsById[id];
  if (!panel) return undefined;
  if (isBrowserPanel(panel)) return panel;
  if (isDevPreviewPanel(panel)) return panel;
  if (isReviewPanel(panel)) return panel;
  if (isPtyPanel(panel)) return panel;
  return undefined;
}

let _prevNarrowById: Record<string, PanelInstance> | null = null;
let _prevNarrowIds: string[] | null = null;
let _prevNarrowResult: PanelInstance[] | null = null;

/**
 * Adapter selector: narrow an ordered list of carrier entries to
 * `PanelInstance[]`, preserving order and skipping absent ids. Memoized on the
 * `panelsById`/`panelIds` identities (same pattern as `selectOrderedTerminals`)
 * so repeated calls in React render paths return a stable array reference.
 */
export function getNarrowPanels(
  panelsById: Record<string, PanelInstance>,
  panelIds: string[]
): PanelInstance[] {
  if (panelsById === _prevNarrowById && panelIds === _prevNarrowIds && _prevNarrowResult) {
    return _prevNarrowResult;
  }
  _prevNarrowById = panelsById;
  _prevNarrowIds = panelIds;
  _prevNarrowResult = panelIds
    .map((id) => getNarrowPanel(panelsById, id))
    .filter((p): p is PanelInstance => p !== undefined);
  return _prevNarrowResult;
}

export function _resetSelectorCacheForTests(): void {
  _prevById = null;
  _prevIds = null;
  _prevResult = null;
  _prevNarrowById = null;
  _prevNarrowIds = null;
  _prevNarrowResult = null;
}
