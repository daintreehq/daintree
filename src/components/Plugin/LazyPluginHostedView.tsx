import type { ComponentProps } from "react";
import type { PluginHostedView } from "@/components/Plugin/PluginHostedView";
import { PluginViewLoadError } from "@/components/Plugin/PluginViewLoadError";
import {
  PLUGIN_HOSTED_VIEW_BOX_CLASS,
  PLUGIN_HOSTED_VIEW_BOX_STYLE,
} from "@/components/Plugin/pluginHostedViewBox";
import { lazyWithPreload, usePreloadedComponent } from "@/lib/lazyWithPreload";
import { cn } from "@/lib/utils";

type PluginHostedViewProps = ComponentProps<typeof PluginHostedView>;

const PreloadablePluginHostedView = lazyWithPreload(
  () => import("@/components/Plugin/PluginHostedView"),
  (m) => m.PluginHostedView
);

/** Start loading the hosted-view chunk ahead of a mount that will need it. */
export const preloadPluginHostedView = PreloadablePluginHostedView.preload;

/**
 * `PluginHostedView` for hosts on the first-render path — the sidebar, a
 * project surface, the toolbar popover — so its chunk (the whole plugin-view
 * loader) stays off cold boot until a plugin view is actually shown (#16802).
 *
 * Until the chunk lands it draws the view's own empty box, then the real view
 * in its place; once loaded, every later mount renders in its first commit.
 * Not through Suspense: its fallback would hold the reveal back for React's
 * 300ms throttle on every first open. A chunk that fails to load is reported
 * inside the box, where the host's own way out (the sidebar's switcher, the
 * surface's strip, the popover's dismissal) still reaches it.
 */
export function LazyPluginHostedView(props: PluginHostedViewProps) {
  const load = usePreloadedComponent(PreloadablePluginHostedView);
  if (load.status === "ready") return <PreloadablePluginHostedView {...props} />;
  const { source } = props;
  return (
    <div
      className={cn(PLUGIN_HOSTED_VIEW_BOX_CLASS, props.className)}
      style={PLUGIN_HOSTED_VIEW_BOX_STYLE}
      data-testid={props.testId}
    >
      {load.status === "failed" && (
        <PluginViewLoadError
          pluginId={(source.from === "hosted" ? source.view.pluginId : source.config.extensionId) ?? ""}
          displayName={source.from === "hosted" ? source.view.name : source.config.name}
          message="Daintree couldn't load its plugin view host. Restart Daintree to try again."
          diagnostic={String(load.error)}
        />
      )}
    </div>
  );
}
