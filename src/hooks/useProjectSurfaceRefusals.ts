import { useEffect } from "react";
import {
  pluginManifestIdFromInstanceKey,
  projectSurfaceSlotDescriptor,
  type ProjectSurfaceRefusal,
} from "@shared/types/plugin";
import {
  selectSurfaceRefusals,
  usePluginProjectSurfacesStore,
} from "@/store/pluginProjectSurfacesStore";

/** A refusal in words: a short headline and the reason under it. */
export interface SurfaceRefusalCopy {
  title: string;
  detail: string;
}

/**
 * Why a plugin's slot claim isn't showing, worded the same everywhere it is
 * disclosed. `nameOf` turns an instance key into the name the user knows the
 * plugin by.
 */
export function describeSurfaceRefusal(
  refusal: ProjectSurfaceRefusal,
  nameOf: (pluginId: string) => string
): SurfaceRefusalCopy {
  const { label, claim } = projectSurfaceSlotDescriptor(refusal.slot);
  const title = `${label} not shown`;
  switch (refusal.reason) {
    case "outranked": {
      const holder = refusal.heldBy === undefined ? "Another plugin" : nameOf(refusal.heldBy);
      return {
        title,
        detail: `${holder} also claims it in this project, and only one plugin can. ${holder} keeps it because its plugin id sorts first.`,
      };
    }
    case "installed-exclusive":
      return { title, detail: "Only a project's own plugins can replace it" };
    case "claim-kind":
      return {
        title,
        detail: `It takes ${claim === "view" ? "a view" : "data"}, and the plugin's claim carries ${claim === "view" ? "data" : "a view"}`,
      };
    case "unresolved-view":
      return {
        title,
        detail: "The view it names didn't register anything Daintree can show",
      };
  }
}

/**
 * The refused slot claims of one plugin (by INSTANCE key) in this view's
 * project. Starts the slot store if nothing on screen has yet, so a settings
 * pane opened on its own still learns about them.
 */
export function useProjectSurfaceRefusals(pluginId: string | undefined): ProjectSurfaceRefusal[] {
  const init = usePluginProjectSurfacesStore((s) => s.init);
  const slots = usePluginProjectSurfacesStore((s) => s.slots);

  useEffect(() => {
    init();
  }, [init]);

  return selectSurfaceRefusals(slots, pluginId);
}

/** The fallback name for a plugin the caller can't put a display name to. */
export function surfacePluginFallbackName(pluginId: string): string {
  return pluginManifestIdFromInstanceKey(pluginId);
}
