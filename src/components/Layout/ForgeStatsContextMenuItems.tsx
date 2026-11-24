import { CircleDot, ExternalLink, GitCommit, GitPullRequest, type LucideIcon } from "lucide-react";
import { ContextMenuActionItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import type { ActionId } from "@shared/types/actions";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";

export type ForgeStatsMenuSegment = "issues" | "prs" | "commits";

const SEGMENT_ITEMS = {
  issues: { actionId: "forge.openIssues", label: "View all issues", icon: CircleDot },
  prs: { actionId: "forge.openPRs", label: "View all pull requests", icon: GitPullRequest },
  commits: { actionId: "forge.openCommits", label: "View commits", icon: GitCommit },
} as const satisfies Record<
  ForgeStatsMenuSegment,
  { actionId: ActionId; label: string; icon: LucideIcon }
>;

interface ForgeStatsContextMenuItemsProps {
  projectPath: string;
  /** Resolved forge provider's display name, or `null` when the project has none. */
  providerName: string | null;
  /**
   * Who serves the right-clicked pill's own list, when that isn't the code
   * forge: a project's issues can come from another tracker (#13700). The
   * repository entry stays the code forge's.
   */
  segmentProviderName?: string;
  /** The pill that was right-clicked; omitted for the indicators beside the pills. */
  segment?: ForgeStatsMenuSegment;
  /** Branch the commits pill lists, so the forge opens the same history. */
  branch?: string;
  canOpenRepo: boolean;
}

// Object-specific navigation first, then the repository, then toolbar chrome
// behind a separator — the ordering the platform HIGs give context menus.
export function ForgeStatsContextMenuItems({
  projectPath,
  providerName,
  segmentProviderName,
  segment,
  branch,
  canOpenRepo,
}: ForgeStatsContextMenuItemsProps) {
  const segmentItem = segment ? SEGMENT_ITEMS[segment] : null;

  return (
    <>
      {providerName !== null && segmentItem ? (
        <>
          <ContextMenuActionItem
            actionId={segmentItem.actionId}
            args={segment === "commits" && branch ? { projectPath, branch } : { projectPath }}
          >
            <segmentItem.icon data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            {`${segmentItem.label} on ${segmentProviderName ?? providerName}`}
          </ContextMenuActionItem>
          <ContextMenuSeparator />
        </>
      ) : null}
      {providerName !== null && canOpenRepo ? (
        <>
          <ContextMenuActionItem actionId="forge.openRepo" args={{ projectPath }}>
            <ExternalLink data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            {`View repository on ${providerName}`}
          </ContextMenuActionItem>
          <ContextMenuSeparator />
        </>
      ) : null}
      <ToolbarContextMenuItems buttonId="forge-stats" side="right" />
    </>
  );
}
