import { useSyncExternalStore, type ReactNode } from "react";
import { Puzzle, Search } from "lucide-react";
import {
  getPanelKindRegistrySnapshot,
  subscribeToPanelKindRegistry,
} from "@shared/config/panelKindRegistry";
import type { ProjectSurfaceChoice } from "@shared/types/plugin";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Button } from "@/components/ui/button";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { SurfaceHeader } from "@/components/ui/SurfaceHeader";
import { actionService } from "@/services/ActionService";
import {
  selectSurfaceChoice,
  usePluginProjectSurfacesStore,
} from "@/store/pluginProjectSurfacesStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";

/**
 * Wraps the content grid's empty region so a project plugin's `emptyCanvas`
 * surface reads as the project's empty canvas and can never become a dead end.
 *
 * On its own a claimed surface looks like one more panel — even to the person
 * who wrote the manifest. So the host keeps a strip of its own chrome above the
 * region: the plugin's panel name and "No panels open" say what the region is,
 * the launcher's palette entry keeps the "start something" action, and a switch
 * moves between the plugin's surface and the stock launcher in both directions.
 *
 * The strip sits ABOVE the region, in flow, never floated over it. Plugins draw
 * their own toolbars, most often top-right, and a control pinned into that
 * corner got painted over by exactly that. Out of the plugin's box, no plugin
 * layout can reach it and no author has to reserve room for it.
 *
 * The first time a claim would show in a project, a notice names the plugin and
 * asks whether to keep it. Any answer — the notice's or the switch's — is
 * remembered per project in Daintree's own store and disclosed in project
 * plugin settings, so the notice fires once.
 *
 * A passthrough when no `emptyCanvas` claim exists, which is most projects: no
 * wrapper element, no strip, nothing to lay out around.
 */
export function ProjectSurfaceFrame({ children }: { children: ReactNode }) {
  const claim = usePluginProjectSurfacesStore((s) => s.surfaces.emptyCanvas);
  const choice = usePluginProjectSurfacesStore((s) => selectSurfaceChoice(s, "emptyCanvas"));
  const choicesLoaded = usePluginProjectSurfacesStore((s) => s.choicesLoaded);
  const setSurfaceChoice = usePluginProjectSurfacesStore((s) => s.setSurfaceChoice);
  const pluginDisplayName = useProjectPluginStore(
    (s) => s.plugins.find((p) => p.instanceId === claim?.pluginId)?.displayName
  );
  const registry = useSyncExternalStore(
    subscribeToPanelKindRegistry,
    getPanelKindRegistrySnapshot,
    getPanelKindRegistrySnapshot
  );

  const config = claim === undefined ? undefined : registry[claim.panelKindId];
  // Same resolvability test `useProjectSurface` applies. Without it the switch
  // would offer a surface that cannot render, and the user would press it and
  // see nothing change.
  if (config === undefined || config.componentPath === undefined) {
    return <>{children}</>;
  }

  // Unanswered means the manifest's own intent: the surface shows.
  const showing: ProjectSurfaceChoice = choice ?? "surface";
  const choose = (next: ProjectSurfaceChoice) => {
    void setSurfaceChoice("emptyCanvas", next);
  };

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col">
      <SurfaceHeader
        density="compact"
        role="group"
        aria-label="Empty canvas"
        className="gap-3 px-2"
        data-testid="project-surface-strip"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <SegmentedToggle
            options={[
              { value: "surface", label: config.name },
              { value: "stock", label: "Launcher" },
            ]}
            value={showing}
            onChange={choose}
          />
          <span className="truncate text-xs text-text-secondary">No panels open</span>
        </div>
        {/* The stock launcher carries this same entry as its anchor, so the strip
            only repeats it while the plugin's surface is standing in for it. */}
        {showing === "surface" && (
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0"
            onClick={() => {
              void actionService.dispatch("panel.palette", undefined, { source: "user" });
            }}
          >
            <Search aria-hidden="true" />
            Search agents &amp; panels…
          </Button>
        )}
      </SurfaceHeader>
      {/* Gated on the answers having loaded, so a project that answered long ago
          never flashes the question while the read is in flight. */}
      {choicesLoaded && choice === null && (
        <div className="shrink-0 px-2 pt-2">
          <InlineStatusBanner
            icon={Puzzle}
            title={`${pluginDisplayName ?? config.name} replaced the launcher`}
            description="This project's plugin draws the canvas when no panels are open. You can switch back any time from the strip above."
            descriptionExtras={
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => choose("surface")}>
                  Keep it
                </Button>
                <Button size="sm" variant="ghost" onClick={() => choose("stock")}>
                  Use the launcher
                </Button>
              </div>
            }
            severity="neutral"
            role="status"
            className="mx-auto w-full max-w-2xl rounded-lg border border-border-default bg-surface-panel"
          />
        </div>
      )}
      <div className="relative min-h-0 min-w-0 flex-1" data-testid="project-surface-region">
        {children}
      </div>
    </div>
  );
}
