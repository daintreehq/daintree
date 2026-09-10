import { useRef, type MouseEvent, type ReactNode } from "react";
import { AlertCircle, Puzzle, Search } from "lucide-react";
import type { ProjectSurfaceChoice } from "@shared/types/plugin";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Button } from "@/components/ui/button";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { SurfaceHeader } from "@/components/ui/SurfaceHeader";
import { useRenderableSurfaceClaim } from "@/hooks/useRenderableSurfaceClaim";
import { actionService } from "@/services/ActionService";
import {
  selectSurfaceChoice,
  usePluginProjectSurfacesStore,
} from "@/store/pluginProjectSurfacesStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";

/**
 * A manifest's panel name has no length cap, and the switch cannot shrink: an
 * uncapped name could push the Launcher segment — the way back — out of a
 * narrow canvas.
 */
const PANEL_LABEL_MAX_CHARS = 32;

function capLabel(name: string): string {
  const chars = Array.from(name);
  return chars.length > PANEL_LABEL_MAX_CHARS
    ? `${chars.slice(0, PANEL_LABEL_MAX_CHARS - 1).join("").trimEnd()}…`
    : name;
}

/** Position of each answer's segment in the strip, which is how focus finds it. */
const SEGMENT_INDEX: Record<ProjectSurfaceChoice, number> = { surface: 0, stock: 1 };

/**
 * Wraps the content grid's empty region so a project plugin's `emptyCanvas`
 * surface reads as the project's empty canvas and can never become a dead end.
 *
 * On its own a claimed surface looks like one more panel — even to the person
 * who wrote the manifest. So the host keeps a strip of its own chrome above the
 * region: a switch naming the plugin's panel and the stock launcher, and while
 * the surface shows, "No panels open" and the launcher's palette entry, so the
 * region still says nothing is open and still offers a way to start something.
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
  const renderable = useRenderableSurfaceClaim("emptyCanvas");
  const choicesLoaded = usePluginProjectSurfacesStore((s) => s.choicesLoaded);
  const choice = usePluginProjectSurfacesStore((s) => selectSurfaceChoice(s, "emptyCanvas"));
  const failedSave = usePluginProjectSurfacesStore((s) =>
    s.failedSave?.slot === "emptyCanvas" ? s.failedSave : null
  );
  const setSurfaceChoice = usePluginProjectSurfacesStore((s) => s.setSurfaceChoice);
  const dismissFailedSave = usePluginProjectSurfacesStore((s) => s.dismissFailedSave);
  const claimPluginId = renderable?.claim.pluginId;
  const pluginDisplayName = useProjectPluginStore(
    (s) => s.plugins.find((p) => p.instanceId === claimPluginId)?.displayName
  );
  const stripRef = useRef<HTMLDivElement>(null);

  // `useProjectSurface`'s own test. Without it the strip could offer a surface
  // the region will not draw, or show it pressed while the stock canvas is what
  // is actually on screen.
  if (renderable === null || !choicesLoaded) {
    return <>{children}</>;
  }

  const { config } = renderable;
  // Unanswered means the manifest's own intent: the surface shows.
  const showing: ProjectSurfaceChoice = choice ?? "surface";
  const choose = (next: ProjectSurfaceChoice) => {
    // Pressing the segment already showing changes nothing, so it answers
    // nothing either — least of all the first-show question, silently.
    if (next === showing) return;
    void setSurfaceChoice("emptyCanvas", next);
  };
  const answer = async (next: ProjectSurfaceChoice, event: MouseEvent<HTMLButtonElement>) => {
    // A keyboard press is a synthetic click with no detail; only it earns a ring.
    const viaKeyboard = event.detail === 0;
    await setSurfaceChoice("emptyCanvas", next);
    // The pressed button leaves with the notice, and focus left on the body
    // strands a keyboard user. The switch's segments never unmount, so the one
    // now showing is a stable place to land.
    const now =
      selectSurfaceChoice(usePluginProjectSurfacesStore.getState(), "emptyCanvas") ?? "surface";
    stripRef.current
      ?.querySelectorAll<HTMLButtonElement>("button")
      [SEGMENT_INDEX[now]]?.focus({ preventScroll: true, focusVisible: viaKeyboard });
  };
  const panelLabel = capLabel(config.name);

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col" data-testid="project-surface-frame">
      <SurfaceHeader
        ref={stripRef}
        density="compact"
        role="group"
        aria-label="Empty canvas"
        className="gap-3 px-2"
        data-testid="project-surface-strip"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <SegmentedToggle
            options={[
              {
                value: "surface",
                label: panelLabel,
                ariaLabel: panelLabel === config.name ? undefined : config.name,
              },
              { value: "stock", label: "Launcher" },
            ]}
            value={showing}
            onChange={choose}
          />
          {showing === "surface" && (
            <span className="truncate text-xs text-text-secondary">No panels open</span>
          )}
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
      {failedSave !== null ? (
        <div className="shrink-0 px-2 pt-2">
          <InlineStatusBanner
            icon={AlertCircle}
            title="Couldn't save the canvas choice"
            description="It couldn't be written to Daintree's settings, so the canvas hasn't changed."
            severity="error"
            action={{
              id: "retry",
              label: "Retry",
              variant: "primary",
              onClick: () => void setSurfaceChoice("emptyCanvas", failedSave.choice),
            }}
            onClose={dismissFailedSave}
            className="mx-auto w-full max-w-2xl"
          />
        </div>
      ) : (
        choice === null && (
          <div className="shrink-0 px-2 pt-2">
            <InlineStatusBanner
              icon={Puzzle}
              title={`${pluginDisplayName ?? config.name} replaced the launcher`}
              description="This project's plugin draws the canvas when no panels are open. You can switch back any time with Launcher above."
              descriptionExtras={
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={(event) => void answer("surface", event)}
                  >
                    Keep it
                  </Button>
                  <Button size="sm" variant="ghost" onClick={(event) => void answer("stock", event)}>
                    Use the launcher
                  </Button>
                </div>
              }
              severity="neutral"
              role="status"
              className="mx-auto w-full max-w-2xl rounded-lg border border-border-default bg-surface-panel"
            />
          </div>
        )
      )}
      <div className="relative min-h-0 min-w-0 flex-1" data-testid="project-surface-region">
        {children}
      </div>
    </div>
  );
}
