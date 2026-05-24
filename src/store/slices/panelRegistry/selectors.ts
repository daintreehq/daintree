import {
  isBrowserPanel,
  isDevPreviewPanel,
  isPtyPanel,
  isReviewPanel,
  type PanelInstance,
} from "@shared/types/panel";
import type { TerminalInstance } from "./types";

let _prevById: Record<string, TerminalInstance> | null = null;
let _prevIds: string[] | null = null;
let _prevResult: TerminalInstance[] | null = null;

export function selectOrderedTerminals(
  panelsById: Record<string, TerminalInstance>,
  panelIds: string[]
): TerminalInstance[] {
  if (panelsById === _prevById && panelIds === _prevIds && _prevResult) {
    return _prevResult;
  }
  _prevById = panelsById;
  _prevIds = panelIds;
  _prevResult = panelIds
    .map((id) => panelsById[id])
    .filter((t): t is TerminalInstance => Boolean(t));
  return _prevResult;
}

/**
 * Adapter selector: narrow a single carrier entry to the `PanelInstance`
 * discriminated union. The carrier is still typed `Record<string, TerminalInstance>`
 * (#8957 drains that incrementally); this is the sanctioned read path for new
 * code that wants the narrow union instead of the kitchen-sink interface.
 *
 * Uses the existing kind type guards (which default a missing `kind` to
 * "terminal"), so a no-`kind` legacy record narrows to `PtyPanelData` — no
 * blanket `as unknown as PanelInstance` cast.
 *
 * Returns `undefined` for an absent id and for any panel whose `kind` is
 * outside the built-in union (e.g. an extension/plugin kind); such panels are
 * intentionally not representable by `PanelInstance` and are dropped here.
 */
export function getNarrowPanel(
  panelsById: Record<string, TerminalInstance>,
  id: string
): PanelInstance | undefined {
  const panel = panelsById[id];
  if (!panel) return undefined;
  if (isBrowserPanel(panel)) return panel;
  if (isDevPreviewPanel(panel)) return panel;
  if (isReviewPanel(panel)) return panel;
  if (isPtyPanel(panel)) {
    // The guard defaults an absent `kind` to "terminal", so a legacy no-`kind`
    // record lands here. Backfill the literal discriminant when it's missing so
    // the returned `PtyPanelData` is sound for downstream `switch (kind)`;
    // preserve object identity when the panel already carries it.
    return panel.kind === "terminal" ? panel : { ...panel, kind: "terminal" };
  }
  return undefined;
}

let _prevNarrowById: Record<string, TerminalInstance> | null = null;
let _prevNarrowIds: string[] | null = null;
let _prevNarrowResult: PanelInstance[] | null = null;

/**
 * Adapter selector: narrow an ordered list of carrier entries to
 * `PanelInstance[]`, preserving order and skipping absent ids. Memoized on the
 * `panelsById`/`panelIds` identities (same pattern as `selectOrderedTerminals`)
 * so repeated calls in React render paths return a stable array reference.
 */
export function getNarrowPanels(
  panelsById: Record<string, TerminalInstance>,
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
