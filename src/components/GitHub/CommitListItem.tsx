import { useState, useRef, useEffect, useMemo } from "react";
import type { MouseEvent } from "react";
import { GitCommitHorizontal, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTimeAgo } from "@/utils/timeAgo";
import type { GitCommit } from "@shared/types/github";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { parseConventionalCommit, getCommitTypeColor } from "./commitListUtils";

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
      return <span className="text-sm font-medium text-foreground truncate">{commit.message}</span>;
    }

    const typeColor = parsed.breaking
      ? "text-status-danger font-bold"
      : getCommitTypeColor(parsed.type);

    return (
      <span className="text-sm font-medium truncate">
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
        "p-3 hover:bg-muted/50 transition-colors group cursor-default",
        isActive && "bg-muted/50"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 text-muted-foreground">
          <GitCommitHorizontal className="h-4 w-4" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>{renderMessage()}</TooltipTrigger>
                <TooltipContent side="bottom">{commit.message}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleCopyHash}
                    className={cn(
                      "font-mono hover:text-foreground transition-colors flex items-center gap-1",
                      copied && "text-status-success"
                    )}
                  >
                    <span>{commit.shortHash}</span>
                    <span className="relative h-3 w-3 shrink-0">
                      <Copy
                        className={cn(
                          "absolute inset-0 h-3 w-3 transition-opacity",
                          copied ? "opacity-0" : "opacity-0 group-hover:opacity-100"
                        )}
                      />
                      <Check
                        className={cn(
                          "absolute inset-0 h-3 w-3 transition-opacity",
                          copied ? "opacity-100" : "opacity-0"
                        )}
                      />
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {copied ? "Copied!" : "Click to copy hash"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <span>&middot;</span>
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
                  {new Date(commit.date).toLocaleString()}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </div>
    </div>
  );
}
