import { lazy, Suspense } from "react";
import type { PluginViewRuntimeStatusProps } from "@/components/Plugin/PluginViewRuntimeBanner";

/**
 * Loaded only once a panel actually has something to report (#12278).
 *
 * `InlineStatusBanner` pulls the tooltip and window-chrome graph in behind it,
 * and this layer sits inside EVERY plugin panel — so a static import would put
 * that graph on the first-render path of every healthy panel that will never
 * show a banner. It also drags it into suites that deliberately mount the
 * content layer without any of that chrome, which is a documented property of
 * `PluginViewContent` rather than an accident.
 */
const PluginViewRuntimeBanner = lazy(() =>
  import("@/components/Plugin/PluginViewRuntimeBanner").then((m) => ({
    default: m.PluginViewRuntimeBanner,
  }))
);

/**
 * The host-owned half of a plugin panel: what the shell draws when the plugin's
 * backend, rather than its view, is the thing that went wrong (#12278).
 *
 * Rendered OUTSIDE the plugin's ErrorBoundary and Suspense, and outside its
 * style root, so a crashed backend can't take its own error report down with it
 * and a plugin's stylesheet can't restyle the control that recovers from it.
 */
export function PluginViewRuntimeStatus(props: PluginViewRuntimeStatusProps) {
  // The overwhelmingly common case, and the one that has to cost nothing: no
  // chunk is requested until a panel genuinely has something to say.
  if (props.presentation.kind === "content") return null;
  return (
    // `null` while the chunk loads. This reports a state whose consequences the
    // user is already looking at, so a skeleton for the report itself would be
    // noise stacked on noise.
    <Suspense fallback={null}>
      <PluginViewRuntimeBanner {...props} />
    </Suspense>
  );
}
