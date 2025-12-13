import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorktreeState } from "../../types";
import { WorktreeCard } from "./WorktreeCard";
import { WorktreeCardSkeleton } from "./WorktreeCardSkeleton";
import { ErrorBoundary } from "../ErrorBoundary";

export interface WorktreeListProps {
  worktrees: WorktreeState[];
  activeId: string | null;
  focusedId: string | null;
  onSelect: (id: string) => void;
  onCopyTree: (id: string) => void;
  onOpenEditor: (id: string) => void;
  onToggleServer: (id: string) => void;
  onOpenIssue?: (id: string, issueNumber: number) => void;
  onOpenPR?: (id: string, prUrl: string) => void;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

/**
 * Migrated from: /Users/gpriday/Projects/CopyTree/canopy/src/components/WorktreeOverview.tsx
 */
export function WorktreeList({
  worktrees,
  activeId,
  focusedId: externalFocusedId,
  onSelect,
  onCopyTree,
  onOpenEditor,
  onToggleServer,
  onOpenIssue,
  onOpenPR,
  isLoading = false,
  error = null,
  onRetry,
}: WorktreeListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [internalFocusIndex, setInternalFocusIndex] = useState(0);
  const [showScrollUp, setShowScrollUp] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [hasFocus, setHasFocus] = useState(false);

  const sortedWorktrees = useMemo(() => {
    if (worktrees.length === 0) {
      return [];
    }

    const sorted = [...worktrees].sort((a, b) => {
      if (a.isMainWorktree && !b.isMainWorktree) return -1;
      if (!a.isMainWorktree && b.isMainWorktree) return 1;

      const timeA = a.lastActivityTimestamp ?? 0;
      const timeB = b.lastActivityTimestamp ?? 0;
      if (timeA !== timeB) {
        return timeB - timeA;
      }

      const labelA = a.branch || a.name;
      const labelB = b.branch || b.name;
      return labelA.localeCompare(labelB);
    });

    return sorted;
  }, [worktrees]);

  const focusIndex = useMemo(() => {
    if (sortedWorktrees.length === 0) return 0;

    let idx: number;
    if (externalFocusedId) {
      idx = sortedWorktrees.findIndex((w) => w.id === externalFocusedId);
      if (idx < 0) idx = internalFocusIndex;
    } else {
      idx = internalFocusIndex;
    }

    return Math.max(0, Math.min(idx, sortedWorktrees.length - 1));
  }, [externalFocusedId, sortedWorktrees, internalFocusIndex]);

  const focusedWorktree = sortedWorktrees[focusIndex];

  useEffect(() => {
    if (!focusedWorktree) return;
    const itemEl = itemRefs.current.get(focusedWorktree.id);
    if (itemEl) {
      itemEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [focusIndex, focusedWorktree]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    setShowScrollUp(scrollTop > 10);
    setShowScrollDown(scrollTop + clientHeight < scrollHeight - 10);
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    const checkScroll = () => {
      setShowScrollUp(el.scrollTop > 10);
      setShowScrollDown(el.scrollTop + el.clientHeight < el.scrollHeight - 10);
    };

    checkScroll();
    // Also check after a short delay to handle initial render
    const timeout = setTimeout(checkScroll, 100);
    return () => clearTimeout(timeout);
  }, [sortedWorktrees]);

  useEffect(() => {
    if (!hasFocus) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if user is typing in an input or textarea
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      // Skip if event originates from interactive elements (buttons, links)
      // This allows buttons inside cards to function properly
      if (
        target.tagName === "BUTTON" ||
        target.tagName === "A" ||
        target.closest("button") ||
        target.closest("a")
      ) {
        return;
      }

      switch (e.key) {
        case "ArrowDown":
        case "j":
          e.preventDefault();
          setInternalFocusIndex((i) => Math.min(i + 1, sortedWorktrees.length - 1));
          break;
        case "ArrowUp":
        case "k":
          e.preventDefault();
          setInternalFocusIndex((i) => Math.max(i - 1, 0));
          break;
        case "Home":
          e.preventDefault();
          setInternalFocusIndex(0);
          break;
        case "End":
          e.preventDefault();
          setInternalFocusIndex(sortedWorktrees.length - 1);
          break;
        case "Enter":
        case " ":
          if (focusedWorktree) {
            e.preventDefault();
            onSelect(focusedWorktree.id);
          }
          break;
        case "c":
          if (focusedWorktree) {
            e.preventDefault();
            onCopyTree(focusedWorktree.id);
          }
          break;
        case "e":
          if (focusedWorktree) {
            e.preventDefault();
            onOpenEditor(focusedWorktree.id);
          }
          break;
        case "s":
          if (focusedWorktree) {
            e.preventDefault();
            onToggleServer(focusedWorktree.id);
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    hasFocus,
    focusIndex,
    sortedWorktrees,
    focusedWorktree,
    onSelect,
    onCopyTree,
    onOpenEditor,
    onToggleServer,
  ]);

  const handleFocus = useCallback(() => {
    setHasFocus(true);
  }, []);

  const handleBlur = useCallback((e: React.FocusEvent) => {
    // Only lose focus if the new focus target is outside this component
    if (!listRef.current?.contains(e.relatedTarget)) {
      setHasFocus(false);
    }
  }, []);

  const setItemRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      itemRefs.current.set(id, el);
    } else {
      itemRefs.current.delete(id);
    }
  }, []);

  // Show skeleton placeholders to prevent layout shift
  if (isLoading) {
    return (
      <div className="relative h-full">
        <div
          className="flex flex-col h-full overflow-y-auto"
          tabIndex={0}
          role="list"
          aria-label="Worktree list"
          aria-busy="true"
        >
          <div role="listitem">
            <WorktreeCardSkeleton />
          </div>
          <div role="listitem">
            <WorktreeCardSkeleton />
          </div>
          <div role="listitem">
            <WorktreeCardSkeleton />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="flex flex-col items-center justify-center h-full p-4 text-[var(--color-status-error)]"
        role="alert"
        aria-live="assertive"
      >
        <svg
          className="w-8 h-8 mb-2"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        <span className="text-sm mb-2">{error}</span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="text-xs px-3 py-1 border border-canopy-border rounded hover:bg-canopy-border text-canopy-text"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (sortedWorktrees.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4">
        <div className="bg-canopy-bg border border-canopy-border/40 rounded-[var(--radius-xl)] p-8 flex flex-col items-center max-w-sm text-center shadow-sm">
          <div className="h-12 w-12 bg-canopy-accent/10 rounded-full flex items-center justify-center mb-4">
            <svg
              className="w-6 h-6 text-canopy-accent"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
              />
            </svg>
          </div>
          <span className="text-sm font-medium text-canopy-text">No worktrees yet</span>
          <span className="text-xs text-canopy-text/60 mt-2">
            Use <strong>File → Open Directory</strong> to open a git repository
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full" onFocus={handleFocus} onBlur={handleBlur}>
      {showScrollUp && (
        <div className="absolute top-0 left-0 right-0 h-8 bg-gradient-to-b from-canopy-sidebar to-transparent pointer-events-none z-10 flex items-center justify-center">
          <span className="text-xs text-canopy-text/60">↑ more worktrees</span>
        </div>
      )}

      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex flex-col h-full overflow-y-auto"
        tabIndex={0}
        role="list"
        aria-label="Worktree list"
      >
        {sortedWorktrees.map((worktree, index) => (
          <div
            key={worktree.id}
            ref={(el) => setItemRef(worktree.id, el)}
            role="listitem"
            aria-current={worktree.id === activeId ? "true" : undefined}
            id={worktree.id}
          >
            <ErrorBoundary
              variant="component"
              componentName="WorktreeCard"
              resetKeys={[worktree.id]}
              context={{ worktreeId: worktree.id }}
            >
              <WorktreeCard
                worktree={worktree}
                isActive={worktree.id === activeId}
                isFocused={index === focusIndex && hasFocus}
                onSelect={() => onSelect(worktree.id)}
                onCopyTree={() => onCopyTree(worktree.id)}
                onOpenEditor={() => onOpenEditor(worktree.id)}
                onToggleServer={() => onToggleServer(worktree.id)}
                onOpenIssue={
                  worktree.issueNumber && onOpenIssue
                    ? () => onOpenIssue(worktree.id, worktree.issueNumber!)
                    : undefined
                }
                onOpenPR={
                  worktree.prUrl && worktree.prNumber && onOpenPR
                    ? () => onOpenPR(worktree.id, worktree.prUrl!)
                    : undefined
                }
              />
            </ErrorBoundary>
          </div>
        ))}
      </div>

      {showScrollDown && (
        <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-canopy-sidebar to-transparent pointer-events-none z-10 flex items-center justify-center">
          <span className="text-xs text-canopy-text/60">↓ more worktrees</span>
        </div>
      )}
    </div>
  );
}
