# Synthesized Implementation Plan: Fix PR Detection for All Worktrees

## Problem Statement

PR detection currently only works for worktrees that have an **issue number** extracted from the branch name (e.g., `feature/123-new-ui`). Worktrees with branches like `feature/dark-mode` (no issue number) are completely ignored, even if they have an associated open PR on GitHub.

The root cause is in `PullRequestService.handleWorktreeUpdate()` at line 72:

```typescript
if (newIssueNumber) {
  this.candidates.set(state.worktreeId, { ... });
} else {
  // Worktree is REMOVED from candidates
}
```

This means only worktrees with `issueNumber` become candidates for PR checking.

## Analysis of Implementation Guides

### Common Ground (All Guides Agree)

1. The fix requires modifying `handleWorktreeUpdate()` to accept worktrees with **either** an issue number **or** a valid branch name
2. The `GitHubService.buildBatchPRQuery()` already supports branch-only lookups (lines 177-192 in `GitHubQueries.ts`)
3. The UI already displays PRs correctly when `prNumber` is set - no UI changes needed

### Conflicts Resolved

| Conflict                           | Guide 1                  | Guide 2/3                  | Resolution                                                                                       |
| ---------------------------------- | ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------ |
| Filter criteria for valid branches | Exclude `main/master`    | Exclude `HEAD`             | **Exclude both** - `main`, `master`, and `HEAD` are not useful candidates                        |
| When to clear PR state             | Always on context change | Only on branch change      | **Only on branch change** - gaining an issue number shouldn't clear a found PR                   |
| Polling resolved candidates        | Don't re-poll            | Re-poll for status updates | **Don't re-poll aggressively** - rely on manual refresh for status updates to minimize API calls |

### Key Design Decisions

1. **Candidate Registration**: Track worktrees if `issueNumber || (branchName && !isDefaultBranch)`
2. **State Clearing**: Only emit `sys:pr:cleared` when the branch actually changes, not just when issue number changes
3. **Logging**: Use `logDebug` instead of `logInfo` for context changes to reduce noise
4. **Issue Number Fallback**: When emitting `sys:pr:detected`, use the issue number from candidate context if not returned from GitHub

## Implementation Plan

### Step 1: Modify `handleWorktreeUpdate()` in `PullRequestService.ts`

**File**: `electron/services/PullRequestService.ts`

Replace the candidate tracking logic (lines 72-88) with:

```typescript
private handleWorktreeUpdate(state: WorktreeState): void {
  if (!this.isPolling) {
    return;
  }

  const currentContext = this.candidates.get(state.worktreeId);
  const newIssueNumber = state.issueNumber;
  const newBranchName = state.branch;

  // Define what makes a valid trackable branch
  const isDefaultBranch = newBranchName === "main" || newBranchName === "master";
  const isDetachedHead = newBranchName === "HEAD" || !newBranchName;
  const hasTrackableBranch = !isDefaultBranch && !isDetachedHead;

  // Track candidate if we have an issue number OR a valid (non-default) branch
  const shouldTrack = !!newIssueNumber || hasTrackableBranch;

  const contextChanged =
    currentContext?.issueNumber !== newIssueNumber ||
    currentContext?.branchName !== newBranchName;

  // Only clear PR state if the BRANCH changed (not just issue number)
  if (contextChanged && currentContext) {
    const branchChanged = currentContext.branchName !== newBranchName;

    if (branchChanged) {
      logDebug("Worktree branch changed - clearing PR state", {
        worktreeId: state.worktreeId,
        oldBranch: currentContext.branchName,
        newBranch: newBranchName,
      });

      this.resolvedWorktrees.delete(state.worktreeId);
      this.detectedPRs.delete(state.worktreeId);

      events.emit("sys:pr:cleared", { worktreeId: state.worktreeId });
    }
  }

  if (shouldTrack) {
    this.candidates.set(state.worktreeId, {
      issueNumber: newIssueNumber,
      branchName: newBranchName,
    });

    // Schedule check if unresolved
    if (!this.resolvedWorktrees.has(state.worktreeId)) {
      this.scheduleDebounceCheck();
    }
  } else {
    if (currentContext) {
      this.candidates.delete(state.worktreeId);
      logDebug("Worktree not trackable - removed from candidates", {
        worktreeId: state.worktreeId,
        reason: isDefaultBranch ? "default branch" : "detached HEAD or no branch",
      });
    }
  }
}
```

### Step 2: Update `checkForPRs()` to Handle Missing Issue Number

**File**: `electron/services/PullRequestService.ts`

The `sys:pr:detected` event currently requires `issueNumber!` (line 279). Update to handle cases where issue number is undefined:

```typescript
events.emit("sys:pr:detected", {
  worktreeId,
  prNumber: checkResult.pr.number,
  prUrl: checkResult.pr.url,
  prState: checkResult.pr.state,
  issueNumber: checkResult.issueNumber ?? this.candidates.get(worktreeId)?.issueNumber,
});
```

Note: The event schema allows `issueNumber` to be optional/undefined since PRs can exist without linked issues.

### Step 3: Verify Type Definitions

**File**: `electron/services/events.ts`

Ensure the `sys:pr:detected` event type allows optional `issueNumber`:

```typescript
"sys:pr:detected": {
  worktreeId: string;
  prNumber: number;
  prUrl: string;
  prState: "open" | "merged" | "closed";
  issueNumber?: number; // Make optional
}
```

## Files to Modify

1. `electron/services/PullRequestService.ts` - Core logic change (Steps 1-2)
2. `electron/services/events.ts` - Type definition update (Step 3, if needed)

## Testing Checklist

1. **Branch with issue number**: `feature/123-fix-bug` should detect PRs via issue timeline AND branch name
2. **Branch without issue number**: `feature/new-feature` should detect PRs via branch name only
3. **Default branches**: `main` and `master` should NOT be tracked as candidates
4. **Detached HEAD**: Should NOT be tracked as a candidate
5. **Branch switch**: Switching branches should clear and re-detect PRs
6. **Issue number added**: Adding an issue number to an existing tracked branch should NOT clear existing PR state

## Trade-offs Acknowledged

1. **API Usage**: More worktrees will be tracked as candidates, slightly increasing GitHub API usage
2. **No Status Polling**: Resolved PRs won't update status (open→merged) without manual refresh
3. **Logging Verbosity**: Changed from `logInfo` to `logDebug` for context changes - less visibility but cleaner logs

## Why This Plan is Optimal

1. **Minimal Change Surface**: Only modifies one method significantly; rest are minor adjustments
2. **Backward Compatible**: Existing issue-number-based tracking continues to work
3. **Already Supported**: GitHubService/Queries already handle branch-only lookups - we're just enabling the path
4. **UI Ready**: WorktreeCard already renders PRs correctly; no frontend changes needed
