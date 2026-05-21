import type { GitHubIssue } from "@shared/types/github";
import { getBuiltinView } from "@/registry/builtinRendererRegistry";
import type { IssueSelectorProps } from "@github-renderer/components/IssueSelector";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Info, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";

interface IssueLinkerViewProps {
  projectPath: string;
  selectedIssue: GitHubIssue | null;
  onSelectIssue: (issue: GitHubIssue | null) => void;
  canAssignIssue: boolean;
  assignWorktreeToSelf: boolean;
  onSetAssignWorktreeToSelf: (assign: boolean) => void;
  currentUser?: string;
  currentUserAvatar?: string;
  disabled?: boolean;
}

export function IssueLinkerView({
  projectPath,
  selectedIssue,
  onSelectIssue,
  canAssignIssue,
  assignWorktreeToSelf,
  onSetAssignWorktreeToSelf,
  currentUser,
  currentUserAvatar,
  disabled,
}: IssueLinkerViewProps) {
  const IssueSelector = getBuiltinView<IssueSelectorProps>("github.issueSelector");
  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <label className="block text-sm font-medium text-daintree-text">
            Link Issue (Optional)
          </label>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-daintree-text/40 hover:text-daintree-text/60 transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent focus-visible:ring-offset-2"
                aria-label="Help for Link Issue field"
                disabled={disabled}
              >
                <Info className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="sr-only">Help for Link Issue field</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Select an issue to auto-generate a branch name</p>
            </TooltipContent>
          </Tooltip>
        </div>
        {IssueSelector && (
          <IssueSelector
            projectPath={projectPath}
            selectedIssue={selectedIssue}
            onSelect={onSelectIssue}
            disabled={disabled}
          />
        )}
      </div>

      {canAssignIssue && (
        <div className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] border bg-daintree-bg/50 border-daintree-border transition-colors">
          {currentUserAvatar ? (
            <img
              src={`${currentUserAvatar}${currentUserAvatar.includes("?") ? "&" : "?"}s=64`}
              alt={currentUser}
              className="w-8 h-8 rounded-full shrink-0"
            />
          ) : (
            <div className="flex items-center justify-center w-8 h-8 rounded-full shrink-0 bg-overlay-medium text-daintree-text/60">
              <UserPlus className="w-4 h-4" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-daintree-text">Assign to me</span>
              <span className="text-xs text-daintree-text/50 font-mono">@{currentUser}</span>
            </div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={assignWorktreeToSelf}
              onChange={(e) => onSetAssignWorktreeToSelf(e.target.checked)}
              disabled={disabled}
              className="sr-only peer"
              aria-label="Assign issue to me when creating worktree"
            />
            <div
              className={cn(
                "w-9 h-5 rounded-full transition-colors",
                "peer-focus-visible:ring-2 peer-focus-visible:ring-daintree-accent",
                "after:content-[''] after:absolute after:top-0.5 after:left-0.5",
                "after:rounded-full after:h-4 after:w-4",
                "after:transition-transform after:duration-150",
                assignWorktreeToSelf
                  ? "bg-daintree-accent after:translate-x-4 after:bg-text-inverse"
                  : "bg-daintree-border after:translate-x-0 after:bg-daintree-text",
                disabled && "opacity-50 cursor-not-allowed"
              )}
            />
          </label>
        </div>
      )}
    </>
  );
}
