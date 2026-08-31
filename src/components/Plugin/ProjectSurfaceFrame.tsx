import { useSyncExternalStore, type ReactNode } from "react";
import {
  getPanelKindRegistrySnapshot,
  subscribeToPanelKindRegistry,
} from "@shared/config/panelKindRegistry";
import { Button } from "@/components/ui/button";
import { usePluginProjectSurfacesStore } from "@/store/pluginProjectSurfacesStore";

/**
 * Wraps the content grid's empty region so a project plugin's `emptyCanvas`
 * surface can never become a dead end.
 *
 * A surface claim REPLACES what the host draws, and the empty canvas is where
 * the launcher lives — so the replacement has to stay reversible from the
 * surface itself. This renders one control that swaps between the plugin's
 * surface and the host's own launcher, in both directions, so the stock canvas
 * is always one click away and the surface is always one click back.
 *
 * A passthrough when no `emptyCanvas` claim exists, which is every project
 * today: no wrapper element, no control, nothing to lay out around. The whole
 * component costs one store read in that case.
 */
export function ProjectSurfaceFrame({ children }: { children: ReactNode }) {
  const claim = usePluginProjectSurfacesStore((s) => s.surfaces.emptyCanvas);
  const pinned = usePluginProjectSurfacesStore((s) => s.stockCanvasPinned);
  const setStockCanvasPinned = usePluginProjectSurfacesStore((s) => s.setStockCanvasPinned);
  const registry = useSyncExternalStore(
    subscribeToPanelKindRegistry,
    getPanelKindRegistrySnapshot,
    getPanelKindRegistrySnapshot
  );

  const config = claim === undefined ? undefined : registry[claim.panelKindId];
  // Same resolvability test `useProjectSurface` applies. Without it the control
  // would offer to switch to a surface that cannot render, and the user would
  // press it and see nothing change.
  if (config === undefined || config.componentPath === undefined) {
    return <>{children}</>;
  }

  return (
    <div className="relative h-full w-full min-h-0 min-w-0">
      {children}
      {/*
        Pinned to the corner rather than placed in flow: the surface owns the
        whole region, so there is no layout to insert into, and a plugin cannot
        be relied on to leave room. `pointer-events-none` on the positioning
        layer keeps the rest of the corner clickable by the surface underneath.
        No accent — this is a way back, not a call to action.
      */}
      <div className="pointer-events-none absolute right-2 top-2 z-10">
        <Button
          variant="ghost"
          size="xs"
          className="pointer-events-auto"
          onClick={() => setStockCanvasPinned(!pinned)}
        >
          {pinned ? config.name : "Launcher"}
        </Button>
      </div>
    </div>
  );
}
