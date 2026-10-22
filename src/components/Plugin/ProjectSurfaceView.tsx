import { useEffect } from "react";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";
import type { ProjectSurfaceSlot } from "@shared/types/plugin";
import { PluginHostedView } from "@/components/Plugin/PluginHostedView";
import {
  useRenderableSurfaceClaim,
  type RenderableSurfaceClaim,
} from "@/hooks/useRenderableSurfaceClaim";
import {
  selectSurfaceChoice,
  usePluginProjectSurfacesStore,
} from "@/store/pluginProjectSurfacesStore";

/**
 * A resolved surface claim: the slot's owner plus the panel-kind metadata its
 * view renders from. `null` while the claim is absent, suppressed, or not yet
 * resolvable — every one of which means "draw the stock surface".
 */
export type ResolvedProjectSurface = RenderableSurfaceClaim;

/**
 * Resolve one surface slot for this project view.
 *
 * Returns `null` when the user chose the stock content for this slot: that
 * answer is what guarantees a plugin can never take the host's own launcher
 * away, so it is checked here rather than at each call site, where it could be
 * forgotten. It is read live, at resolution, so an unloaded plugin's slot is
 * released whatever answer is on record.
 *
 * Also `null` until the answers are known. They arrive in the same pull as the
 * claim, so this costs nothing when the read works — and when it fails, the
 * host's own canvas is the safe side to wait on, where mounting a plugin's view
 * in a project that chose the launcher is not.
 */
export function useProjectSurface(slot: ProjectSurfaceSlot): ResolvedProjectSurface | null {
  const init = usePluginProjectSurfacesStore((s) => s.init);
  // In an effect, not during render: `init` sets store state on the pull's
  // resolution, and the first call must not run inside the render that reads it.
  useEffect(() => {
    init();
  }, [init]);
  const renderable = useRenderableSurfaceClaim(slot);
  const choicesLoaded = usePluginProjectSurfacesStore((s) => s.choicesLoaded);
  const choice = usePluginProjectSurfacesStore((s) => selectSurfaceChoice(s, slot));
  if (renderable === null || !choicesLoaded || choice === "stock") return null;
  return renderable;
}

/**
 * Mount a project surface's view through the shared hosted-view path
 * (`PluginHostedView`), as `hostContext: "surface"`.
 *
 * The claimed view is one of the plugin's panel views, so its source is the
 * panel kind itself — the same loader, activation, error boundary and working
 * "Try again" the panel gets, with the kind's own teardown — and the kind stays
 * spawnable as a panel on purpose. Retired when the kind leaves the registry or
 * moves to a new module, which for a surface is permanent removal; the surface
 * unmounting whenever the user opens a panel is not.
 *
 * `mountId` is synthesized from the kind: a surface is not a panel instance,
 * but the view contract takes an opaque panel id, and one stable per kind keeps
 * it meaningful for plugin-local storage keys across re-renders.
 *
 * No `onRequestClose`: a surface has no panel to trash. The way out of a broken
 * surface is the switch in `ProjectSurfaceFrame`'s strip, laid out above this
 * box, which the shared host's containment keeps the plugin from painting over.
 */
export function ProjectSurfaceView({
  config,
  onClose,
}: {
  config: PanelKindConfig;
  /** Handed to the view as `hostContext.close`, for a slot the view can finish, like a dialog. */
  onClose?: () => void;
}) {
  return (
    <PluginHostedView
      source={{ from: "panel-kind", config }}
      host="surface"
      mountId={`surface:${config.id}`}
      onClose={onClose}
      className="h-full w-full"
    />
  );
}
