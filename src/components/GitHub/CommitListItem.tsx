import { useState, useRef, useEffect } from "react";
import type { MouseEvent } from "react";
import { GitCommitHorizontal, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GitCommit } from "@shared/types/github";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

interface CommitListItemProps {
  commit: GitCommit;
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}

export function CommitListItem({ commit }: CommitListItemProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

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

  return (
    <div className="p-3 hover:bg-muted/50 transition-colors group cursor-default">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 text-muted-foreground">
          <GitCommitHorizontal className="h-4 w-4" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-sm font-medium text-foreground truncate">
                    {commit.message}
                  </span>
                </TooltipTrigger>
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
                      copied && "text-[var(--color-status-success)]"
                    )}
                  >
                    {copied ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <Copy className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                    )}
                    <span>{commit.shortHash}</span>
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
