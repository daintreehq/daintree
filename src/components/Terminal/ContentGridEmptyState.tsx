import { FolderOpen, GitBranch, Settings } from "lucide-react";
import { DaintreeIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { ProjectPulseStrip } from "@/components/Pulse";
import { useHomeDir } from "@/hooks/app/useHomeDir";
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

export function ContentGridEmptyState({
  hasActiveWorktree,
  hasWorktrees,
  isWorktreeInitialized,
  activeWorktreeName,
  activeWorktreeId,
  activeWorktreeBranch,
  activeWorktreeIsDetached,
  activeWorktreeHead,
  activeWorktreePath,
  projectName,
  projectEmoji,
  showProjectPulse,
  projectIconSvg,
  defaultCwd,
}: {
  hasActiveWorktree: boolean;
  hasWorktrees: boolean;
  isWorktreeInitialized: boolean;
  activeWorktreeName?: string | null;
  activeWorktreeId?: string | null;
  activeWorktreeBranch?: string | null;
  activeWorktreeIsDetached?: boolean;
  activeWorktreeHead?: string | null;
  activeWorktreePath?: string | null;
  projectName?: string | null;
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
  // `RecipeRunnerEmpty` ("Create your first recipe") while in-repo recipes are
  // still in flight.
  const recipesProjectId = useRecipeStore((state) => state.currentProjectId);
  const recipesLoading = useRecipeStore((state) => state.isLoading);
  const { homeDir } = useHomeDir();

  const branchLabel =
    activeWorktreeIsDetached && activeWorktreeHead
      ? `detached at ${activeWorktreeHead.slice(0, 7)}`
      : activeWorktreeBranch || null;
  const pathLabel = activeWorktreePath
    ? middleTruncate(formatPath(activeWorktreePath, homeDir), PATH_TRUNCATE_LENGTH)
    : null;
  const hasProjectIdentity = Boolean(projectName);

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
  const sanitizedIcon = projectIconSvg ? sanitizeSvg(projectIconSvg) : null;
  const identityMark = sanitizedIcon?.ok ? (
    <img src={svgToDataUrl(sanitizedIcon.svg)} alt="" className="h-25 w-25 object-contain" />
  ) : (
    <DaintreeIcon className="h-25 w-25 text-tint/65" aria-hidden="true" />
  );

  return (
    <div className="relative h-full w-full overflow-hidden animate-in fade-in duration-200">
      {/* Content scrolls independently of the fixed watermark so an expanded
          pulse (or a tall recipe list) on a short canvas stays reachable
          instead of being clipped; `min-h-full` keeps it centered when short. */}
      <div className="relative h-full w-full overflow-y-auto">
        <div className="flex min-h-full flex-col items-center justify-center p-8">
          <div className="max-w-3xl w-full flex flex-col items-center">
            {hasActiveWorktree && (
              <div className="mb-6 flex flex-col items-center text-center">
                <div className="mb-4">{identityMark}</div>
                {hasProjectIdentity ? (
                  <div className="flex flex-col items-center gap-1.5 min-w-0 max-w-full">
                    <div className="group flex items-center gap-1.5 min-w-0 max-w-full">
                      <h3 className="text-2xl font-semibold text-daintree-text tracking-tight truncate max-w-full">
                        {projectEmoji ? (
                          // The name outweighs the emoji — the text is the
                          // identity, the emoji is seasoning.
                          <span className="mr-2 text-lg align-middle" aria-hidden="true">
                            {projectEmoji}
                          </span>
                        ) : null}
                        {projectName}
                      </h3>
                      <button
                        type="button"
                        onClick={handleOpenProjectSettings}
                        className="shrink-0 rounded-full p-1 text-daintree-text/50 opacity-0 transition-opacity hover:bg-overlay-subtle hover:text-daintree-text group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
                        aria-label="Project settings"
                      >
                        <Settings className="h-3.5 w-3.5" />
                      </button>
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

            {!hasActiveWorktree && !isWorktreeInitialized && null}
            {!hasActiveWorktree && isWorktreeInitialized && hasWorktrees && (
              <EmptyState
                variant="zero-data"
                scale="canvas"
                icon={<FolderOpen />}
                title="Select a worktree"
                description="Choose a worktree from the sidebar to open it in the canvas"
              />
            )}
            {!hasActiveWorktree && isWorktreeInitialized && !hasWorktrees && (
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

            {hasActiveWorktree && recipesProjectId !== null && !recipesLoading && (
              <div className="mb-3 w-full flex justify-center">
                <RecipeRunner activeWorktreeId={activeWorktreeId} defaultCwd={defaultCwd} />
              </div>
            )}

            {hasActiveWorktree && (
              <div className="mb-3 w-full flex justify-center">
                <ResumeSessionLine />
              </div>
            )}

            {hasActiveWorktree && (
              <div className="mb-6 w-full flex justify-center">
                <LauncherQuickActions />
              </div>
            )}

            {showProjectPulse && hasActiveWorktree && activeWorktreeId && (
              <div className="w-full flex justify-center">
                <ProjectPulseStrip worktreeId={activeWorktreeId} />
              </div>
            )}

            {hasActiveWorktree && hasEverLaunchedAgent && (
              <div className="flex flex-col items-center gap-4 mt-6">
                <RotatingTip />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
