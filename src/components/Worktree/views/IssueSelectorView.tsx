import { Suspense } from "react";
import type { Issue } from "@shared/types/forge";
import { useBuiltinView } from "@/registry/builtinRendererRegistry";
import type { ForgeIssueSelectorProps } from "@/types/forgeSlotProps";
import { useProjectStore } from "@/store/projectStore";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
import { UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";

interface IssueLinkerViewProps {
  projectPath: string;
  selectedIssue: Issue | null;
  onSelectIssue: (issue: Issue | null) => void;
  disabled?: boolean;
}

/**
 * Control only — "Issue" lives on the form's label rail, and the assign-to-me
 * switch is a separate {@link AssignIssueToggle} the row hangs off its hint
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
    <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-text-secondary hover:text-daintree-text">
      <span className="relative inline-flex shrink-0">
        <input
          type="checkbox"
          checked={assignWorktreeToSelf}
          onChange={(e) => onSetAssignWorktreeToSelf(e.target.checked)}
          disabled={disabled}
          aria-label="Assign issue to me when creating worktree"
          className={cn(
            "h-4 w-7 appearance-none rounded-full border transition-colors duration-150 ease-out",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2",
            assignWorktreeToSelf
              ? "border-daintree-text bg-daintree-text"
              : "border-border-strong bg-surface-inset",
            disabled && "cursor-not-allowed opacity-50"
          )}
        />
        <span
          className={cn(
            "pointer-events-none absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full",
            "transition-[left] duration-150 ease-out",
            assignWorktreeToSelf ? "left-[0.875rem] bg-text-inverse" : "left-0.5 bg-text-secondary"
          )}
          aria-hidden="true"
        />
      </span>
      {currentUserAvatar ? (
        <img
          src={`${currentUserAvatar}${currentUserAvatar.includes("?") ? "&" : "?"}s=48`}
          alt=""
          className="h-4 w-4 shrink-0 rounded-full"
        />
      ) : (
        <UserPlus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="truncate">Assign to {currentUser ? `@${currentUser}` : "me"}</span>
    </label>
  );
}
