import type {
  CreateIssueInput,
  CreatePRInput,
  EditIssueInput,
  EditPRInput,
  ForgeLabel,
  ForgeUser,
  Issue,
  IssueCloseReason,
  IssueComment,
  MergePRInput,
  MergePRResult,
  PR,
  PRDraftStateResult,
  PullRequestReview,
  RepoRef,
  RequestReviewersResult,
  ReviewerRequest,
} from "../../../../shared/types/forge.js";
import { GitHubAuth, GITHUB_API_TIMEOUT_MS } from "./GitHubAuth.js";
import {
  GET_PR_NODE_ID_QUERY,
  CONVERT_PR_TO_DRAFT_MUTATION,
  MARK_PR_READY_FOR_REVIEW_MUTATION,
} from "./GitHubQueries.js";
import {
  clearGitHubCaches,
  clearPRCaches,
  invalidateRepoIssueCachesForAssignment,
  issueTooltipCache,
} from "./GitHubCaches.js";
import {
  isoToMs,
  restToForgeIssue,
  restToForgeLabels,
  restToForgePR,
  restToForgeReview,
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

/**
 * Read an accepted mutation's JSON body. Callers invalidate their caches
 * *before* calling this: the remote write has already landed by then, so a
 * malformed body must never leave a cache serving pre-mutation state.
 */
async function readMutationJson(
  response: Response,
  missing: string
): Promise<Record<string, unknown>> {
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data || typeof data !== "object") {
    throw new Error(`Unexpected response from GitHub: ${missing}.`);
  }
  return data;
}

// Shared PATCH for close/reopen — both flip `state` on the same endpoint.
async function patchPRState(repo: RepoRef, prNumber: number, state: "open" | "closed"): Promise<PR> {
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
  clearPRCaches();
  const data = await readMutationJson(response, "missing pull request payload");
  if (typeof data.number !== "number" || typeof data.html_url !== "string") {
    throw new Error("Unexpected response from GitHub: missing PR number or URL.");
  }
  return restToForgePR(data);
}

/**
 * Shared POST/DELETE against the assignees endpoint. Both directions return the
 * issue's full resulting assignee list, which is the authority on what landed —
 * GitHub silently ignores assignees that lack push access.
 */
async function patchIssueAssignees(
  repo: RepoRef,
  issueNumber: number,
  username: string,
  method: "POST" | "DELETE",
  failurePrefix: string
): Promise<ForgeUser[]> {
  const token = requireGitHubToken();
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}/assignees`;
  const response = await fetch(url, {
    method,
    headers: githubMutationHeaders(token),
    body: JSON.stringify({ assignees: [username] }),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `${failurePrefix}: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
  invalidateRepoIssueCachesForAssignment(repo.owner, repo.repo, issueNumber);
  const data = await readMutationJson(response, "missing issue payload");
  if (!Array.isArray(data.assignees)) {
    throw new Error("Unexpected response from GitHub: missing issue assignees.");
  }
  return data.assignees.map(restUserToForgeUser).filter((u): u is ForgeUser => u !== undefined);
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
): Promise<PullRequestReview> {
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
  const data = await readMutationJson(response, "missing review payload");
  if (typeof data.id !== "number" && typeof data.id !== "string") {
    throw new Error("Unexpected response from GitHub: missing review id.");
  }
  return restToForgeReview(data);
}

export async function dismissReviewImpl(
  repo: RepoRef,
  prNumber: number,
  reviewId: number,
  message: string
): Promise<PullRequestReview> {
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
  const data = await readMutationJson(response, "missing review payload");
  if (typeof data.id !== "number" && typeof data.id !== "string") {
    throw new Error("Unexpected response from GitHub: missing review id.");
  }
  return restToForgeReview(data);
}

export async function requestReviewersImpl(
  repo: RepoRef,
  prNumber: number,
  reviewers: ReviewerRequest
): Promise<RequestReviewersResult> {
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
  // Deliberately no cache invalidation: the normalized PR carries no
  // requested-reviewer fields, so nothing cached went stale.
  const data = await readMutationJson(response, "missing pull request payload");
  // The endpoint answers with the PR, whose requested-reviewer lists are the
  // resulting state — they include reviewers requested before this call and
  // omit any the forge refused, so they can differ from what was asked for.
  return {
    prNumber,
    requestedUsers: pluckStrings(data.requested_reviewers, "login"),
    requestedTeams: pluckStrings(data.requested_teams, "slug"),
  };
}

/** Collect a string field off every object entry of a GitHub list payload. */
function pluckStrings(list: unknown, field: string): string[] {
  if (!Array.isArray(list)) return [];
  const values: string[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const value = (entry as Record<string, unknown>)[field];
    if (typeof value === "string" && value) values.push(value);
  }
  return values;
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
): Promise<ForgeUser[]> {
  return patchIssueAssignees(
    repo,
    issueNumber,
    username,
    "POST",
    `Failed to assign issue #${issueNumber} to ${username}`
  );
}

export async function unassignIssueImpl(
  repo: RepoRef,
  issueNumber: number,
  username: string
): Promise<ForgeUser[]> {
  return patchIssueAssignees(
    repo,
    issueNumber,
    username,
    "DELETE",
    `Failed to unassign issue #${issueNumber} from ${username}`
  );
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

export async function closePRImpl(repo: RepoRef, prNumber: number): Promise<PR> {
  return patchPRState(repo, prNumber, "closed");
}

export async function reopenPRImpl(repo: RepoRef, prNumber: number): Promise<PR> {
  return patchPRState(repo, prNumber, "open");
}

export async function mergePRImpl(
  repo: RepoRef,
  prNumber: number,
  input?: MergePRInput
): Promise<MergePRResult> {
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
  // GitHub's merge endpoint answers with `{sha, merged, message}` and nothing
  // else. Deliberately no follow-up GET for the resulting PR: the merge has
  // already landed here, so a failing second read would report a completed
  // merge as a failure.
  const data = await readMutationJson(response, "missing merge payload");
  return {
    prNumber,
    sha: typeof data.sha === "string" && data.sha ? data.sha : null,
    merged: data.merged === true,
    message: typeof data.message === "string" ? data.message : "",
  };
}

/**
 * Read the resulting `isDraft` off a draft-toggle mutation's ack. Returns null
 * when the payload doesn't carry one, letting the caller fall back rather than
 * fail a mutation that already succeeded.
 */
function readDraftAck(response: unknown, mutationField: string): boolean | null {
  const payload = (response as Record<string, unknown> | null)?.[mutationField];
  const pullRequest = (payload as { pullRequest?: { isDraft?: unknown } } | undefined)?.pullRequest;
  return typeof pullRequest?.isDraft === "boolean" ? pullRequest.isDraft : null;
}

// REST PATCH can't toggle draft state — GraphQL is the only path, and it needs
// the PR's node id, which the normalized PR type intentionally omits.
async function setPRDraftState(
  repo: RepoRef,
  prNumber: number,
  draft: boolean
): Promise<PRDraftStateResult> {
  const nodeId = await fetchPRNodeId(repo, prNumber);
  const mutationField = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
  const response = await dispatchQuery(
    draft ? CONVERT_PR_TO_DRAFT_MUTATION : MARK_PR_READY_FOR_REVIEW_MUTATION,
    { id: nodeId },
    mutationField
  );
  clearPRCaches();
  // Prefer the state GitHub reports; fall back to the state we asked for when
  // the ack omits it, since the mutation itself already succeeded.
  return { prNumber, isDraft: readDraftAck(response, mutationField) ?? draft };
}

export async function convertPRToDraftImpl(
  repo: RepoRef,
  prNumber: number
): Promise<PRDraftStateResult> {
  return setPRDraftState(repo, prNumber, true);
}

export async function markPRReadyForReviewImpl(
  repo: RepoRef,
  prNumber: number
): Promise<PRDraftStateResult> {
  return setPRDraftState(repo, prNumber, false);
}

export async function commentOnPRImpl(
  repo: RepoRef,
  prNumber: number,
  body: string
): Promise<IssueComment> {
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
  const data = await readMutationJson(response, "missing comment payload");
  if (typeof data.id !== "number" || typeof data.html_url !== "string") {
    throw new Error("Unexpected response from GitHub: missing comment id or URL.");
  }
  return {
    id: String(data.id),
    body: typeof data.body === "string" ? data.body : "",
    url: data.html_url,
    author: restUserToForgeUser(data.user),
    createdAt: isoToMs(data.created_at ?? data.updated_at),
    rawData: data,
  };
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
