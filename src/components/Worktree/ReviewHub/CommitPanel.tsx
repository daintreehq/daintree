import { useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { GitCommit, ArrowUpFromLine } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/button";

const MAX_SUBJECT_LENGTH = 72;

interface CommitPanelProps {
  stagedCount: number;
  isDetachedHead: boolean;
  hasConflicts: boolean;
  hasRemote: boolean;
  commitMessage: string;
  onCommitMessageChange: (message: string) => void;
  onCommit: (message: string) => Promise<void>;
  onCommitAndPush: (message: string) => Promise<void>;
}

export function CommitPanel({
  stagedCount,
  isDetachedHead,
  hasConflicts,
  hasRemote,
  commitMessage,
  onCommitMessageChange,
  onCommit,
  onCommitAndPush,
}: CommitPanelProps) {
  const [isCommitting, setIsCommitting] = useState(false);
  const [isPushing, setIsPushing] = useState(false);

  const subjectLine = commitMessage.split("\n")[0] || "";
  const isOverLimit = subjectLine.length > MAX_SUBJECT_LENGTH;
  const isBusy = isCommitting || isPushing;
  const canCommit =
    stagedCount > 0 && commitMessage.trim().length > 0 && !isDetachedHead && !hasConflicts;

  const handleCommit = useCallback(async () => {
    if (!canCommit || isBusy) return;
    setIsCommitting(true);
    try {
      await onCommit(commitMessage);
      onCommitMessageChange("");
    } catch {
      // Error is handled by the parent via setActionError
    } finally {
      setIsCommitting(false);
    }
  }, [canCommit, isBusy, commitMessage, onCommit, onCommitMessageChange]);

  const handleCommitAndPush = useCallback(async () => {
    if (!canCommit || isBusy) return;
    setIsPushing(true);
    try {
      await onCommitAndPush(commitMessage);
      onCommitMessageChange("");
    } catch {
      // Error is handled by the parent via setActionError
    } finally {
      setIsPushing(false);
    }
  }, [canCommit, isBusy, commitMessage, onCommitAndPush, onCommitMessageChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (e.shiftKey && hasRemote) {
          void handleCommitAndPush();
        } else {
          void handleCommit();
        }
      }
    },
    [handleCommit, handleCommitAndPush, hasRemote]
  );

  return (
    <div className="border-t border-divider p-3 space-y-2">
      {isDetachedHead && (
        <div className="text-xs text-status-warning bg-status-warning/10 rounded px-2 py-1.5">
          Detached HEAD — commits are not allowed in this state.
        </div>
      )}

      <div className="relative">
        <textarea
          value={commitMessage}
          onChange={(e) => onCommitMessageChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Commit message…"
          rows={4}
          disabled={isBusy || isDetachedHead}
          className={cn(
            "w-full resize-none rounded-md border bg-canopy-bg px-3 py-2 text-xs font-mono",
            "placeholder:text-canopy-text/30 text-canopy-text",
            "focus:outline-none focus:ring-2 focus:ring-canopy-accent focus:border-transparent",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            isOverLimit ? "border-status-warning" : "border-divider"
          )}
        />
        <div
          className={cn(
            "absolute bottom-1.5 right-2 text-[10px]",
            isOverLimit ? "text-status-warning" : "text-canopy-text/30"
          )}
        >
          <span className="tabular-nums">
            {subjectLine.length}/{MAX_SUBJECT_LENGTH}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {hasRemote ? (
          <>
            <Button
              variant="default"
              size="sm"
              onClick={() => void handleCommitAndPush()}
              disabled={!canCommit || isBusy}
              className="flex-1"
            >
              {isPushing ? (
                <Spinner size="sm" className="mr-1.5" />
              ) : (
                <ArrowUpFromLine className="w-3.5 h-3.5 mr-1.5" />
              )}
              Commit & Push
            </Button>
            <Button
              variant="subtle"
              size="sm"
              onClick={() => void handleCommit()}
              disabled={!canCommit || isBusy}
              className="flex-1"
            >
              {isCommitting ? (
                <Spinner size="sm" className="mr-1.5" />
              ) : (
                <GitCommit className="w-3.5 h-3.5 mr-1.5" />
              )}
              Commit (<span className="tabular-nums">{stagedCount}</span>)
            </Button>
          </>
        ) : (
          <Button
            variant="default"
            size="sm"
            onClick={() => void handleCommit()}
            disabled={!canCommit || isBusy}
            className="flex-1"
          >
            {isCommitting ? (
              <Spinner size="sm" className="mr-1.5" />
            ) : (
              <GitCommit className="w-3.5 h-3.5 mr-1.5" />
            )}
            Commit (<span className="tabular-nums">{stagedCount}</span>)
          </Button>
        )}
      </div>
    </div>
  );
}
