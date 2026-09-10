import { useRef, type ReactNode } from "react";
import { AlertCircle, Puzzle, Search } from "lucide-react";
import type { ProjectSurfaceChoice } from "@shared/types/plugin";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Button } from "@/components/ui/button";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { SurfaceHeader } from "@/components/ui/SurfaceHeader";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRenderableSurfaceClaim } from "@/hooks/useRenderableSurfaceClaim";
import { actionService } from "@/services/ActionService";
import {
  selectFailedSave,
  selectSurfaceChoice,
  usePluginProjectSurfacesStore,
} from "@/store/pluginProjectSurfacesStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";

/**
 * A manifest's panel name has no length cap, so the strip caps it twice over.
 *
 * This is the coarse half, and it bounds the accessible name and the tooltip as
 * much as the pixels. It cannot be the only half: 32 characters of "WWWW" are
 * not 32 characters of "llll", so a character count alone can never promise the
 * Launcher segment — the way back — still fits. The switch is also allowed to
 * shrink in the strip, which is what actually holds that promise at any width.
 */
const PANEL_LABEL_MAX_CHARS = 32;

function capLabel(name: string): string {
  const chars = Array.from(name);
  return chars.length > PANEL_LABEL_MAX_CHARS
    ? `${chars
        .slice(0, PANEL_LABEL_MAX_CHARS - 1)
        .join("")
        .trimEnd()}…`
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
 * the surface shows, the launcher's palette entry, so the region still offers a
 * way to start something.
 *
 * The strip carries those two things and nothing else. It is 32px of chrome
 * framing a full-bleed view someone else drew, so anything in it is competing
 * with that view for the same glance — which is why the switch is the only thing
 * with a fill, and why the palette entry is an icon rather than the sentence it
 * used to be. A "No panels open" label lived here too and was cut: it was not
 * actionable, it was not a degraded state, and sitting flush against the switch
 * with no separator it read as a third, disabled segment.
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
  const failedSave = usePluginProjectSurfacesStore((s) => selectFailedSave(s, "emptyCanvas"));
  const setSurfaceChoice = usePluginProjectSurfacesStore((s) => s.setSurfaceChoice);
  const dismissFailedSave = usePluginProjectSurfacesStore((s) => s.dismissFailedSave);
  const claimPluginId = renderable?.claim.pluginId;
  const pluginDisplayName = useProjectPluginStore(
    (s) => s.plugins.find((p) => p.instanceId === claimPluginId)?.displayName
  );
  const stripRef = useRef<HTMLDivElement>(null);
  /**
   * Whether the last input that reached this frame was a pointer.
   *
   * A banner action's `onClick` carries no event, so the usual tell — a
   * keyboard press arrives as a synthetic click with `detail === 0` — is not
   * available here. Tracked on the frame instead, in the capture phase so it is
   * already correct by the time the click handler runs. Only a pointer press
   * suppresses the ring; anything else, including the initial render, is
   * treated as keyboard, which is the safe default: a stray ring costs a mouse
   * user nothing, a missing one strands a keyboard user.
   */
  const viaPointerRef = useRef(false);

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
  /**
   * Land focus on the segment now showing.
   *
   * Every control in a notice row destroys its own row by succeeding — an
   * answer, a retry that lands, a dismissal — and focus left on the body strands
   * a keyboard user mid-task. The switch's segments never unmount, so the one
   * now showing is the stable place to put them.
   */
  const restoreFocus = () => {
    const now =
      selectSurfaceChoice(usePluginProjectSurfacesStore.getState(), "emptyCanvas") ?? "surface";
    stripRef.current
      ?.querySelectorAll<HTMLButtonElement>("button")
      [SEGMENT_INDEX[now]]?.focus({ preventScroll: true, focusVisible: !viaPointerRef.current });
  };
  const answer = async (next: ProjectSurfaceChoice) => {
    await setSurfaceChoice("emptyCanvas", next);
    restoreFocus();
  };
  const retryFailedSave = async (next: ProjectSurfaceChoice | null) => {
    await setSurfaceChoice("emptyCanvas", next);
    // Only on success. A retry that fails again leaves the row — and this
    // button — standing, and moving focus off it would be taking the control
    // away at the moment the user most wants to press it a second time.
    if (selectFailedSave(usePluginProjectSurfacesStore.getState(), "emptyCanvas") === null) {
      restoreFocus();
    }
  };
  const panelLabel = capLabel(config.name);

  return (
    <div
      className="flex h-full w-full min-h-0 min-w-0 flex-col"
      data-testid="project-surface-frame"
      onPointerDownCapture={() => {
        viaPointerRef.current = true;
      }}
      onKeyDownCapture={() => {
        viaPointerRef.current = false;
      }}
    >
      <SurfaceHeader
        ref={stripRef}
        density="compact"
        role="group"
        aria-label="Empty canvas"
        className="gap-3 px-2"
        data-testid="project-surface-strip"
      >
        {/* `shrink` AND `min-w-0`, both load-bearing and neither sufficient
            alone: `min-w-0` only lowers the floor a flex item may shrink TO,
            while the control's own `shrink-0` says it never shrinks at all.
            tailwind-merge resolves the pair to the caller's `shrink`, so this
            is the one place the switch is allowed to give way.

            It has to be able to. The label is capped by character count, which
            cannot know how wide those characters render — 32 wide glyphs in a
            narrow window would otherwise push the Launcher segment, the way
            back, off the end of the row. */}
        <div className="flex min-w-0 items-center">
          <SegmentedToggle
            className="min-w-0 shrink"
            density="compact"
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
        </div>
        {/* The stock launcher carries this same entry as its anchor, so the strip
            only repeats it while the plugin's surface is standing in for it.
            Icon-only: at 32px the label is the widest thing in the strip and it
            says nothing the icon and its tooltip do not. */}
        {showing === "surface" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Search agents &amp; panels…"
                  onClick={() => {
                    void actionService.dispatch("panel.palette", undefined, { source: "user" });
                  }}
                >
                  <Search aria-hidden="true" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">Search agents &amp; panels…</TooltipContent>
          </Tooltip>
        )}
      </SurfaceHeader>
      {/* Both notices are single-line by construction: a `title` and no
          `description`, which is the layout `InlineStatusBanner` already draws
          for that shape — one 40px row, not the 112px card this surface used to
          stack on a 32px strip. The description slot is what made it a card, so
          the rule is simply never to pass one here. */}
      {failedSave !== null ? (
        <InlineStatusBanner
          icon={AlertCircle}
          title="Couldn't save the canvas choice"
          severity="error"
          role="alert"
          action={{
            id: "retry",
            label: "Retry",
            variant: "primary",
            onClick: () => void retryFailedSave(failedSave.choice),
          }}
          onClose={() => {
            dismissFailedSave();
            restoreFocus();
          }}
        />
      ) : (
        choice === null && (
          <InlineStatusBanner
            icon={Puzzle}
            title={`${pluginDisplayName ?? config.name} replaced the launcher`}
            severity="neutral"
            role="status"
            // Equal weight, deliberately: one variant, one size, both answers.
            // Each is a single click from being reversed — the switch directly
            // above, and the reset in project plugin settings — so promoting
            // either one is picking for the user.
            actions={[
              {
                id: "keep",
                label: "Keep it",
                variant: "primary",
                onClick: () => void answer("surface"),
              },
              {
                id: "stock",
                label: "Use the launcher",
                variant: "primary",
                onClick: () => void answer("stock"),
              },
            ]}
          />
        )
      )}
      <div className="relative min-h-0 min-w-0 flex-1" data-testid="project-surface-region">
        {children}
      </div>
    </div>
  );
}
