import type { KeyboardEvent } from "react";
import type { PluginCanopyHostedViewDescriptor } from "@shared/types/plugin";
import { resolvePluginIcon } from "@/components/icons/pluginIconRegistry";
import { SectionBar } from "./CanopySectionBar";
import { canopyPluginRowDomId } from "./canopyPluginViews";

const LABEL_ID = "canopy-plugins-label";

/**
 * The plugin views the window offers, under the inbox. Choosing one fills the
 * pane with it; focus alone doesn't, since showing a view starts its plugin.
 * Its own list for the keyboard: the inbox's arrows never walk into it.
 */
export function CanopyPluginSection({
  views,
  shownId,
  onShow,
}: {
  views: readonly PluginCanopyHostedViewDescriptor[];
  shownId: string | null;
  onShow: (viewId: string) => void;
}) {
  const tabbableId = views.some((view) => view.id === shownId) ? shownId : (views[0]?.id ?? null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onShow(views[index]!.id);
      return;
    }
    const target =
      event.key === "ArrowDown"
        ? Math.min(index + 1, views.length - 1)
        : event.key === "ArrowUp"
          ? Math.max(index - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? views.length - 1
              : null;
    if (target === null) return;
    event.preventDefault();
    document.getElementById(canopyPluginRowDomId(views[target]!.id))?.focus();
  };
  return (
    <div
      className="max-h-[40%] shrink-0 overflow-y-auto border-t border-divider"
      data-canopy-plugins=""
    >
      <SectionBar id={LABEL_ID} label="Plugins" />
      <div role="listbox" aria-labelledby={LABEL_ID}>
        {views.map((view, index) => {
          const Icon = resolvePluginIcon(view.iconId);
          const shown = view.id === shownId;
          return (
            <div
              key={view.id}
              id={canopyPluginRowDomId(view.id)}
              role="option"
              aria-selected={shown}
              tabIndex={view.id === tabbableId ? 0 : -1}
              data-canopy-plugin-row=""
              onClick={() => onShow(view.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className="canopy-inbox-row flex w-full shrink-0 cursor-pointer items-center gap-3 px-3 py-2 text-left"
            >
              <Icon aria-hidden="true" className="size-4 shrink-0 text-text-secondary" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm leading-5 text-text-primary">{view.title}</span>
                <span className="truncate text-xs leading-4 text-text-secondary">
                  {view.pluginName}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
