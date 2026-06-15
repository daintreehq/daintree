// Eager-loaded buffer for `daintree:view-diff` requests. DiffViewerModalHost
// lives in a lazy chunk, so its event listener registers only after that chunk
// loads — a request dispatched before then (first open right after hydration,
// or the re-dispatch that resets a crashed host boundary) would otherwise be
// lost. AppInner's always-mounted listener stashes the latest request here and
// the host consumes it on mount. Mirrors `pendingViewFileRequest` for the
// read-only file viewer.

import type { GitStatus } from "@shared/types";

const GIT_STATUSES: GitStatus[] = [
  "modified",
  "added",
  "deleted",
  "untracked",
  "renamed",
  "copied",
  "ignored",
  "conflicted",
];

function isGitStatus(value: unknown): value is GitStatus {
  return typeof value === "string" && GIT_STATUSES.includes(value as GitStatus);
}

export interface ViewDiffRequest {
  path: string;
  worktreePath?: string;
  status: GitStatus;
}

let pending: ViewDiffRequest | null = null;

export function parseViewDiffEvent(e: Event): ViewDiffRequest | null {
  if (!(e instanceof CustomEvent)) return null;
  const detail = e.detail as unknown;
  const d = detail as { path?: unknown; worktreePath?: unknown; status?: unknown };
  if (typeof d?.path !== "string" || !d.path) return null;
  return {
    path: d.path,
    worktreePath: typeof d.worktreePath === "string" && d.worktreePath ? d.worktreePath : undefined,
    status: isGitStatus(d.status) ? d.status : "modified",
  };
}

export function stashViewDiffRequest(e: Event): void {
  const request = parseViewDiffEvent(e);
  if (request) pending = request;
}

export function consumePendingViewDiffRequest(): ViewDiffRequest | null {
  const request = pending;
  pending = null;
  return request;
}
