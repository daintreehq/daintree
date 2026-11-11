import type { CSSProperties } from "react";

/**
 * The box a hosted plugin view is drawn in, shared with the placeholder that
 * holds its place while the hosted-view chunk loads, so the swap never moves
 * the layout around it.
 *
 * `isolate` caps the view's z-indexes in its own stacking context, and
 * `contain: layout paint` with overflow clipping keeps a `position: fixed`
 * descendant inside, so no view can paint over the host chrome around it. A
 * flex COLUMN, because the loader fills its host with `flex-1 min-h-0`, which
 * is inert outside a flex container (#12361).
 */
export const PLUGIN_HOSTED_VIEW_BOX_CLASS =
  "relative isolate flex min-h-0 min-w-0 flex-col overflow-hidden";

export const PLUGIN_HOSTED_VIEW_BOX_STYLE: CSSProperties = { contain: "layout paint" };
