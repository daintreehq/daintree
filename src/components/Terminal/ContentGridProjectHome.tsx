import { useEffect } from "react";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";
import { ProjectPluginTrustBanner } from "@/components/Plugin/ProjectPluginTrustBanner";
import { ProjectSurfaceFrame } from "@/components/Plugin/ProjectSurfaceFrame";
import { ProjectSurfaceView } from "@/components/Plugin/ProjectSurfaceView";
import { SurfacePaletteAction } from "@/components/Plugin/SurfacePaletteAction";
import { ProjectPresentationNotice } from "@/components/Project/ProjectPresentationNotice";
import { cn } from "@/lib/utils";
import { useProjectHomeStore } from "@/store/projectHomeStore";
import { GridNotificationBar } from "./GridNotificationBar";

/**
 * The main area on a project plugin's Home (`contributes.surfaces.projectHome`,
 * §7.8): the project's banners, then the plugin's view in the slot's shared
 * frame, which carries the consent question and the switch to having no Home.
 *
 * A branch of `ContentGrid` like a maximize, not an overlay on the grid: the
 * grid unmounts and its terminals park offscreen through the same
 * `TerminalInstanceService.detach` a maximize or a worktree switch uses, so
 * nothing on the grid keeps painting or taking keys behind Home.
 */
export function ContentGridProjectHome({
  config,
  isMacroFocused,
  bindGridRegion,
  className,
}: {
  config: PanelKindConfig;
  isMacroFocused: boolean;
  bindGridRegion: (node: HTMLDivElement | null) => void;
  className?: string;
}) {
  "use memo";

  // While Home is on screen, the focused grid panel is not, so a notice it
  // raises must not be swallowed as if the user were looking at it.
  const setPresented = useProjectHomeStore((s) => s.setPresented);
  useEffect(() => {
    setPresented(true);
    return () => setPresented(false);
  }, [setPresented]);

  return (
    <div
      ref={bindGridRegion}
      role="region"
      tabIndex={-1}
      aria-label="Project home"
      data-macro-focus={isMacroFocused ? "true" : undefined}
      data-testid="project-home"
      className={cn(
        "h-full flex flex-col bg-surface-canvas outline-hidden",
        "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-border-default data-[macro-focus=true]:ring-inset",
        className
      )}
    >
      <GridNotificationBar className="mx-1 mt-1 shrink-0" />
      <ProjectPluginTrustBanner />
      <ProjectPresentationNotice />
      <div className="relative min-h-0 flex-1">
        <ProjectSurfaceFrame slot="projectHome" surfaceActions={<SurfacePaletteAction />}>
          <ProjectSurfaceView config={config} />
        </ProjectSurfaceFrame>
      </div>
    </div>
  );
}
