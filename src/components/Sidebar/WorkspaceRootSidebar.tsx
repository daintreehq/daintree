import type { WorkspaceRoot } from "@/hooks/useWorkspaceRoot";
import { useProjectStore } from "@/store/projectStore";
import { Button } from "@/components/ui/button";
import { WorkspaceRootRow } from "./WorkspaceRootRow";

/**
 * The sidebar for a workspace that has no git worktrees — a scratch, or a
 * folder opened without git (#11405).
 *
 * Same slot, same meaning as the worktree list: the places agents run. Such a
 * workspace has exactly one, its own root, so it renders exactly one row. That
 * is not a new pattern — a repo with no linked worktrees already renders a
 * single main-worktree row — which is why the fix is admitting a non-git root
 * into the list rather than building a second view (#11499).
 *
 * Everything worktree-shaped is absent rather than disabled: no create-worktree
 * button, no worktree overview, no refresh (there is no worktree poll to
 * refresh), no search bar or quick-state filter over a one-row list, and no
 * fleet-arm affordance — `fleetArmingStore` collects by real worktree id, so an
 * arm control here would be another control that reports doing something and
 * doesn't.
 */
export function WorkspaceRootSidebar({
  workspace,
  homeDir,
}: {
  workspace: WorkspaceRoot;
  homeDir?: string;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex h-8 items-center px-3 border-b border-divider shrink-0">
        {/* Not "Worktrees": this workspace has none, and naming the slot after
            a concept it can't hold is what made the header wrong for two of the
            three workspace kinds. */}
        <h2 className="truncate text-text-primary font-semibold text-sm tracking-wide">
          Workspace
        </h2>
      </div>

      {/* Plain container, not a `role="grid"`: the worktree list is a grid
          because it has selection and arrow-key navigation over its rows
          (`SidebarContent.tsx` — tab stop, `aria-activedescendant`, key
          handlers). This row has neither, so grid/row/gridcell roles would
          promise a keyboard widget that isn't there — the same kind of lie as
          the toggle this fixes. The heading above already names the region. */}
      <div className="flex flex-col flex-1 min-h-0">
        <WorkspaceRootRow workspace={workspace} homeDir={homeDir} />
      </div>

      {/* A scratch can't become a repository — it's app-managed and disposable —
          so the upgrade is offered only for a real folder, and quietly: the row
          above is the answer to "where do agents run here", not this. */}
      {workspace.kind === "project" && (
        <div className="shrink-0 border-t border-divider px-4 py-3 flex flex-col items-start gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              useProjectStore.getState().openGitInitDialog(workspace.path, { step: "initialize" });
            }}
          >
            Initialize repository
          </Button>
          <span className="text-xs text-text-secondary">
            Terminals, agents, and recipes work without one
          </span>
        </div>
      )}
    </div>
  );
}
