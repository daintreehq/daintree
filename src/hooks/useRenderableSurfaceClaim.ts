import { useSyncExternalStore } from "react";
import {
  getPanelKindRegistrySnapshot,
  subscribeToPanelKindRegistry,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";
import type { ProjectSurfaceClaim, ProjectSurfaceSlot } from "@shared/types/plugin";
import { usePluginProjectSurfacesStore } from "@/store/pluginProjectSurfacesStore";

/** A surface claim that can render: its owner plus the panel kind whose module it mounts. */
export interface RenderableSurfaceClaim {
  claim: ProjectSurfaceClaim;
  config: PanelKindConfig;
}

/**
 * The claim on `slot` in this project view, once it can actually render.
 * `null` while there is no claim, its panel kind has not registered here yet, or
 * the kind carries no `componentPath` (a PTY panel, or a view the panels loop
 * skipped) — a surface mounts a module, and there is nothing to mount without
 * one.
 *
 * The one resolvability test for every surface consumer. The resolver, the
 * canvas strip and the settings disclosure all ask it, so none of them can
 * offer or describe a surface the others would refuse to draw. It ignores the
 * user's answer; `useProjectSurface` applies that.
 *
 * The registry is read through `useSyncExternalStore` rather than a bare
 * `getPanelKindConfig` because the two facts arrive on independent round trips:
 * the surfaces pull and `usePluginPanelKinds`' own pull/push. Whichever lands
 * second must re-render, or a project whose kinds arrived last would sit on
 * stock content with a claim it never applied.
 */
export function useRenderableSurfaceClaim(slot: ProjectSurfaceSlot): RenderableSurfaceClaim | null {
  const claim = usePluginProjectSurfacesStore((s) => s.surfaces[slot]);
  const registry = useSyncExternalStore(
    subscribeToPanelKindRegistry,
    getPanelKindRegistrySnapshot,
    getPanelKindRegistrySnapshot
  );
  if (claim === undefined) return null;
  const config = registry[claim.panelKindId];
  if (config === undefined || config.componentPath === undefined) return null;
  return { claim, config };
}
