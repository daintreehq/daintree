import { ContextMenuActionItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import type { ActionId } from "@shared/types/actions";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";

export type ForgeStatsMenuSegment = "issues" | "prs" | "commits";

const SEGMENT_ITEMS = {
  issues: { actionId: "forge.openIssues", label: "View all issues" },
  prs: { actionId: "forge.openPRs", label: "View all pull requests" },
  commits: { actionId: "forge.openCommits", label: "View commits" },
} as const satisfies Record<ForgeStatsMenuSegment, { actionId: ActionId; label: string }>;

interface ForgeStatsContextMenuItemsProps {
  projectPath: string;
  /** Resolved forge provider's display name, or `null` when the project has none. */
  providerName: string | null;
  /** The pill that was right-clicked; omitted for the stats container around the pills. */
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
            {`${segmentItem.label} on ${providerName}`}
          </ContextMenuActionItem>
          <ContextMenuSeparator />
        </>
      ) : null}
      {providerName !== null && canOpenRepo ? (
        <>
          <ContextMenuActionItem actionId="forge.openRepo" args={{ projectPath }}>
            {`View repository on ${providerName}`}
          </ContextMenuActionItem>
          <ContextMenuSeparator />
        </>
      ) : null}
      <ToolbarContextMenuItems buttonId="forge-stats" side="right" />
    </>
  );
}
