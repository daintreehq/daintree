import { useState, useRef, useEffect, useMemo } from "react";
import type { MouseEvent } from "react";
import { GitCommitHorizontal, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTimeAgo } from "@/utils/timeAgo";
import type { GitCommit } from "@shared/types/github";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { parseConventionalCommit } from "./commitListUtils";

interface CommitListItemProps {
  commit: GitCommit;
  optionId?: string;
  isActive?: boolean;
}

export function CommitListItem({ commit, optionId, isActive }: CommitListItemProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const parsed = useMemo(() => parseConventionalCommit(commit.message), [commit.message]);

  const handleCopyHash = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    if (!navigator.clipboard) {
      return;
    }

    try {
      await navigator.clipboard.writeText(commit.hash);
      setCopied(true);
      timeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  const renderMessage = () => {
    if (!parsed) {
      return (
        <span className="flex-1 min-w-0 text-sm font-medium text-foreground truncate">
          {commit.message}
        </span>
      );
    }

    const typeColor = parsed.breaking ? "text-status-danger font-bold" : "text-muted-foreground";

    return (
      <span className="flex-1 min-w-0 text-sm font-medium truncate">
        <span className={typeColor}>{parsed.type}</span>
        {parsed.scope && <span className="text-muted-foreground">({parsed.scope})</span>}
        {parsed.breaking && !parsed.type.endsWith("!") && (
          <span className="text-status-danger font-bold">!</span>
        )}
        <span className="text-foreground">: {parsed.description}</span>
      </span>
    );
  };

  return (
    <div
      id={optionId}
      role="option"
      aria-selected={isActive}
      className={cn(
        "hover:bg-muted/50 transition-colors group cursor-default",
        isActive && "bg-muted/50"
      )}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        <span className="shrink-0 mt-0.5 text-muted-foreground">
          <GitCommitHorizontal className="size-4" />
        </span>

        <div className="flex-1 min-w-0">
          {/* Title row: message + trailing #hash copy */}
          <div className="flex items-center gap-1.5 min-w-0">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>{renderMessage()}</TooltipTrigger>
                <TooltipContent side="bottom">{commit.message}</TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleCopyHash}
                    className={cn(
                      "shrink-0 text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-0.5 font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded px-1",
                      copied && "text-status-success"
                    )}
                    aria-label={`Copy hash ${commit.shortHash}`}
                  >
                    {copied ? <Check className="w-3 h-3 text-status-success" /> : <span>#</span>}
                    <span>{commit.shortHash}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {copied ? "Copied!" : "Click to copy hash"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          {/* Metadata row: author · time */}
          <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>{commit.author.name}</span>
                </TooltipTrigger>
                <TooltipContent side="bottom">{commit.author.email}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <span>&middot;</span>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>{formatTimeAgo(commit.date)}</span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {(() => {
                    const d = new Date(commit.date);
                    return isNaN(d.getTime()) ? "Unknown" : d.toLocaleString();
                  })()}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </div>
    </div>
  );
}
