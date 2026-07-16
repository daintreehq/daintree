import { useEffect, useRef } from "react";
import { FolderOpen, GitBranch, Settings } from "lucide-react";
import { DaintreeIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { ProjectPulseStrip } from "@/components/Pulse";
import { useHomeDir } from "@/hooks/app/useHomeDir";
import { cn } from "@/lib/utils";
import { svgToDataUrl, sanitizeSvg } from "@/lib/svg";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { useRecipeStore } from "@/store/recipeStore";
import { formatPath, middleTruncate } from "@/utils/textParsing";
import { RotatingTip } from "./contentGridTips";
import { RecipeRunner } from "./RecipeRunner/RecipeRunner";
import { ResumeSessionLine } from "./ResumeSessionLine";
import { LauncherQuickActions } from "./LauncherQuickActions";

const PATH_TRUNCATE_LENGTH = 52;

// Entry motion for each launcher section — the column arrives as a sequence
// rather than one flat block. Static classes, so the animation plays once when
// a section enters the DOM and never replays on re-render; a section whose
// condition flips later (recipes finish loading, the pulse is unhidden) simply
// runs its own entry then.
//
// Two suppressors, both needed, exactly as `ContentFadeIn` does it:
// `motion-safe:` covers the OS preference, and the `launcher-section-enter`
// marker registers these sections with the reduce-motion block in `index.css`,
// which is what honours Daintree's own reduce-animations toggle — a `body`
// attribute no Tailwind variant can reach from here. Performance mode is
// already killed globally.
//
// The duration is the shared entry tier (`--duration-200`), fed to the
// animation's own slot rather than via `duration-200`. That utility would also
// emit `transition-duration`, and with no `transition-property` on these
// wrappers it lands on CSS's `all` default — an every-property transition
// nobody asked for. Setting `--tw-animation-duration` keeps the transition set
// empty, for the same reason the ladder below avoids `delay-*`.
// Also the hook the reveal replay queries by, so the class the reduce-motion
// block neutralizes and the class the replay restarts cannot drift apart.
const SECTION_ENTRY_MARKER = "launcher-section-enter";

const SECTION_ENTRY = `${SECTION_ENTRY_MARKER} motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:[--tw-animation-duration:var(--duration-200)]`;

// The stagger ladder. Sequencing IS the signal here, so the per-step delay is a
// literal ladder rather than one of the shared duration tiers.
//
// NOT `delay-*`: Tailwind's own `delay-*` wins over the animation library's
// same-named utility and compiles to `transition-delay`, which an `animate-in`
// keyframe animation never reads — the sections would all arrive at once. The
// animation's delay slot is the `--tw-animation-delay` custom property, so the
// ladder sets that directly. (`duration-*` needs no such workaround: it also
// sets `--tw-duration`, which the animation does read.)
//
// Every non-zero delay MUST carry `fill-mode-backwards`. The underlying `enter`
// animation defaults to `fill-mode: none`, which paints a section fully visible
// for the length of its delay and then snaps it hidden before fading it in.
const SECTION_ENTRY_DELAY_1 =
  "motion-safe:[--tw-animation-delay:30ms] motion-safe:fill-mode-backwards";
const SECTION_ENTRY_DELAY_2 =
  "motion-safe:[--tw-animation-delay:60ms] motion-safe:fill-mode-backwards";
const SECTION_ENTRY_DELAY_3 =
  "motion-safe:[--tw-animation-delay:90ms] motion-safe:fill-mode-backwards";
const SECTION_ENTRY_DELAY_4 =
  "motion-safe:[--tw-animation-delay:120ms] motion-safe:fill-mode-backwards";
const SECTION_ENTRY_DELAY_5 =
  "motion-safe:[--tw-animation-delay:150ms] motion-safe:fill-mode-backwards";

// Both of the entry's suppressors are CSS-only — `motion-safe:` reads the OS
// preference and the `launcher-section-enter` rule reads the in-app toggle — so
// neither can stop a replay driven from JS. Restating the same triple check
// `triggerPanelTransition` makes keeps the replay from restarting animations
// those rules have already flattened to nothing.
function isMotionSuppressed(): boolean {
  return (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.body.getAttribute("data-reduce-animations") === "true" ||
    document.body.getAttribute("data-performance-mode") === "true"
  );
}

// Restart each section's own entry, keeping its place on the stagger ladder: the
// delay lives in a custom property the animation re-reads, so a cancel/play pair
// in one tick replays the ladder rather than collapsing it. `fill-mode-backwards`
// makes cancel() paint the pre-entry state, so no section flashes at rest first.
//
// Queried per section and restarted through each element's OWN animations —
// `getAnimations()` without `subtree` — because the launcher's descendants carry
// unrelated motion (RotatingTip's fade, pulse skeletons) that must keep running
// on its own timeline.
function replaySectionEntries(container: HTMLElement | null): void {
  if (!container || isMotionSuppressed()) return;
  for (const section of container.querySelectorAll(`.${SECTION_ENTRY_MARKER}`)) {
    for (const animation of section.getAnimations()) {
      animation.cancel();
      animation.play();
    }
  }
}

// The active workspace is a project OR a scratch (#11076). `hasLaunchTarget`
// gates the launcher column on having somewhere to launch INTO — a scratch has
// no worktree but is a perfectly good target. `hasProjectContext` gates the
// affordances only a real project can honour: the settings gear (there is no
// scratch settings tab) and the tip catalog (it talks about worktrees and the
// project file tree).
export function ContentGridEmptyState({
  hasLaunchTarget,
  hasProjectContext,
  hasWorktrees,
  isWorktreeInitialized,
  activeWorktreeName,
  activeWorktreeId,
  activeWorktreeBranch,
  activeWorktreeIsDetached,
  activeWorktreeHead,
  activeWorktreePath,
  workspaceName,
  projectEmoji,
  showProjectPulse,
  projectIconSvg,
  defaultCwd,
}: {
  hasLaunchTarget: boolean;
  hasProjectContext: boolean;
  hasWorktrees: boolean;
  isWorktreeInitialized: boolean;
  activeWorktreeName?: string | null;
  activeWorktreeId?: string | null;
  activeWorktreeBranch?: string | null;
  activeWorktreeIsDetached?: boolean;
  activeWorktreeHead?: string | null;
  activeWorktreePath?: string | null;
  workspaceName?: string | null;
  projectEmoji?: string | null;
  showProjectPulse: boolean;
  projectIconSvg?: string;
  defaultCwd?: string;
}) {
  "use memo";

  const hasEverLaunchedAgent = usePanelStore((state) =>
    state.panelIds.some((id) => {
      const p = state.panelsById[id];
      if (!p || !isPtyPanel(p)) return false;
      return Boolean(p.launchAgentId) || Boolean(p.detectedAgentId) || p.everDetectedAgent === true;
    })
  );
  // Suppress RecipeRunner until the recipe store has settled for the current
  // project — `loadRecipes()` sets `currentProjectId` synchronously before any
  // IPC resolves, so we also need `!isLoading` to avoid flashing
  // `RecipeRunnerEmpty` ("Create your first recipe…") while in-repo recipes are
  // still in flight.
  const recipesProjectId = useRecipeStore((state) => state.currentProjectId);
  const recipesLoading = useRecipeStore((state) => state.isLoading);
  const { homeDir } = useHomeDir();

  const containerRef = useRef<HTMLDivElement>(null);

  // The entry above is DOM-entry motion, which a project switch never re-enters:
  // every project keeps its own persistent WebContentsView and React tree, so
  // switching to one reveals a subtree that was already mounted (a worktree
  // switch, by contrast, remounts this component and replays for free). Nothing
  // renders differently at reveal either, so the replay has to be imperative.
  //
  // `app:view-revealed` is the moment to hang it on: ProjectViewManager sends it
  // only once the anti-flash bridge is detached and this view is the foreground
  // surface, which is exactly when an entry animation is worth spending. Cold
  // switches need no replay — their view mounts this component fresh, after the
  // bridge is gone, so the natural entry is already the one the user sees.
  //
  // WAAPI restart rather than a remount key: RecipeRunner, ProjectPulseStrip and
  // RotatingTip own fetches and rotation timers a remount would reset, and the
  // point is to replay a fade, not to rebuild the launcher.
  useEffect(() => {
    let outerFrame: number | null = null;
    let innerFrame: number | null = null;

    const cancelPendingReplay = () => {
      if (outerFrame !== null) cancelAnimationFrame(outerFrame);
      if (innerFrame !== null) cancelAnimationFrame(innerFrame);
      outerFrame = null;
      innerFrame = null;
    };

    const offRevealed = window.electron?.app?.onViewRevealed?.(() => {
      cancelPendingReplay();
      // Two frames, as the paint signal itself waits: the reveal arrives while
      // the compositor is still waking this view from occlusion, and a restart
      // issued into that gap is dropped — the bug this animation already has on
      // the occluded path, reintroduced.
      outerFrame = requestAnimationFrame(() => {
        outerFrame = null;
        innerFrame = requestAnimationFrame(() => {
          innerFrame = null;
          replaySectionEntries(containerRef.current);
        });
      });
    });

    // A view parked back in the LRU cache stops painting mid-schedule, leaving a
    // frame to fire on its next reveal — which would restart the entry a beat
    // before that reveal's own replay and hitch it.
    const offCached = window.electron?.app?.onViewCached?.(cancelPendingReplay);

    return () => {
      cancelPendingReplay();
      offRevealed?.();
      offCached?.();
    };
  }, []);

  const branchLabel =
    activeWorktreeIsDetached && activeWorktreeHead
      ? `detached at ${activeWorktreeHead.slice(0, 7)}`
      : activeWorktreeBranch || null;
  const pathLabel = activeWorktreePath
    ? middleTruncate(formatPath(activeWorktreePath, homeDir), PATH_TRUNCATE_LENGTH)
    : null;
  const hasWorkspaceIdentity = Boolean(workspaceName);

  const handleOpenProjectSettings = () => {
    window.dispatchEvent(
      new CustomEvent("daintree:open-settings-tab", {
        detail: { tab: "project:general" },
      })
    );
  };

  // Centered stacked hero: mark above, name below — one alignment axis with
  // the rest of the launcher column (a left-aligned lockup and a floating
  // watermark both read as misplaced against a centered page). ~10% smaller
  // than the pre-redesign hero. Decorative; the project's own icon wins over
  // the Daintree mark when one is set.
  //
  // The fallback mark rides the neutral `daintree-text` (text-primary) token,
  // NOT the hue-carrying `tint` — so it reads as the same grey the startup
  // skeleton's `.skeleton-logo` paints and crossfades in without a hue pop on
  // themed setups (where `tint` carries a brand hue). Theme-aware by
  // construction: text-primary flips with light/dark.
  const sanitizedIcon = projectIconSvg ? sanitizeSvg(projectIconSvg) : null;
  const identityMark = sanitizedIcon?.ok ? (
    <img src={svgToDataUrl(sanitizedIcon.svg)} alt="" className="h-25 w-25 object-contain" />
  ) : (
    <DaintreeIcon className="h-25 w-25 text-daintree-text/65" aria-hidden="true" />
  );

  // The container no longer fades as one block — each launcher section below
  // carries its own entry, and the no-launch-target branches keep the entry
  // fade `EmptyState` already owns.
  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      {/* Content scrolls independently of the fixed watermark so an expanded
          pulse (or a tall recipe list) on a short canvas stays reachable
          instead of being clipped; `min-h-full` keeps it centered when short. */}
      <div className="relative h-full w-full overflow-y-auto">
        <div className="flex min-h-full flex-col items-center justify-center p-8">
          <div className="max-w-3xl w-full flex flex-col items-center">
            {hasLaunchTarget && (
              <div className={cn("mb-6 flex flex-col items-center text-center", SECTION_ENTRY)}>
                <div className="mb-4">{identityMark}</div>
                {hasWorkspaceIdentity ? (
                  <div className="flex flex-col items-center gap-1.5 min-w-0 max-w-full">
                    {/* The name stays centered under the mark; the gear is
                        pulled out of flow (absolute, just past the name) so its
                        hidden footprint never shifts the lockup off-axis. */}
                    <div className="group relative flex items-center min-w-0 max-w-full">
                      <h3 className="text-2xl font-semibold text-daintree-text tracking-tight truncate max-w-full">
                        {projectEmoji ? (
                          // The name outweighs the emoji — the text is the
                          // identity, the emoji is seasoning.
                          <span className="mr-2 text-lg align-middle" aria-hidden="true">
                            {projectEmoji}
                          </span>
                        ) : null}
                        {workspaceName}
                      </h3>
                      {hasProjectContext && (
                        <button
                          type="button"
                          onClick={handleOpenProjectSettings}
                          className="absolute left-full top-1/2 ml-1.5 -translate-y-1/2 shrink-0 rounded-full p-1 text-daintree-text/50 opacity-0 transition-opacity hover:bg-overlay-subtle hover:text-daintree-text group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
                          aria-label="Project settings"
                        >
                          <Settings className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    {(branchLabel || pathLabel) && (
                      <div className="flex flex-col items-center gap-0.5 text-daintree-text/60 max-w-full min-w-0 font-mono">
                        {branchLabel && (
                          <div className="flex items-center gap-1.5 text-sm max-w-full min-w-0">
                            <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span className="truncate min-w-0">{branchLabel}</span>
                          </div>
                        )}
                        {pathLabel && (
                          <p
                            className="text-xs truncate max-w-full"
                            title={activeWorktreePath ?? undefined}
                          >
                            {pathLabel}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <h3 className="text-xl font-semibold text-daintree-text tracking-tight truncate max-w-full">
                    {activeWorktreeName || "Daintree"}
                  </h3>
                )}
              </div>
            )}

            {!hasLaunchTarget && !isWorktreeInitialized && null}
            {!hasLaunchTarget && isWorktreeInitialized && hasWorktrees && (
              <EmptyState
                variant="zero-data"
                scale="canvas"
                icon={<FolderOpen />}
                title="Select a worktree"
                description="Choose a worktree from the sidebar to open it in the canvas"
              />
            )}
            {!hasLaunchTarget && isWorktreeInitialized && !hasWorktrees && (
              <EmptyState
                variant="zero-data"
                scale="canvas"
                icon={<FolderOpen />}
                title="Open a project folder"
                description="Worktrees let you work on multiple tasks in isolated environments"
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void actionService.dispatch("project.add", undefined, { source: "user" });
                    }}
                  >
                    Open folder…
                  </Button>
                }
              />
            )}

            {hasLaunchTarget && recipesProjectId !== null && !recipesLoading && (
              <div
                className={cn(
                  "mb-3 w-full flex justify-center",
                  SECTION_ENTRY,
                  SECTION_ENTRY_DELAY_1
                )}
              >
                <RecipeRunner activeWorktreeId={activeWorktreeId} defaultCwd={defaultCwd} />
              </div>
            )}

            {hasLaunchTarget && (
              <div
                className={cn(
                  "mb-3 w-full flex justify-center",
                  SECTION_ENTRY,
                  SECTION_ENTRY_DELAY_2
                )}
              >
                <ResumeSessionLine />
              </div>
            )}

            {hasLaunchTarget && (
              <div
                className={cn(
                  "mb-6 w-full flex justify-center",
                  SECTION_ENTRY,
                  SECTION_ENTRY_DELAY_3
                )}
              >
                <LauncherQuickActions />
              </div>
            )}

            {showProjectPulse && hasLaunchTarget && activeWorktreeId && (
              <div
                className={cn("w-full flex justify-center", SECTION_ENTRY, SECTION_ENTRY_DELAY_4)}
              >
                <ProjectPulseStrip worktreeId={activeWorktreeId} />
              </div>
            )}

            {hasLaunchTarget && hasProjectContext && hasEverLaunchedAgent && (
              <div
                className={cn(
                  "flex flex-col items-center gap-4 mt-6",
                  SECTION_ENTRY,
                  SECTION_ENTRY_DELAY_5
                )}
              >
                <RotatingTip />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
