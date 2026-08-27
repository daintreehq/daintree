import { useEffect, useRef } from "react";
import { FolderOpen, FolderX, GitBranch, Settings } from "lucide-react";
import { DaintreeIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { ProjectPulseStrip } from "@/components/Pulse";
import { useHomeDir } from "@/hooks/app/useHomeDir";
import { cn } from "@/lib/utils";
import { svgToDataUrl, sanitizeSvg } from "@/lib/svg";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { isPtyPanel } from "@shared/types/panel";
import { useRecipeStore } from "@/store/recipeStore";
import { formatPath, middleTruncate } from "@/utils/textParsing";
import { RotatingTip } from "./contentGridTips";
import { RecipeRunner } from "./RecipeRunner/RecipeRunner";
import { ResumeSessionLine } from "./ResumeSessionLine";
import { LauncherQuickActions } from "./LauncherQuickActions";

const PATH_TRUNCATE_LENGTH = 52;

// The column's single measure. Every band fills it rather than choosing its
// own, so the stack has ONE pair of edges instead of the four it used to
// (recipes and pulse at 32rem, the launcher at 38rem, the expanded pulse card
// at the old 48rem container). The children are all exclusive to this surface,
// so the measure belongs to the parent that composes them.
const LAUNCHER_MEASURE = "max-w-[38rem]";

// Marks a section as carrying the entry, so `replaySectionEntries` can find one
// by the same name the class applies. The reduce-motion block in `index.css`
// spells this selector out for itself — renaming it means changing both.
const SECTION_ENTRY_MARKER = "launcher-section-enter";

// Entry motion for each launcher section — the column arrives as a sequence
// rather than one flat block. Static classes, so the animation plays once when
// a section enters the DOM and never replays on re-render; a section whose
// condition flips later (recipes finish loading, the pulse is unhidden) simply
// runs its own entry then. A project switch re-enters nothing, which is why the
// reveal below has to replay these by hand.
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

// Restart each section's entry by tearing the animation down and handing it
// straight back to the class. NOT WAAPI `cancel()`/`play()`: `getAnimations()`
// returns only animations that are current or in effect, and an entry that has
// finished under `fill-mode: backwards` — which fills before its delay, never
// after — is neither. It omits precisely the spent entries this replays, so it
// would iterate nothing and silently do nothing.
//
// Clearing the override rather than naming the keyframes back keeps them in CSS,
// and the fresh animation re-reads `--tw-animation-delay`, so the ladder is
// preserved. Reading a layout property in between is what forces the teardown to
// land, rather than both writes collapsing into one style resolution.
//
// Queried per section, so the launcher's descendants (RotatingTip's fade, pulse
// skeletons) keep their own timelines.
function replaySectionEntries(container: HTMLElement | null): void {
  if (!container || isMotionSuppressed()) return;
  for (const section of container.querySelectorAll<HTMLElement>(`.${SECTION_ENTRY_MARKER}`)) {
    section.style.animationName = "none";
    void section.offsetWidth;
    section.style.animationName = "";
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

  // A deleted worktree can be the active selection (its ghost row is
  // clickable), and `hasLaunchTarget` is rightly false for it — but the
  // generic "Select a worktree" copy would gaslight the user who just
  // selected one. Give the ghost its own state naming the way out.
  const isDeletedWorktreeActive = useWorktreeSelectionStore(
    (s) => s.activeWorktreeId !== null && s.deletedWorktrees.has(s.activeWorktreeId)
  );
  // Resolved at click time via the view store accessor rather than a hook —
  // this component also renders in provider-less contexts (tests, scratches),
  // and the id is only needed once the button is pressed.
  const handleGoToMainWorktree = () => {
    const { worktrees } = getCurrentViewStore().getState();
    let mainId: string | null = null;
    for (const w of worktrees.values()) {
      if (w.isMainWorktree) {
        mainId = w.id;
        break;
      }
      mainId ??= w.id;
    }
    if (mainId !== null) {
      useWorktreeSelectionStore.getState().selectWorktree(mainId);
    }
  };

  const containerRef = useRef<HTMLDivElement>(null);

  // The entry above is DOM-entry motion, which a project switch never re-enters:
  // every project keeps its own persistent WebContentsView and React tree, so
  // switching to one reveals a subtree that was already mounted (a worktree
  // switch, by contrast, remounts this component and replays for free). Nothing
  // renders differently at reveal either, so the replay has to be imperative.
  //
  // Restart on `app:view-revealed`, and do it synchronously. Main sends that
  // only once the warm gate has run and the anti-flash bridge is detached, so
  // this view is the foreground surface and its next paint carries the restarted
  // entry. Deferring a frame or two would buy nothing and cost the flash the
  // whole exercise is about — the launcher sitting at rest, then yanked back to
  // replay in front of the user.
  //
  // Only warm reveals arrive here; a cold-started view is never sent one. It
  // needs no replay for the reason this hook exists — it mounts the launcher
  // fresh, so the entry runs on its own. That entry does still overlap the
  // view's own startup-skeleton exit, but so does every cold boot's: it is
  // startup choreography, not the persistent-tree gap this closes.
  //
  // Restarting rather than remounting: RecipeRunner, ProjectPulseStrip and
  // RotatingTip own fetches and rotation timers a remount would reset, and the
  // point is to replay a fade, not to rebuild the launcher.
  useEffect(() => {
    return window.electron?.app?.onViewRevealed?.(() => {
      replaySectionEntries(containerRef.current);
    });
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
  // watermark both read as misplaced against a centered page). Decorative; the
  // project's own icon wins over the Daintree mark when one is set.
  //
  // Sized for a surface the user lands on many times a day, not for a splash:
  // the mark orients ("which project am I in") and then gets out of the way of
  // the launch anchor below it. At 100px the identity block alone ate the top
  // quarter of the canvas and pushed the anchor past three-quarters down.
  //
  // The fallback mark rides the neutral `daintree-text` (text-primary) token,
  // NOT the hue-carrying `tint` — so it reads as the same grey the startup
  // skeleton's `.skeleton-logo` paints and crossfades in without a hue pop on
  // themed setups (where `tint` carries a brand hue). Theme-aware by
  // construction: text-primary flips with light/dark.
  const sanitizedIcon = projectIconSvg ? sanitizeSvg(projectIconSvg) : null;
  const identityMark = sanitizedIcon?.ok ? (
    <img src={svgToDataUrl(sanitizedIcon.svg)} alt="" className="h-14 w-14 object-contain" />
  ) : (
    <DaintreeIcon className="h-14 w-14 text-daintree-text/65" aria-hidden="true" />
  );

  // The container no longer fades as one block — each launcher section below
  // carries its own entry, and the no-launch-target branches keep the entry
  // fade `EmptyState` already owns.
  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      {/* Content scrolls independently so an expanded pulse (or a tall recipe
          list) on a short canvas stays reachable instead of being clipped.
          `my-auto` on the column, NOT `justify-center` on this flex parent:
          `justify-content: center` distributes overflow to BOTH ends, so once
          the column outgrows the canvas its first rows — identity, and the
          launch anchor right under it — spill above the scroll origin and
          cannot be scrolled back to. Auto margins resolve to zero when there is
          no free space, so the same centering degrades to top alignment.

          `@container/launcher` lets the bands below respond to the CANVAS
          width rather than the window's: this surface sits beside a sidebar and
          inside a grid, so a viewport breakpoint describes the wrong box. */}
      <div className="relative h-full w-full overflow-y-auto">
        <div className="flex min-h-full flex-col items-center p-8">
          {/* A fixed, shrinkable top gutter — not `my-auto` on the column, and
              certainly not `justify-center`. Centring the whole stack made the
              anchor's screen position a function of the stack's HEIGHT, which
              is a function of how many conditional bands resolved: the palette
              button began 174px further down with no recipes than with eight.
              Structurally invariant was not the same as spatially invariant,
              and the muscle memory this surface is supposed to build lives in
              the second one.

              With the gutter fixed, everything below the anchor can grow and
              shrink freely and the anchor does not move. `shrink` lets the
              gutter collapse to zero when the column outgrows the canvas, so
              the first rows stay reachable — the property `justify-center`
              could not give. */}
          <div aria-hidden="true" className="w-full shrink basis-4" />
          <section
            aria-label={workspaceName ? `${workspaceName} — workspace home` : "Workspace home"}
            className={cn(
              "@container/launcher flex w-full shrink-0 flex-col items-center",
              LAUNCHER_MEASURE
            )}
          >
            {hasLaunchTarget && (
              // `min-h-*` reserves the identity block's tallest form — mark,
              // name, branch row and path. Without it the anchor is invariant
              // against everything BELOW it and still slides with what is
              // ABOVE it: a scratch has no branch line, a non-git project has
              // no branch and no worktree, and each missing row pulled the
              // launch entry up. Reserving the footprint costs a scratch some
              // empty air and buys the same launch position in every kind of
              // workspace, which is the whole point of anchoring it.
              <div
                className={cn(
                  "mb-6 flex min-h-[8.5rem] flex-col items-center justify-end text-center",
                  SECTION_ENTRY
                )}
              >
                <div className="mb-3">{identityMark}</div>
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
                      <div className="flex flex-col items-center gap-0.5 text-text-secondary max-w-full min-w-0 font-mono">
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
            {!hasLaunchTarget &&
              isWorktreeInitialized &&
              hasWorktrees &&
              isDeletedWorktreeActive && (
                <EmptyState
                  variant="zero-data"
                  scale="canvas"
                  icon={<FolderX />}
                  title="Worktree deleted"
                  description="Its leftover terminals stay in the sidebar row until they close — drag them to another worktree to keep them"
                  action={
                    <Button variant="outline" size="sm" onClick={handleGoToMainWorktree}>
                      Go to main worktree
                    </Button>
                  }
                />
              )}
            {!hasLaunchTarget &&
              isWorktreeInitialized &&
              hasWorktrees &&
              !isDeletedWorktreeActive && (
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

            {/* The launch anchor sits directly under identity, and nothing
                conditional is allowed above it. That is the whole point of the
                order: recipes come and go with the project, resume comes and
                goes with history, the pulse can be switched off — so anything
                above the anchor makes the anchor's position a function of
                state the user did not choose. Identity is the one band that is
                always present when there is a launch target, so anchoring to it
                is anchoring to a constant.

                It also inverts the stagger's meaning. The ladder used to reveal
                recipes first and the anchor fourth, teaching "recipes matter
                most"; now the sequence walks down the priority order it is
                supposed to express. */}
            {hasLaunchTarget && (
              <div
                className={cn(
                  "mb-6 w-full flex justify-center",
                  SECTION_ENTRY,
                  SECTION_ENTRY_DELAY_1
                )}
              >
                <LauncherQuickActions />
              </div>
            )}

            {hasLaunchTarget && (
              <div
                className={cn(
                  "mb-2.5 w-full flex justify-center",
                  SECTION_ENTRY,
                  SECTION_ENTRY_DELAY_2
                )}
              >
                <ResumeSessionLine />
              </div>
            )}

            {hasLaunchTarget && recipesProjectId !== null && !recipesLoading && (
              <div
                className={cn(
                  "mb-6 w-full flex justify-center",
                  SECTION_ENTRY,
                  SECTION_ENTRY_DELAY_3
                )}
              >
                <RecipeRunner activeWorktreeId={activeWorktreeId} defaultCwd={defaultCwd} />
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
          </section>
          {/* All remaining slack goes below the column, so the anchor keeps its
              distance from the top of the canvas at every canvas height. */}
          <div aria-hidden="true" className="w-full grow basis-0" />
        </div>
      </div>
    </div>
  );
}
