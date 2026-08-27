import { useMemo } from "react";
import { FlaskConical, FolderOpen, FolderTree } from "lucide-react";
import type { AgentState } from "@/types";
import type { WorkspaceRoot } from "@/hooks/useWorkspaceRoot";
import { useWorktreeTerminals } from "@/hooks/useWorktreeTerminals";
import { NO_WORKTREE } from "@/store/slices/panelRegistry/worktreeIndex";
import { CollapsedSessionIndicators } from "@/components/Worktree/WorktreeCard/CollapsedSessionIndicators";
import { STATE_LABELS, STATE_PRIORITY } from "@/components/Worktree/terminalStateConfig";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuActionItem,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { actionService } from "@/services/ActionService";
import { formatPath } from "@/utils/textParsing";

const ICON_CLASS = "w-3.5 h-3.5 mr-2 shrink-0";

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
 * here, not disabled.
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

  const { visibleStates, sessionAriaLabel } = useMemo(() => {
    const total = counts.total;
    if (total === 0) {
      return { visibleStates: [] as { state: AgentState; count: number }[], sessionAriaLabel: "" };
    }
    const visible = STATE_PRIORITY.filter((s) => s !== "idle" && counts.byState[s] > 0).map(
      (s) => ({
        state: s,
        count: counts.byState[s],
      })
    );
    const parts = visible.map((v) => `${v.count} ${STATE_LABELS[v.state]}`);
    const label =
      parts.length > 0
        ? `${total} session${total !== 1 ? "s" : ""}: ${parts.join(", ")}`
        : `${total} session${total !== 1 ? "s" : ""}`;
    return { visibleStates: visible, sessionAriaLabel: label };
  }, [counts]);

  const KindIcon = workspace.kind === "scratch" ? FlaskConical : FolderOpen;
  const displayPath = formatPath(workspace.path, homeDir);
  const terminalLabel = `${counts.total} terminal${counts.total !== 1 ? "s" : ""}`;

  return (
    <div data-workspace-root-row={workspace.id}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex flex-col gap-1 px-4 py-3 border-b border-divider">
            <div className="flex items-center gap-2 min-w-0">
              <KindIcon className="w-4 h-4 shrink-0 text-daintree-text/60" aria-hidden="true" />
              <TruncatedTooltip content={workspace.name}>
                <span className="truncate min-w-0 text-sm leading-[inherit] font-medium text-daintree-text">
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
                    <button
                      type="button"
                      onClick={() => {
                        void actionService.dispatch("worktree.openFileBrowserPanel", undefined, {
                          source: "user",
                        });
                      }}
                      className="p-1 text-daintree-text/40 hover:text-daintree-text hover:bg-tint/[0.06] rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
                      aria-label="Browse files"
                    >
                      <FolderTree className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Browse files</TooltipContent>
                </Tooltip>
              </div>
            </div>
            {/* Kind rides the secondary line rather than a pill: origin has to
                be unambiguous, but it isn't the row's headline, and a badge
                would be a second emphasis signal on a one-row list. */}
            <div className="flex items-center gap-1.5 text-xs text-daintree-text/50 min-w-0">
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
          <ContextMenuActionItem actionId="worktree.openFileBrowserPanel">
            <FolderTree className={ICON_CLASS} />
            Browse files
          </ContextMenuActionItem>
          <ContextMenuActionItem actionId="system.openPath" args={{ path: workspace.path }}>
            <FolderOpen className={ICON_CLASS} />
            Reveal in Finder
          </ContextMenuActionItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
