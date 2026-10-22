import { useEffect, useId, useRef, type ReactNode } from "react";
import {
  PROJECT_SURFACE_SLOT_CATALOGUE,
  type ProjectSurfaceChoice,
  type ProjectSurfaceSlot,
} from "@shared/types/plugin";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { ProjectSurfaceConsentNotice } from "@/components/Plugin/ProjectSurfaceConsentNotice";
import { PluginKindSetupStrip } from "@/components/Plugin/PluginSetupStrip";
import { frameSurfaceSlot } from "@/components/Plugin/framedSurfaceSlots";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { SurfaceHeader } from "@/components/ui/SurfaceHeader";
import { useRenderableSurfaceClaim } from "@/hooks/useRenderableSurfaceClaim";
import {
  selectFailedSave,
  selectSurfaceChoice,
  usePluginProjectSurfacesStore,
} from "@/store/pluginProjectSurfacesStore";

/**
 * A manifest's panel name has no length cap, so the strip caps it twice over.
 *
 * This is the coarse half, and it bounds the accessible name and the tooltip as
 * much as the pixels. It cannot be the only half: 32 characters of "WWWW" are
 * not 32 characters of "llll", so a character count alone can never promise the
 * stock segment — the way back — still fits. The switch is also allowed to
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

/** Position of each answer's segment in the switch, which is how focus finds it. */
const SEGMENT_INDEX: Record<ProjectSurfaceChoice, number> = { surface: 0, stock: 1 };

/**
 * Wraps a slot's region so a project plugin's claim on it reads as the
 * project's own version of that place and can never become a dead end. The
 * empty canvas is the first slot framed this way; every framed slot gets the
 * same strip, question and failure row, worded from its catalogue declaration,
 * so the user learns them once.
 *
 * On its own a claimed surface looks like one more panel — even to the person
 * who wrote the manifest. So the host keeps a strip of its own chrome beside
 * the region: a switch naming the plugin's panel and the slot's stock content,
 * and while the surface shows, whatever the mount site passes as
 * `surfaceActions` — the stock content's own anchors, so the region still
 * offers what stock would have.
 *
 * The strip carries those two things and nothing else. It is 32px of chrome
 * framing a full-bleed view someone else drew, so anything in it is competing
 * with that view for the same glance — which is why the switch is the only thing
 * with a fill. A "No panels open" label lived here too and was cut: it was not
 * actionable, it was not a degraded state, and sitting flush against the switch
 * with no separator it read as a third, disabled segment.
 *
 * The strip sits in flow on the side the slot declares, never floated over the
 * region. Plugins draw their own toolbars, most often top-right, and a control
 * pinned into that corner got painted over by exactly that. Out of the plugin's
 * box, no plugin layout can reach it and no author has to reserve room for it.
 *
 * The first time a claim would show in a project, the plugin's consent notice
 * asks whether to keep it ({@link ProjectSurfaceConsentNotice}). Any answer —
 * the notice's or the switch's — is remembered per project in Daintree's own
 * store and disclosed in project plugin settings, so the notice fires once.
 *
 * A passthrough when no claim on `slot` can render, which is most projects: no
 * wrapper element, no strip, nothing to lay out around. Frames an exclusive
 * slot: a selectable slot's options outnumber a two-way switch, so its consumer
 * draws its own picker.
 */
export function ProjectSurfaceFrame({
  slot,
  surfaceActions,
  children,
}: {
  slot: ProjectSurfaceSlot;
  /** Host controls repeated in the strip while the plugin's surface stands in for stock. */
  surfaceActions?: ReactNode;
  children: ReactNode;
}) {
  const { label, stockLabel, noun, switchPlacement } = PROJECT_SURFACE_SLOT_CATALOGUE[slot];
  const renderable = useRenderableSurfaceClaim(slot);
  const choicesLoaded = usePluginProjectSurfacesStore((s) => s.choicesLoaded);
  const choice = usePluginProjectSurfacesStore((s) => selectSurfaceChoice(s, slot));
  const failedSave = usePluginProjectSurfacesStore((s) => selectFailedSave(s, slot));
  const setSurfaceChoice = usePluginProjectSurfacesStore((s) => s.setSurfaceChoice);
  const setSurfaceChoices = usePluginProjectSurfacesStore((s) => s.setSurfaceChoices);
  const dismissFailedSave = usePluginProjectSurfacesStore((s) => s.dismissFailedSave);
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
  // the region will not draw, or show it pressed while the stock content is
  // what is actually on screen.
  const framing = renderable !== null && choicesLoaded;
  const frameId = useId();

  // On screen as a place the plugin's consent question can be asked.
  useEffect(
    () => (framing ? frameSurfaceSlot(slot, frameId) : undefined),
    [framing, slot, frameId]
  );

  if (!framing) {
    return <>{children}</>;
  }

  const { config } = renderable;
  // Unanswered means the manifest's own intent: the surface shows.
  const showing: ProjectSurfaceChoice = choice ?? "surface";
  const choose = (next: ProjectSurfaceChoice) => {
    // Pressing the segment already showing changes nothing, so it answers
    // nothing either — least of all the consent question, silently.
    if (next === showing) return;
    void setSurfaceChoice(slot, next);
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
    const now = selectSurfaceChoice(usePluginProjectSurfacesStore.getState(), slot) ?? "surface";
    stripRef.current
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      [SEGMENT_INDEX[now]]?.focus({ preventScroll: true, focusVisible: !viaPointerRef.current });
  };
  const retryFailedSave = async () => {
    if (failedSave === null) return;
    await setSurfaceChoices(failedSave.updates);
    // Only on success. A retry that fails again leaves the row — and this
    // button — standing, and moving focus off it would be taking the control
    // away at the moment the user most wants to press it a second time.
    if (selectFailedSave(usePluginProjectSurfacesStore.getState(), slot) === null) {
      restoreFocus();
    }
  };
  const panelLabel = capLabel(config.name);

  const strip = (
    <SurfaceHeader
      ref={stripRef}
      density="compact"
      role="group"
      aria-label={label}
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
          narrow window would otherwise push the stock segment, the way back,
          off the end of the row. */}
      <div className="flex min-w-0 items-center">
        <SegmentedRadioGroup
          className="min-w-0 shrink"
          density="compact"
          aria-label={`${noun.charAt(0).toUpperCase()}${noun.slice(1)} view`}
          options={[
            {
              value: "surface",
              label: panelLabel,
              ariaLabel: panelLabel === config.name ? undefined : config.name,
              tooltip: panelLabel === config.name ? undefined : config.name,
            },
            { value: "stock", label: stockLabel },
          ]}
          value={showing}
          onChange={choose}
        />
      </div>
      {/* Stock carries these itself, so the strip only repeats them while the
          plugin's surface is standing in for it. */}
      {showing === "surface" && surfaceActions}
    </SurfaceHeader>
  );
  // Single-line by construction, like the consent notice: a `title` and no
  // `description`, one 40px row rather than a card.
  const notice =
    failedSave !== null ? (
      <InlineStatusBanner
        title={`Couldn't save the ${noun} choice`}
        severity="error"
        role="alert"
        action={{
          id: "retry",
          label: "Retry",
          variant: "primary",
          onClick: () => void retryFailedSave(),
        }}
        onClose={() => {
          dismissFailedSave();
          restoreFocus();
        }}
      />
    ) : (
      <ProjectSurfaceConsentNotice slot={slot} frameId={frameId} onAnswered={restoreFocus} />
    );
  // The surface's plugin still needs setting up: said here, in the host's own
  // chrome beside the region, never inside the plugin's box. Only while the
  // surface is what's showing — stock needs no plugin set up.
  const setup = showing === "surface" && <PluginKindSetupStrip kind={config.id} />;
  const region = (
    <div className="relative min-h-0 min-w-0 flex-1" data-testid="project-surface-region">
      {children}
    </div>
  );

  return (
    <div
      className="flex h-full w-full min-h-0 min-w-0 flex-col"
      data-testid="project-surface-frame"
      data-project-surface-slot={slot}
      onPointerDownCapture={() => {
        viaPointerRef.current = true;
      }}
      onKeyDownCapture={() => {
        viaPointerRef.current = false;
      }}
    >
      {/* The chrome mirrors around the region, so the strip is always its outer
          edge and the rows it explains sit between it and the region. */}
      {switchPlacement === "above" ? (
        <>
          {strip}
          {notice}
          {setup}
          {region}
        </>
      ) : (
        <>
          {region}
          {setup}
          {notice}
          {strip}
        </>
      )}
    </div>
  );
}
