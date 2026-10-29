import { Suspense, useRef, useState } from "react";
import type { Issue } from "@shared/types/forge";
import { useBuiltinView } from "@/registry/builtinRendererRegistry";
import type { ForgeIssueSelectorProps } from "@/types/forgeSlotProps";
import { useProjectStore } from "@/store/projectStore";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
import { ChevronsUpDown, CircleDot, UserPlus, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Avatar, avatarUrlAtSize } from "@/components/ui/Avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { FIELD_SURFACE } from "./WorktreeFormLayout";
// Eager, not lazy: while a lazy chunk loaded there would be no dialog to take
// Escape, and it would close the New Worktree dialog underneath instead.
import { IssuePickerDialog } from "../IssuePickerDialog";

interface IssueLinkerViewProps {
  projectPath: string;
  selectedIssue: Issue | null;
  onSelectIssue: (issue: Issue | null) => void;
  disabled?: boolean;
  /** Reports the host picker opening and closing, so the form can stand its own shortcuts down. */
  onPickerOpenChange?: (open: boolean) => void;
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
  onPickerOpenChange,
}: IssueLinkerViewProps) {
  // Resolve the issue-selector view from the issues provider's slot so any
  // registered forge provider can contribute it — the code forge's unless the
  // project binds its issues elsewhere.
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const { entry } = useResolvedForgeProvider(projectId).issues;
  const IssueSelector = useBuiltinView<ForgeIssueSelectorProps>(
    entry?.contribution.slots?.issueSelector ?? ""
  );

  if (!IssueSelector) {
    return (
      <HostIssueSelector
        projectPath={projectPath}
        selectedIssue={selectedIssue}
        onSelectIssue={onSelectIssue}
        disabled={disabled}
        onPickerOpenChange={onPickerOpenChange}
      />
    );
  }

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

/**
 * The host's own issue field, for an issues provider that contributes no
 * `issueSelector` slot. It lists through the same `listIssues` path as the
 * worktree card's "Attach issue…", so any provider that can list issues can be
 * linked from here without shipping a picker of its own.
 */
function HostIssueSelector({
  projectPath,
  selectedIssue,
  onSelectIssue,
  disabled,
  onPickerOpenChange,
}: IssueLinkerViewProps) {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onPickerOpenChange?.(next);
  };
  // Stays mounted after the first open so the dialog can play its exit.
  const [pickerMounted, setPickerMounted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const issueLabel = selectedIssue ? (selectedIssue.key ?? `#${selectedIssue.number}`) : null;

  return (
    <>
      <div
        className={cn(
          FIELD_SURFACE,
          "flex h-8 items-center overflow-hidden",
          disabled && "opacity-50"
        )}
      >
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-label={selectedIssue ? `Issue ${issueLabel} ${selectedIssue.title}` : undefined}
          onClick={() => {
            setPickerMounted(true);
            setOpen(true);
          }}
          className={cn(
            "flex h-full min-w-0 flex-1 items-center justify-between gap-2 px-2.5",
            "text-sm text-text-primary transition-colors duration-150 ease-out",
            "hover:bg-surface-hover",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
            "disabled:cursor-not-allowed"
          )}
          disabled={disabled}
        >
          {selectedIssue ? (
            <span className="flex items-center gap-2 truncate">
              <CircleDot className="w-3 h-3 text-pr-open shrink-0" aria-hidden="true" />
              <span className="truncate">
                {issueLabel} {selectedIssue.title}
              </span>
            </span>
          ) : (
            <span className="text-text-secondary">Select an issue (optional)</span>
          )}
          <ChevronsUpDown className="h-4 w-4 text-text-secondary shrink-0" aria-hidden="true" />
        </button>
        {selectedIssue && !disabled && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Clear the linked issue"
                onClick={() => {
                  onSelectIssue(null);
                  // This button unmounts with the selection it clears, so hand
                  // focus to the control that survives.
                  triggerRef.current?.focus();
                }}
                className={cn(
                  "flex h-full w-8 shrink-0 items-center justify-center border-l border-border-subtle",
                  "text-text-secondary transition-colors duration-150 ease-out",
                  "hover:bg-overlay-hover hover:text-text-primary",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
                )}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">Clear selection</TooltipContent>
          </Tooltip>
        )}
      </div>
      {pickerMounted && (
        <IssuePickerDialog
          isOpen={open}
          onClose={() => setOpen(false)}
          zIndex="nested"
          draft
          worktree={{
            path: projectPath,
            issueProviderId: selectedIssue?.providerId,
            issueKey: selectedIssue?.key,
          }}
          currentIssueNumber={selectedIssue?.number}
          onAttach={onSelectIssue}
          onDetach={() => onSelectIssue(null)}
        />
      )}
    </>
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
