import type {
  CreateIssueInput,
  CreatePRInput,
  EditIssueInput,
  EditPRInput,
  ForgeLabel,
  Issue,
  IssueCloseReason,
  IssueComment,
  MergePRInput,
  PR,
  RepoRef,
  ReviewerRequest,
} from "../../../../shared/types/forge.js";
import { GitHubAuth, GITHUB_API_TIMEOUT_MS } from "./GitHubAuth.js";
import {
  GET_PR_NODE_ID_QUERY,
  CONVERT_PR_TO_DRAFT_MUTATION,
  MARK_PR_READY_FOR_REVIEW_MUTATION,
} from "./GitHubQueries.js";
import { clearGitHubCaches, clearPRCaches, issueTooltipCache } from "./GitHubCaches.js";
import {
  isoToMs,
  restToForgeIssue,
  restToForgeLabels,
  restToForgePR,
  restUserToForgeUser,
} from "./mappers.js";
import { dispatchQuery } from "./queryInfra.js";

function requireGitHubToken(): string {
  const token = GitHubAuth.getToken();
  if (!token) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }
  return token;
}

function githubMutationHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

/**
 * Shared `PATCH /repos/{owner}/{repo}/issues/{number}` call backing
 * close/reopen/edit. Sends the given partial issue fields, validates the
 * mutation result, clears the issue caches, and returns the normalized
 * {@link Issue}. Callers own building the body (state/state_reason/title/body).
 */
async function patchIssue(
  repo: RepoRef,
  issueNumber: number,
  fields: Record<string, unknown>,
  failurePrefix: string
): Promise<Issue> {
  const token = requireGitHubToken();
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: githubMutationHeaders(token),
    body: JSON.stringify(fields),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `${failurePrefix}: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.number !== "number" || typeof data.html_url !== "string") {
    throw new Error("Unexpected response from GitHub: missing issue number or URL.");
  }
  // Provider-owned invalidation: state/title/body changes affect list and stat
  // views, so drop the caches (mirrors createIssue).
  clearGitHubCaches();
  return restToForgeIssue(data);
}

// Shared PATCH for close/reopen — both flip `state` on the same endpoint.
async function patchPRState(
  repo: RepoRef,
  prNumber: number,
  state: "open" | "closed"
): Promise<void> {
  const token = requireGitHubToken();
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: githubMutationHeaders(token),
    body: JSON.stringify({ state }),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const verb = state === "closed" ? "close" : "reopen";
    throw new Error(
      `Failed to ${verb} pull request #${prNumber}: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
}

// Resolve a PR's GraphQL node id for the draft-toggle mutations.
async function fetchPRNodeId(repo: RepoRef, prNumber: number): Promise<string> {
  const response = await dispatchQuery(
    GET_PR_NODE_ID_QUERY,
    { owner: repo.owner, repo: repo.repo, number: prNumber },
    "GET_PR_NODE_ID_QUERY"
  );
  const id = (response as { repository?: { pullRequest?: { id?: unknown } | null } | null })
    ?.repository?.pullRequest?.id;
  if (typeof id !== "string" || !id) {
    throw new Error(`Pull request #${prNumber} not found.`);
  }
  return id;
}

const REVIEW_WRITE_HEADERS = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
});

/**
 * Submit a review verdict (`APPROVE` / `REQUEST_CHANGES`) on a PR. GitHub
 * returns 200 on success and 422 for refusals like approving your own PR — the
 * response body is surfaced so the caller sees the forge's own reason.
 */
export async function submitReviewImpl(
  repo: RepoRef,
  prNumber: number,
  event: "APPROVE" | "REQUEST_CHANGES",
  body?: string
): Promise<void> {
  const token = GitHubAuth.getToken();
  if (!token) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/reviews`;
  const payload: Record<string, unknown> = { event };
  if (body !== undefined) payload.body = body;
  const response = await fetch(url, {
    method: "POST",
    headers: REVIEW_WRITE_HEADERS(token),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const verb = event === "APPROVE" ? "approve" : "request changes on";
    throw new Error(
      `Failed to ${verb} PR #${prNumber}: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
  // A submitted verdict changes the PR's `reviewDecision`, which is part of the
  // cached PR object — invalidate so the next `getPR` reflects it (#9061).
  clearPRCaches();
}

export async function dismissReviewImpl(
  repo: RepoRef,
  prNumber: number,
  reviewId: number,
  message: string
): Promise<void> {
  const token = GitHubAuth.getToken();
  if (!token) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/reviews/${reviewId}/dismissals`;
  const response = await fetch(url, {
    method: "PUT",
    headers: REVIEW_WRITE_HEADERS(token),
    body: JSON.stringify({ message, event: "DISMISS" }),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to dismiss review ${reviewId} on PR #${prNumber}: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
  clearPRCaches();
}

export async function requestReviewersImpl(
  repo: RepoRef,
  prNumber: number,
  reviewers: ReviewerRequest
): Promise<void> {
  const token = GitHubAuth.getToken();
  if (!token) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }
  const users = reviewers.users ?? [];
  const teams = reviewers.teams ?? [];
  if (users.length === 0 && teams.length === 0) {
    throw new Error("Provide at least one user or team to request a review from");
  }
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/requested_reviewers`;
  const response = await fetch(url, {
    method: "POST",
    headers: REVIEW_WRITE_HEADERS(token),
    // GitHub keys teams separately as `team_reviewers` (team slugs).
    body: JSON.stringify({ reviewers: users, team_reviewers: teams }),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to request reviewers on PR #${prNumber}: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
}

export async function createIssueImpl(repo: RepoRef, input: CreateIssueInput): Promise<Issue> {
  const token = GitHubAuth.getToken();
  if (!token) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }
  const title = input.title?.trim();
  if (!title) {
    throw new Error("Issue title is required.");
  }
  const requestBody: Record<string, unknown> = { title };
  if (input.body) requestBody.body = input.body;
  if (input.labels && input.labels.length > 0) requestBody.labels = input.labels;

  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // 410 Gone = issues are disabled on the repository.
    if (response.status === 410) {
      throw new Error("Issues are disabled for this repository.");
    }
    throw new Error(
      `Failed to create issue: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
  const data = (await response.json()) as Record<string, unknown>;
  // Guard the mutation result: a malformed body must not surface as
  // "Issue #undefined created" with an empty URL after caches are cleared.
  if (typeof data.number !== "number" || typeof data.html_url !== "string") {
    throw new Error("Unexpected response from GitHub: missing issue number or URL.");
  }
  // Provider-owned invalidation: drop list/stat caches so the new issue
  // shows up in subsequent listIssues calls (callers no longer clear).
  clearGitHubCaches();
  return restToForgeIssue(data);
}

export async function assignIssueImpl(
  repo: RepoRef,
  issueNumber: number,
  username: string
): Promise<void> {
  const token = GitHubAuth.getToken();
  if (!token) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}/assignees`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ assignees: [username] }),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to assign issue #${issueNumber} to ${username}: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
}

export async function unassignIssueImpl(
  repo: RepoRef,
  issueNumber: number,
  username: string
): Promise<void> {
  const token = GitHubAuth.getToken();
  if (!token) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}/assignees`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ assignees: [username] }),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to unassign issue #${issueNumber} from ${username}: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
}

export async function createPRImpl(repo: RepoRef, input: CreatePRInput): Promise<PR> {
  const token = requireGitHubToken();
  const head = input.head?.trim();
  const base = input.base?.trim();
  const title = input.title?.trim();
  if (!head) throw new Error("PR head branch is required.");
  if (!base) throw new Error("PR base branch is required.");
  if (!title) throw new Error("PR title is required.");
  const requestBody: Record<string, unknown> = { head, base, title };
  if (input.body) requestBody.body = input.body;
  if (input.draft) requestBody.draft = true;

  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`;
  const response = await fetch(url, {
    method: "POST",
    headers: githubMutationHeaders(token),
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // 422 = head doesn't exist, no diff between head/base, or a PR for this
    // head/base pair is already open. Surface GitHub's body so the user can tell.
    throw new Error(
      `Failed to create pull request: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.number !== "number" || typeof data.html_url !== "string") {
    throw new Error("Unexpected response from GitHub: missing PR number or URL.");
  }
  clearPRCaches();
  return restToForgePR(data);
}

export async function closePRImpl(repo: RepoRef, prNumber: number): Promise<void> {
  await patchPRState(repo, prNumber, "closed");
  clearPRCaches();
}

export async function reopenPRImpl(repo: RepoRef, prNumber: number): Promise<void> {
  await patchPRState(repo, prNumber, "open");
  clearPRCaches();
}

export async function mergePRImpl(
  repo: RepoRef,
  prNumber: number,
  input?: MergePRInput
): Promise<void> {
  const token = requireGitHubToken();
  const requestBody: Record<string, unknown> = {};
  if (input?.mergeMethod) requestBody.merge_method = input.mergeMethod;
  if (input?.commitTitle) requestBody.commit_title = input.commitTitle;
  if (input?.commitMessage) requestBody.commit_message = input.commitMessage;

  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/merge`;
  const response = await fetch(url, {
    method: "PUT",
    headers: githubMutationHeaders(token),
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // Classify by status, not message substring (lesson from #7079).
    if (response.status === 405) {
      throw new Error(
        `Pull request #${prNumber} is not mergeable — it may be a draft, have conflicts, or fail required checks.`
      );
    }
    if (response.status === 409) {
      throw new Error(
        `Pull request #${prNumber} head branch changed since it was last fetched — re-fetch the PR and try again.`
      );
    }
    throw new Error(
      `Failed to merge pull request #${prNumber}: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
  clearPRCaches();
}

export async function convertPRToDraftImpl(repo: RepoRef, prNumber: number): Promise<void> {
  // REST PATCH can't toggle draft state — GraphQL is the only path, and it
  // needs the PR's node id, which the normalized PR type intentionally omits.
  const nodeId = await fetchPRNodeId(repo, prNumber);
  await dispatchQuery(CONVERT_PR_TO_DRAFT_MUTATION, { id: nodeId }, "convertPullRequestToDraft");
  clearPRCaches();
}

export async function markPRReadyForReviewImpl(repo: RepoRef, prNumber: number): Promise<void> {
  const nodeId = await fetchPRNodeId(repo, prNumber);
  await dispatchQuery(
    MARK_PR_READY_FOR_REVIEW_MUTATION,
    { id: nodeId },
    "markPullRequestReadyForReview"
  );
  clearPRCaches();
}

export async function commentOnPRImpl(
  repo: RepoRef,
  prNumber: number,
  body: string
): Promise<void> {
  const token = requireGitHubToken();
  // Reject an empty/whitespace body, but post the original text verbatim —
  // trimming would mangle leading indentation in fenced code blocks.
  if (!body?.trim()) throw new Error("Comment body is required.");
  // PR comments use the issues endpoint — PR number === issue number on GitHub.
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues/${prNumber}/comments`;
  const response = await fetch(url, {
    method: "POST",
    headers: githubMutationHeaders(token),
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to comment on pull request #${prNumber}: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
  // A comment changes the PR's comment count and timeline — drop PR caches so
  // the next read reflects it (matches every other PR mutation).
  clearPRCaches();
}

export async function editPRImpl(repo: RepoRef, prNumber: number, input: EditPRInput): Promise<PR> {
  const token = requireGitHubToken();
  const requestBody: Record<string, unknown> = {};
  if (typeof input.title === "string") {
    const title = input.title.trim();
    if (!title) throw new Error("PR title cannot be empty.");
    requestBody.title = title;
  }
  if (typeof input.body === "string") requestBody.body = input.body;
  if (Object.keys(requestBody).length === 0) {
    throw new Error("Provide a title or body to edit.");
  }
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: githubMutationHeaders(token),
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to edit pull request #${prNumber}: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.number !== "number" || typeof data.html_url !== "string") {
    throw new Error("Unexpected response from GitHub: missing PR number or URL.");
  }
  clearPRCaches();
  return restToForgePR(data);
}

export async function closeIssueImpl(
  repo: RepoRef,
  issueNumber: number,
  stateReason?: IssueCloseReason
): Promise<Issue> {
  const fields: Record<string, unknown> = { state: "closed" };
  if (stateReason) fields.state_reason = stateReason;
  return patchIssue(repo, issueNumber, fields, `Failed to close issue #${issueNumber}`);
}

export async function reopenIssueImpl(repo: RepoRef, issueNumber: number): Promise<Issue> {
  // Clear any prior `not_planned`/`completed` reason so a reopened issue isn't
  // left with a stale close reason.
  return patchIssue(
    repo,
    issueNumber,
    { state: "open", state_reason: null },
    `Failed to reopen issue #${issueNumber}`
  );
}

export async function editIssueImpl(
  repo: RepoRef,
  issueNumber: number,
  input: EditIssueInput
): Promise<Issue> {
  const fields: Record<string, unknown> = {};
  if (input.title !== undefined) fields.title = input.title;
  if (input.body !== undefined) fields.body = input.body;
  if (Object.keys(fields).length === 0) {
    throw new Error("editIssue requires at least one of title or body.");
  }
  return patchIssue(repo, issueNumber, fields, `Failed to edit issue #${issueNumber}`);
}

export async function addIssueCommentImpl(
  repo: RepoRef,
  issueNumber: number,
  body: string
): Promise<IssueComment> {
  const token = GitHubAuth.getToken();
  if (!token) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }
  if (!body || !body.trim()) {
    throw new Error("Comment body is required.");
  }
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}/comments`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to comment on issue #${issueNumber}: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.id !== "number" || typeof data.html_url !== "string") {
    throw new Error("Unexpected response from GitHub: missing comment id or URL.");
  }
  // A new comment changes the issue's comment count, which the tooltip cache
  // holds. List/stat caches are unaffected, so a targeted invalidation is
  // enough (avoids the heavier clearGitHubCaches()).
  issueTooltipCache.invalidate(`${repo.owner}/${repo.repo}:${issueNumber}`);
  return {
    id: String(data.id),
    body: typeof data.body === "string" ? data.body : "",
    url: data.html_url,
    author: restUserToForgeUser(data.user),
    createdAt: isoToMs(data.created_at ?? data.updated_at),
    rawData: data,
  };
}

export async function addIssueLabelImpl(
  repo: RepoRef,
  issueNumber: number,
  label: string
): Promise<ForgeLabel[]> {
  const token = GitHubAuth.getToken();
  if (!token) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }
  const name = label?.trim();
  if (!name) {
    throw new Error("Label name is required.");
  }
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}/labels`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ labels: [name] }),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to add label '${name}' to issue #${issueNumber}: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
  const data = await response.json();
  clearGitHubCaches();
  return restToForgeLabels(data);
}

export async function removeIssueLabelImpl(
  repo: RepoRef,
  issueNumber: number,
  label: string
): Promise<ForgeLabel[]> {
  const token = GitHubAuth.getToken();
  if (!token) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }
  const name = label?.trim();
  if (!name) {
    throw new Error("Label name is required.");
  }
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}/labels/${encodeURIComponent(name)}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (response.status === 404) {
    throw new Error(`Label '${name}' is not on issue #${issueNumber}.`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to remove label '${name}' from issue #${issueNumber}: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
  const data = await response.json();
  clearGitHubCaches();
  return restToForgeLabels(data);
}
