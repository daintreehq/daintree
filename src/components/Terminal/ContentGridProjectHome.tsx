import { useEffect } from "react";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";
import { ProjectPluginTrustBanner } from "@/components/Plugin/ProjectPluginTrustBanner";
import { ProjectSurfaceFrame } from "@/components/Plugin/ProjectSurfaceFrame";
import { ProjectSurfaceView } from "@/components/Plugin/ProjectSurfaceView";
import { SurfacePaletteAction } from "@/components/Plugin/SurfacePaletteAction";
import { ProjectPresentationNotice } from "@/components/Project/ProjectPresentationNotice";
import { ProjectThemeNotice } from "@/components/Project/ProjectThemeNotice";
import { ProjectLayoutSeedNotice } from "@/components/Plugin/ProjectLayoutSeedNotice";
import { cn } from "@/lib/utils";
import { useProjectHomeStore } from "@/store/projectHomeStore";
import { BatchScrollbackRestoreBar } from "./BatchScrollbackRestoreBar";
import { GridNotificationBar } from "./GridNotificationBar";
import { TerminalCountWarning } from "./TerminalCountWarning";

/**
 * The main area on a project plugin's Home (`contributes.surfaces.projectHome`,
 * §7.8): the grid's own banner stack, then the plugin's view in the slot's
 * shared frame, which carries the consent question and the switch to having no
 * Home. The banners stay because a project left on Home can sit there for a
 * whole session, and a restore failure or a terminal-count warning still needs
 * its way to act.
 *
 * Alone, a branch of `ContentGrid` like a maximize, not an overlay on the
 * grid: the grid unmounts and its terminals park offscreen through the same
 * `TerminalInstanceService.detach` a maximize or a worktree switch uses, so
 * nothing on the grid keeps painting or taking keys behind Home.
 *
 * `beside` is the split (#14107): Home shares the main area with the grid, so
 * the grid keeps its banners, its macro-focus region and its focused panel, and
 * this is only the application's labelled region. The same element either way,
 * so moving between Home and the split never remounts the plugin's view.
 */
export function ContentGridProjectHome({
  config,
  beside = false,
  isMacroFocused,
  bindGridRegion,
  className,
}: {
  config: PanelKindConfig;
  beside?: boolean;
  isMacroFocused: boolean;
  bindGridRegion: (node: HTMLDivElement | null) => void;
  className?: string;
}) {
  "use memo";

  // While Home fills the area, the focused grid panel is not on screen, so a
  // notice it raises must not be swallowed as if the user were looking at it.
  // Beside the grid it is on screen, and routes like any visible panel.
  const setPresented = useProjectHomeStore((s) => s.setPresented);
  useEffect(() => {
    if (beside) return;
    setPresented(true);
    return () => setPresented(false);
  }, [beside, setPresented]);

  const fillsArea = !beside;

  return (
    <div
      ref={fillsArea ? bindGridRegion : undefined}
      role="region"
      tabIndex={-1}
      aria-label="Project home"
      data-macro-focus={fillsArea && isMacroFocused ? "true" : undefined}
      data-beside-grid={beside ? "true" : undefined}
      data-testid="project-home"
      className={cn(
        "h-full flex flex-col bg-surface-canvas outline-hidden",
        "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-border-default data-[macro-focus=true]:ring-inset",
        className
      )}
    >
      {/* Beside the grid these are the grid's own, drawn once over its panels. */}
      {fillsArea && <GridNotificationBar className="mx-1 mt-1 shrink-0" />}
      {fillsArea && <ProjectPluginTrustBanner />}
      {fillsArea && <ProjectPresentationNotice />}
      {fillsArea && <ProjectThemeNotice />}
      {fillsArea && <ProjectLayoutSeedNotice />}
      {fillsArea && <TerminalCountWarning className="mx-1 mt-1 shrink-0" />}
      {fillsArea && <BatchScrollbackRestoreBar className="mx-1 mt-1 shrink-0" />}
      <div className="relative min-h-0 flex-1">
        <ProjectSurfaceFrame slot="projectHome" surfaceActions={<SurfacePaletteAction />}>
          <ProjectSurfaceView config={config} />
        </ProjectSurfaceFrame>
      </div>
    </div>
  );
}
