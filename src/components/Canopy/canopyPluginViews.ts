import { useMemo } from "react";
import type {
  PluginCanopyHostedViewDescriptor,
  PluginHostedViewDescriptor,
} from "@shared/types/plugin";
import { usePluginHostedViewsStore } from "@/store/pluginHostedViewsStore";
import { useCanopyFrame } from "./canopyFrame";

const NO_PLUGIN_VIEWS: readonly PluginCanopyHostedViewDescriptor[] = [];

/**
 * The plugin views Canopy lists, in a fixed order: by title, then by the
 * plugin that offers it, so a plugin loading late never reorders the others.
 */
export function canopyPluginViews(
  views: readonly PluginHostedViewDescriptor[] | null
): readonly PluginCanopyHostedViewDescriptor[] {
  if (views === null) return NO_PLUGIN_VIEWS;
  const listed = views.filter(
    (view): view is PluginCanopyHostedViewDescriptor => view.location === "canopy"
  );
  if (listed.length === 0) return NO_PLUGIN_VIEWS;
  return listed.sort(
    (a, b) =>
      a.title.localeCompare(b.title) ||
      a.pluginName.localeCompare(b.pluginName) ||
      a.id.localeCompare(b.id)
  );
}

/**
 * What the Canopy window offers of its app-wide plugins. The dialog in a
 * project window offers none: that window has its project's panels, and a view
 * there would follow that project rather than stand for none.
 */
export function useCanopyPluginViews(): readonly PluginCanopyHostedViewDescriptor[] {
  const standalone = useCanopyFrame().host === "standalone";
  const views = usePluginHostedViewsStore((state) => state.views);
  return useMemo(
    () => (standalone ? canopyPluginViews(views) : NO_PLUGIN_VIEWS),
    [standalone, views]
  );
}

export function canopyPluginRowDomId(viewId: string): string {
  return `canopy-plugin-${viewId}`;
}
