import { FolderOpen, GitBranch, Settings } from "lucide-react";
import { DaintreeIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { ProjectPulseCard } from "@/components/Pulse";
import { useHomeDir } from "@/hooks/app/useHomeDir";
import { svgToDataUrl, sanitizeSvg } from "@/lib/svg";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { useRecipeStore } from "@/store/recipeStore";
import { formatPath, middleTruncate } from "@/utils/textParsing";
import { RotatingTip } from "./contentGridTips";
import { RecipeRunner } from "./RecipeRunner/RecipeRunner";
import { ResumeSessionsCard } from "./ResumeSessionsCard";

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

  return (
    <div className="flex flex-col items-center justify-center h-full w-full p-8 animate-in fade-in duration-500">
      <div className="max-w-3xl w-full flex flex-col items-center">
        {hasActiveWorktree && (
          <div className="mb-6 flex flex-col items-center text-center">
            <div className="relative group mb-4">
              {projectIconSvg ? (
                (() => {
                  const sanitized = sanitizeSvg(projectIconSvg);
                  if (!sanitized.ok) {
                    return <DaintreeIcon className="h-28 w-28 text-tint/65" />;
                  }
                  return (
                    <img
                      src={svgToDataUrl(sanitized.svg)}
                      alt="Project icon"
                      className="h-28 w-28 object-contain"
                    />
                  );
                })()
              ) : (
                <DaintreeIcon className="h-28 w-28 text-tint/65" />
              )}
              <button
                type="button"
                onClick={handleOpenProjectSettings}
                className="absolute -bottom-1 -right-1 p-1.5 bg-daintree-sidebar border border-daintree-border rounded-full opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hover:bg-daintree-bg focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
                aria-label="Change project icon"
              >
                <Settings className="h-3 w-3 text-daintree-text/70" />
              </button>
            </div>
            {hasProjectIdentity ? (
              <div className="flex flex-col items-center gap-1.5 text-center min-w-0 max-w-full">
                <h3 className="text-2xl font-semibold text-daintree-text tracking-tight truncate max-w-full">
                  {projectEmoji ? (
                    <span className="mr-2" aria-hidden="true">
                      {projectEmoji}
                    </span>
                  ) : null}
                  {projectName}
                </h3>
                {(branchLabel || pathLabel) && (
                  <div className="flex flex-col items-center gap-0.5 text-daintree-text/60 max-w-full">
                    {branchLabel && (
                      <div className="flex items-center gap-1.5 text-sm max-w-full min-w-0">
                        <GitBranch className="h-3 w-3 shrink-0" aria-hidden="true" />
                        <span className="font-mono truncate min-w-0">{branchLabel}</span>
                      </div>
                    )}
                    {pathLabel && (
                      <p
                        className="text-xs font-mono truncate max-w-full"
                        title={activeWorktreePath ?? undefined}
                      >
                        {pathLabel}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <h3 className="text-2xl font-semibold text-daintree-text tracking-tight mb-3">
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
          <div className="mb-6 w-full flex justify-center">
            <RecipeRunner activeWorktreeId={activeWorktreeId} defaultCwd={defaultCwd} />
          </div>
        )}

        {showProjectPulse && hasActiveWorktree && activeWorktreeId && (
          <div className="flex justify-center mb-8">
            <ProjectPulseCard worktreeId={activeWorktreeId} />
          </div>
        )}

        {hasActiveWorktree && <ResumeSessionsCard activeWorktreeId={activeWorktreeId} />}

        {hasActiveWorktree && hasEverLaunchedAgent && (
          <div className="flex flex-col items-center gap-4 mt-4">
            <RotatingTip />
          </div>
        )}
      </div>
    </div>
  );
}
