import {
  isBrowserPanel,
  isBuiltInPanelKind,
  isDevPreviewPanel,
  isPtyPanel,
  isReviewPanel,
  isFilePanel,
  type PanelInstance,
  type PanelKind,
} from "@shared/types/panel";
import { isRegisteredPanelKind } from "@shared/config/panelKindRegistry";

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
  _prevResult = panelIds.map((id) => panelsById[id]).filter((t): t is PanelInstance => Boolean(t));
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
  if (isFilePanel(panel)) return panel;
  if (isPtyPanel(panel)) return panel;
  return undefined;
}

/**
 * Render-eligibility predicate for grid membership: should this carrier entry
 * appear in the user-visible panel grid?
 *
 * Distinct from `getNarrowPanel`, which is the type-narrowing read path for
 * callers that need the built-in `PanelInstance` discriminated union (fleet /
 * terminal queries) and deliberately drops plugin kinds. The grid's
 * membership/emptiness gate needs the broader question — and plugin-contributed
 * kinds ARE renderable: `GridPanel` resolves them to a `PluginViewHost` (when
 * the kind is registered) or a `PluginMissingPanel` placeholder (when the
 * plugin is temporarily disabled). Filtering them out here is exactly the bug
 * behind #10512 (plugin panels silently dropped → grid shows the empty state).
 *
 * Eligible when:
 *  - the kind is built-in (always renderable), OR
 *  - the kind is a registered plugin kind (plugin enabled), OR
 *  - the panel carries a `pluginId` or a dotted kind — the disabled-plugin
 *    escape hatch (#5636): the grid still renders a `PluginMissingPanel`
 *    placeholder rather than vanishing the panel entirely.
 *
 * Sync and side-effect free — safe to call inside Zustand selectors and memos.
 */
export function isPanelRenderEligible(panel: PanelInstance): boolean {
  // Widen to the open `PanelKind`: the carrier types `panel.kind` as only the
  // built-in discriminants, but plugin panels are cast into the carrier with a
  // dotted plugin-kind string at runtime, so the plugin branches below are NOT
  // statically dead — read the kind as the open union to keep them live.
  const kind: PanelKind = panel.kind ?? "terminal";
  return (
    isBuiltInPanelKind(kind) ||
    isRegisteredPanelKind(kind) ||
    Boolean(panel.pluginId) ||
    kind.includes(".")
  );
}

/**
 * Grid-membership read path: return the carrier entry for `id` when it should
 * render in the grid (built-in OR plugin kind), else `undefined`. Mirror of
 * `getNarrowPanel`'s signature so grid list-builders can swap one for the other.
 *
 * Built-in panels are returned via `getNarrowPanel` (already the carrier
 * `PanelInstance`); plugin panels — which `getNarrowPanel` drops — are returned
 * as-is from the carrier (typed `Record<string, PanelInstance>`). `GridPanel`
 * resolves the actual component from the panel-kind definition registry.
 */
export function getRenderablePanel(
  panelsById: Record<string, PanelInstance>,
  id: string
): PanelInstance | undefined {
  const narrowed = getNarrowPanel(panelsById, id);
  if (narrowed) return narrowed;
  const panel = panelsById[id];
  if (!panel) return undefined;
  return isPanelRenderEligible(panel) ? panel : undefined;
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

let _prevSessionLostById: Record<string, PanelInstance> | null = null;
let _prevSessionLostResult = false;

/**
 * True when more than one PTY panel is still carrying an unacknowledged
 * `sessionLostOnRestore` signal — the gate for offering "Dismiss all" on the
 * session-lost banner (issue #11589). Below the threshold the per-pane close
 * control already covers the whole set, so the extra button would be noise.
 *
 * Reads `panelsById` directly rather than an ordered id list: during a
 * hydration/spawn batch the carrier is published before ids are appended, so
 * an id-driven scan can miss freshly restored panels (#9655) — precisely the
 * moment a restart leaves many panes flagged at once.
 *
 * Memoized on the `panelsById` identity (same pattern as
 * `selectOrderedTerminals`) so many flagged panes share one scan per store
 * snapshot, and short-circuits at the second hit.
 */
export function selectHasMultipleSessionLost(panelsById: Record<string, PanelInstance>): boolean {
  if (panelsById === _prevSessionLostById) {
    return _prevSessionLostResult;
  }
  let seen = 0;
  for (const panel of Object.values(panelsById)) {
    if (isPtyPanel(panel) && panel.sessionLostOnRestore) {
      seen += 1;
      if (seen > 1) break;
    }
  }
  _prevSessionLostById = panelsById;
  _prevSessionLostResult = seen > 1;
  return _prevSessionLostResult;
}

export function _resetSelectorCacheForTests(): void {
  _prevById = null;
  _prevIds = null;
  _prevResult = null;
  _prevNarrowById = null;
  _prevNarrowIds = null;
  _prevNarrowResult = null;
  _prevSessionLostById = null;
  _prevSessionLostResult = false;
}
