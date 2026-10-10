import { useMemo } from "react";
import { FlaskConical, FolderOpen, FolderTree, MoreHorizontal } from "lucide-react";
import type { WorkspaceRoot } from "@/hooks/useWorkspaceRoot";
import { useWorktreeTerminals } from "@/hooks/useWorktreeTerminals";
import { NO_WORKTREE } from "@/store/slices/panelRegistry/worktreeIndex";
import { CollapsedSessionIndicators } from "@/components/Worktree/WorktreeCard/CollapsedSessionIndicators";
import { summarizeSessionStates } from "@/components/Worktree/terminalStateConfig";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CONTEXT_COMPONENTS, WorktreeMenuItems } from "@/components/Worktree/WorktreeMenuItems";
import { DROPDOWN_COMPONENTS } from "@/components/Worktree/WorktreeCard/WorktreeActionsToolbar";
import { actionService } from "@/services/ActionService";
import { formatPath } from "@/utils/textParsing";
import { SIDEBAR_HEADER_ACTION } from "./sidebarHeader";
import { useWorkspaceRootMenuActions } from "./useWorkspaceRootMenuActions";
import { pluralize } from "@/lib/pluralize";

/**
 * How a workspace with no git worktrees describes itself. A scratch says so
 * outright — JetBrains' "Scratches and Consoles" is the model: the row a user
 * lands on has to look like less than a worktree row, or they arrive expecting
 * a parity it will never have (#11499).
 */
function kindLabel(workspace: WorkspaceRoot): string {
  return workspace.kind === "scratch" ? "Scratch" : "Folder";
}

/**
 * The single row a worktree-less workspace contributes to the sidebar.
 *
 * The sidebar lists places agents run, and this is the only one such a
 * workspace has. Deliberately NOT a `WorktreeCard`: nearly everything that
 * hangs off that card is git-shaped (review, diffs, branch labels, delete), and
 * a row that looks identical to a worktree row with half its menu inert is a
 * bigger lie than the dead toggle this fixes. The git-shaped actions are absent
 * here, not disabled: the ⋯ and right-click menus share the worktree menu body
 * in its workspace-root mode, which carries only what acts on a plain folder.
 *
 * Terminal counts come from the `NO_WORKTREE` bucket — the index key panels
 * launched without a worktree already carry (`worktreeIndex.ts`), so the row
 * reads live state without anything stamping a synthetic worktree id onto a
 * panel (which would make it look orphaned to every worktree-scoped pass).
 *
 * Not clickable on purpose. A worktree row's click selects that worktree; there
 * is nothing to select when the workspace *is* the row, and inventing a no-op
 * click target here would reintroduce the exact bug being fixed.
 */
export function WorkspaceRootRow({
  workspace,
  homeDir,
}: {
  workspace: WorkspaceRoot;
  homeDir?: string;
}) {
  const { counts } = useWorktreeTerminals(NO_WORKTREE);
  const menuActions = useWorkspaceRootMenuActions(workspace);

  const { visibleStates, label: sessionAriaLabel } = useMemo(
    () => summarizeSessionStates(counts.byState, counts.total),
    [counts]
  );

  const KindIcon = workspace.kind === "scratch" ? FlaskConical : FolderOpen;
  const displayPath = formatPath(workspace.path, homeDir);
  const terminalLabel = `${pluralize(counts.total, "terminal")}`;

  return (
    <div data-workspace-root-row={workspace.id}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex flex-col gap-1 px-4 py-3 border-b border-divider">
            <div className="flex items-center gap-2 min-w-0">
              <KindIcon className="w-4 h-4 shrink-0 text-daintree-text/60" aria-hidden="true" />
              <TruncatedTooltip content={workspace.name}>
                <span className="truncate min-w-0 text-sm leading-[inherit] font-medium text-text-primary">
                  {workspace.name}
                </span>
              </TruncatedTooltip>
              <div className="ml-auto flex items-center gap-2 shrink-0">
                {visibleStates.length > 0 && (
                  <CollapsedSessionIndicators
                    visibleStates={visibleStates}
                    sessionAriaLabel={sessionAriaLabel}
                  />
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => {
                        void actionService.dispatch("worktree.openFileBrowserPanel", undefined, {
                          source: "user",
                        });
                      }}
                      className={SIDEBAR_HEADER_ACTION}
                      aria-label="Browse files"
                    >
                      <FolderTree aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Browse files</TooltipContent>
                </Tooltip>
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className={SIDEBAR_HEADER_ACTION}
                          aria-label="More actions"
                          data-testid="workspace-root-actions-menu"
                        >
                          <MoreHorizontal aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">More actions</TooltipContent>
                  </Tooltip>
                  {/* Portaled, so a right-click inside it would otherwise
                      bubble through React to the row's context menu. */}
                  <DropdownMenuContent
                    align="end"
                    side="bottom"
                    onContextMenu={(e) => e.stopPropagation()}
                    className="w-64"
                  >
                    <WorktreeMenuItems components={DROPDOWN_COMPONENTS} {...menuActions} />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            {/* Kind rides the secondary line rather than a pill: origin has to
                be unambiguous, but it isn't the row's headline, and a badge
                would be a second emphasis signal on a one-row list. */}
            <div className="flex items-center gap-1.5 text-xs text-text-secondary min-w-0">
              <span className="shrink-0">{kindLabel(workspace)}</span>
              <span aria-hidden="true">·</span>
              <TruncatedTooltip content={displayPath}>
                <span className="truncate min-w-0 font-mono">{displayPath}</span>
              </TruncatedTooltip>
              <span className="sr-only">, {terminalLabel}</span>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <WorktreeMenuItems components={CONTEXT_COMPONENTS} {...menuActions} />
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
