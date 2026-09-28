import { Suspense } from "react";
import type { Issue } from "@shared/types/forge";
import { useBuiltinView } from "@/registry/builtinRendererRegistry";
import type { ForgeIssueSelectorProps } from "@/types/forgeSlotProps";
import { useProjectStore } from "@/store/projectStore";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
import { UserPlus } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Avatar, avatarUrlAtSize } from "@/components/ui/Avatar";

interface IssueLinkerViewProps {
  projectPath: string;
  selectedIssue: Issue | null;
  onSelectIssue: (issue: Issue | null) => void;
  disabled?: boolean;
}

/**
 * Control only — "Issue" lives on the form's label rail, and the assign-to-me
 * checkbox is a separate {@link AssignIssueToggle} the row hangs off its hint
 * slot, the same rail "Create from remote branch" rides.
 */
export function IssueLinkerView({
  projectPath,
  selectedIssue,
  onSelectIssue,
  disabled,
}: IssueLinkerViewProps) {
  // Resolve the issue-selector view from the active provider's slot so any
  // registered forge provider can contribute it.
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const { entry } = useResolvedForgeProvider(projectId);
  const IssueSelector = useBuiltinView<ForgeIssueSelectorProps>(
    entry?.contribution.slots?.issueSelector ?? ""
  );

  if (!IssueSelector) return null;

  return (
    <Suspense fallback={null}>
      <IssueSelector
        projectPath={projectPath}
        selectedIssue={selectedIssue}
        onSelect={onSelectIssue}
        disabled={disabled}
      />
    </Suspense>
  );
}

interface AssignIssueToggleProps {
  assignWorktreeToSelf: boolean;
  onSetAssignWorktreeToSelf: (assign: boolean) => void;
  currentUser?: string;
  currentUserAvatar?: string;
  disabled?: boolean;
}

/**
 * Rides directly under the selector because it is meaningless without a linked
 * issue; the caller renders it only once the forge can actually assign one.
 */
export function AssignIssueToggle({
  assignWorktreeToSelf,
  onSetAssignWorktreeToSelf,
  currentUser,
  currentUserAvatar,
  disabled,
}: AssignIssueToggleProps) {
  return (
    <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-text-secondary hover:text-text-primary">
      {/* A checkbox, not a switch: the value is committed by Create with the rest
          of the form, and Quick Create offers the same option the same way. */}
      <Checkbox
        checked={assignWorktreeToSelf}
        onCheckedChange={(checked) => onSetAssignWorktreeToSelf(checked === true)}
        disabled={disabled}
      />
      {/* One 16px slot either way, so the label starts at the same x. */}
      {currentUser ? (
        <Avatar src={avatarUrlAtSize(currentUserAvatar, 32)} alt="" className="h-4 w-4" />
      ) : (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
          <UserPlus className="h-3.5 w-3.5" />
        </span>
      )}
      <span className="truncate">Assign to {currentUser ? `@${currentUser}` : "me"}</span>
    </label>
  );
}
