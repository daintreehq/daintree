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
  RepoRef,
} from "../../../../shared/types/forge.js";
import type { GitLabIssue, GitLabMergeRequest, GitLabNote, GitLabUser } from "../shared/types.js";
import { GitLabApiError, gitlabRest } from "./GitLabClient.js";
import { encodeProjectId, repoWebUrl } from "./gitlabRemote.js";
import {
  gitlabIssueToForgeIssue,
  gitlabLabelsToForgeLabels,
  gitlabNoteToIssueComment,
  gitlabUserToForgeUser,
  isDraftMergeRequest,
  isDraftTitle,
  mergeRequestToForgePR,
  stripDraftPrefix,
} from "./mappers.js";
import { clearGitLabCaches } from "./readOps.js";

function projectPath(repo: RepoRef): string {
  return `/projects/${encodeProjectId(repo)}`;
}

async function fetchIssueRaw(repo: RepoRef, issueNumber: number): Promise<GitLabIssue> {
  const { data } = await gitlabRest<GitLabIssue>({
    host: repo.host,
    path: `${projectPath(repo)}/issues/${issueNumber}`,
  });
  return data;
}

async function fetchMRRaw(repo: RepoRef, prNumber: number): Promise<GitLabMergeRequest> {
  const { data } = await gitlabRest<GitLabMergeRequest>({
    host: repo.host,
    path: `${projectPath(repo)}/merge_requests/${prNumber}`,
  });
  return data;
}

/** Resolve a username to its numeric user id via exact-match user search. */
async function resolveUserId(repo: RepoRef, username: string): Promise<number> {
  const { data } = await gitlabRest<GitLabUser[]>({
    host: repo.host,
    path: "/users",
    query: { username },
  });
  const match = Array.isArray(data)
    ? data.find(
        (u) => typeof u.username === "string" && u.username.toLowerCase() === username.toLowerCase()
      )
    : undefined;
  if (!match || typeof match.id !== "number") {
    throw new Error(`GitLab user "${username}" not found`);
  }
  return match.id;
}

/** The issue's resulting assignee list — what actually landed, not what was asked for. */
function gitlabAssigneesToForgeUsers(issue: GitLabIssue, host: string): ForgeUser[] {
  if (!Array.isArray(issue.assignees)) return [];
  return issue.assignees
    .map((u) => gitlabUserToForgeUser(u, host))
    .filter((u): u is ForgeUser => u !== undefined);
}

function currentAssigneeIds(issue: GitLabIssue): number[] {
  if (!Array.isArray(issue.assignees)) return [];
  return issue.assignees.map((a) => a.id).filter((id): id is number => typeof id === "number");
}

export async function createIssueImpl(repo: RepoRef, input: CreateIssueInput): Promise<Issue> {
  const { data } = await gitlabRest<GitLabIssue>({
    host: repo.host,
    method: "POST",
    path: `${projectPath(repo)}/issues`,
    body: {
      title: input.title,
      ...(input.body !== undefined ? { description: input.body } : {}),
      ...(input.labels && input.labels.length > 0 ? { labels: input.labels.join(",") } : {}),
    },
  });
  clearGitLabCaches();
  return gitlabIssueToForgeIssue(data, repo.host);
}

export async function assignIssueImpl(
  repo: RepoRef,
  issueNumber: number,
  username: string
): Promise<ForgeUser[]> {
  const [userId, issue] = await Promise.all([
    resolveUserId(repo, username),
    fetchIssueRaw(repo, issueNumber),
  ]);
  const ids = currentAssigneeIds(issue);
  // Already assigned — the state the caller asked for is the state on the
  // server, so report the current list rather than writing it back.
  if (ids.includes(userId)) return gitlabAssigneesToForgeUsers(issue, repo.host);
  const { data } = await gitlabRest<GitLabIssue>({
    host: repo.host,
    method: "PUT",
    path: `${projectPath(repo)}/issues/${issueNumber}`,
    // The new user goes FIRST: GitLab Free applies only the first id
    // (multi-assignee is Premium/Ultimate), so leading with the requested
    // user makes Free replace the assignee instead of silently ignoring the
    // request. On multi-assignee tiers the order is irrelevant and the
    // semantics stay additive.
    body: { assignee_ids: [userId, ...ids] },
  });
  clearGitLabCaches();
  // The updated issue's own list, not the requested id: on GitLab Free the
  // extra ids are dropped, so only the response says what actually landed.
  return gitlabAssigneesToForgeUsers(data, repo.host);
}

export async function unassignIssueImpl(
  repo: RepoRef,
  issueNumber: number,
  username: string
): Promise<ForgeUser[]> {
  const issue = await fetchIssueRaw(repo, issueNumber);
  const assignees = Array.isArray(issue.assignees) ? issue.assignees : [];
  const kept = assignees.filter((a) => (a.username ?? "").toLowerCase() !== username.toLowerCase());
  // Not assigned in the first place — nothing to write, and the current list
  // is already the resulting list. Measured on the username filter ALONE: an
  // assignee GitLab returned without a numeric id drops out of the id list
  // below, and comparing that against the full list would read as a removal
  // and write back an `assignee_ids` that silently unassigns them.
  if (kept.length === assignees.length) return gitlabAssigneesToForgeUsers(issue, repo.host);
  const remaining = kept.map((a) => a.id).filter((id): id is number => typeof id === "number");
  const { data } = await gitlabRest<GitLabIssue>({
    host: repo.host,
    method: "PUT",
    path: `${projectPath(repo)}/issues/${issueNumber}`,
    // `[0]` is GitLab's documented "unassign everyone" sentinel.
    body: { assignee_ids: remaining.length > 0 ? remaining : [0] },
  });
  clearGitLabCaches();
  return gitlabAssigneesToForgeUsers(data, repo.host);
}

export async function createPRImpl(repo: RepoRef, input: CreatePRInput): Promise<PR> {
  // `isDraftTitle` knows every prefix GitLab itself recognizes — `[Draft]`,
  // `(Draft)` and `Draft -` as well as `Draft:` — so a title that already
  // reads as a draft isn't prefixed a second time.
  const title =
    input.draft === true && !isDraftTitle(input.title) ? `Draft: ${input.title}` : input.title;
  const { data } = await gitlabRest<GitLabMergeRequest>({
    host: repo.host,
    method: "POST",
    path: `${projectPath(repo)}/merge_requests`,
    body: {
      source_branch: input.head,
      target_branch: input.base,
      title,
      ...(input.body !== undefined ? { description: input.body } : {}),
    },
  });
  clearGitLabCaches();
  return mergeRequestToForgePR(data, repo.host);
}

async function setMRStateEvent(
  repo: RepoRef,
  prNumber: number,
  stateEvent: "close" | "reopen"
): Promise<PR> {
  const { data } = await gitlabRest<GitLabMergeRequest>({
    host: repo.host,
    method: "PUT",
    path: `${projectPath(repo)}/merge_requests/${prNumber}`,
    body: { state_event: stateEvent },
  });
  clearGitLabCaches();
  return mergeRequestToForgePR(data, repo.host);
}

export async function closePRImpl(repo: RepoRef, prNumber: number): Promise<PR> {
  return setMRStateEvent(repo, prNumber, "close");
}

export async function reopenPRImpl(repo: RepoRef, prNumber: number): Promise<PR> {
  return setMRStateEvent(repo, prNumber, "reopen");
}

export async function mergePRImpl(
  repo: RepoRef,
  prNumber: number,
  input?: MergePRInput
): Promise<MergePRResult> {
  if (input?.mergeMethod === "rebase") {
    // GitLab's merge method is project-level configuration, not a per-merge
    // parameter; only squash can be chosen per merge.
    throw new Error("Not supported: GitLab configures the merge method per project");
  }
  const squash = input?.mergeMethod === "squash";
  const commitMessage =
    input?.commitTitle || input?.commitMessage
      ? [input.commitTitle, input.commitMessage].filter(Boolean).join("\n\n")
      : undefined;
  try {
    const { data } = await gitlabRest<GitLabMergeRequest>({
      host: repo.host,
      method: "PUT",
      path: `${projectPath(repo)}/merge_requests/${prNumber}/merge`,
      body: {
        // An explicit method sends `squash` both ways so the project's
        // squash-by-default option doesn't silently flip the caller's choice.
        // The project's `squash_option` stays authoritative at the extremes
        // (`always`/`never` ignore the per-request flag); omitting the method
        // leaves the project default in charge.
        ...(input?.mergeMethod !== undefined ? { squash } : {}),
        ...(commitMessage !== undefined
          ? squash
            ? { squash_commit_message: commitMessage }
            : { merge_commit_message: commitMessage }
          : {}),
      },
    });
    clearGitLabCaches();
    // GitLab answers the merge endpoint with the updated merge request, not a
    // dedicated ack. Squash and merge-commit land in different fields, so both
    // are read; a 2xx means the merge happened, which is why `state` only gets
    // to deny it when it explicitly says otherwise.
    // Merge commit first: GitLab can squash the source commits AND still
    // create a merge commit, returning both. `MergePRResult.sha` names the
    // commit the change landed as on the target branch, so the squash sha is
    // only right when there is no merge commit (fast-forward/semi-linear).
    const sha =
      (typeof data.merge_commit_sha === "string" && data.merge_commit_sha) ||
      (typeof data.squash_commit_sha === "string" && data.squash_commit_sha) ||
      null;
    // A 200 whose body isn't a merge request at all (an error envelope, a
    // gateway page) says nothing about the merge. Claiming either outcome
    // from it would be a guess, so it's an error.
    if (typeof data.state !== "string") {
      throw new Error("GitLab returned an unrecognizable response to the merge");
    }
    // Only an explicit "merged" counts: a queued merge acks with the MR still
    // open, and reporting a merge that didn't happen is the worse mistake.
    const merged = data.state === "merged";
    return {
      prNumber,
      sha,
      merged,
      // A queued merge (merge-when-pipeline-succeeds) acks 2xx with the MR
      // still open. Saying "merged" there would contradict the flag beside it.
      message: merged
        ? `Merge request !${prNumber} merged`
        : `Merge request !${prNumber} is queued to merge`,
    };
  } catch (err) {
    // GitLab answers 405/406 for unmergeable states with a terse body;
    // translate them so the confirm-dialog error is actionable.
    if (err instanceof GitLabApiError && (err.status === 405 || err.status === 406)) {
      throw new Error(
        "GitLab refused the merge — the merge request may be a draft, have conflicts, or failing pipelines",
        { cause: err }
      );
    }
    throw err;
  }
}

/**
 * Draft state IS the title prefix in GitLab — there is no writable flag — so a
 * toggle is a title rewrite. The resulting state is read back off the updated
 * merge request rather than assumed from the request, so a project rule that
 * rewrites the title can't leave the UI claiming a state the server rejected.
 */
async function setMRDraftState(
  repo: RepoRef,
  prNumber: number,
  draft: boolean
): Promise<PRDraftStateResult> {
  const mr = await fetchMRRaw(repo, prNumber);
  if (isDraftMergeRequest(mr) === draft) return { prNumber, isDraft: draft };
  // Strip first either way: `isDraftMergeRequest` trusts the explicit `draft`
  // flag over the title, so an MR the server calls ready can still carry a
  // `[Draft]` prefix — prefixing that unstripped yields "Draft: [Draft] Foo".
  const base = stripDraftPrefix(mr.title ?? "");
  const title = draft ? `Draft: ${base}` : base;
  const { data } = await gitlabRest<GitLabMergeRequest>({
    host: repo.host,
    method: "PUT",
    path: `${projectPath(repo)}/merge_requests/${prNumber}`,
    body: { title },
  });
  clearGitLabCaches();
  return { prNumber, isDraft: isDraftMergeRequest(data) };
}

export async function convertPRToDraftImpl(
  repo: RepoRef,
  prNumber: number
): Promise<PRDraftStateResult> {
  return setMRDraftState(repo, prNumber, true);
}

export async function markPRReadyForReviewImpl(
  repo: RepoRef,
  prNumber: number
): Promise<PRDraftStateResult> {
  return setMRDraftState(repo, prNumber, false);
}

export async function commentOnPRImpl(
  repo: RepoRef,
  prNumber: number,
  body: string
): Promise<IssueComment> {
  const { data } = await gitlabRest<GitLabNote>({
    host: repo.host,
    method: "POST",
    path: `${projectPath(repo)}/merge_requests/${prNumber}/notes`,
    body: { body },
  });
  // A note changes the MR's comment count and timeline, so the cached
  // tooltips that carry it are stale.
  clearGitLabCaches();
  const prUrl = `${repoWebUrl(repo)}/-/merge_requests/${prNumber}`;
  return gitlabNoteToIssueComment(data, prUrl, repo.host);
}

export async function editPRImpl(repo: RepoRef, prNumber: number, input: EditPRInput): Promise<PR> {
  let title = input.title;
  if (title !== undefined && !isDraftTitle(title)) {
    // Draft state IS the title prefix in GitLab, so a plain title edit on a
    // draft MR would silently mark it ready. Preserve the current draft state;
    // draft transitions go through the dedicated convert/mark-ready ops.
    const current = await fetchMRRaw(repo, prNumber);
    if (isDraftMergeRequest(current)) {
      title = `Draft: ${title}`;
    }
  }
  const { data } = await gitlabRest<GitLabMergeRequest>({
    host: repo.host,
    method: "PUT",
    path: `${projectPath(repo)}/merge_requests/${prNumber}`,
    body: {
      ...(title !== undefined ? { title } : {}),
      ...(input.body !== undefined ? { description: input.body } : {}),
    },
  });
  clearGitLabCaches();
  return mergeRequestToForgePR(data, repo.host);
}

export async function closeIssueImpl(
  repo: RepoRef,
  issueNumber: number,
  _stateReason?: IssueCloseReason
): Promise<Issue> {
  // GitLab has no close-reason concept; the reason is accepted and dropped.
  const { data } = await gitlabRest<GitLabIssue>({
    host: repo.host,
    method: "PUT",
    path: `${projectPath(repo)}/issues/${issueNumber}`,
    body: { state_event: "close" },
  });
  clearGitLabCaches();
  return gitlabIssueToForgeIssue(data, repo.host);
}

export async function reopenIssueImpl(repo: RepoRef, issueNumber: number): Promise<Issue> {
  const { data } = await gitlabRest<GitLabIssue>({
    host: repo.host,
    method: "PUT",
    path: `${projectPath(repo)}/issues/${issueNumber}`,
    body: { state_event: "reopen" },
  });
  clearGitLabCaches();
  return gitlabIssueToForgeIssue(data, repo.host);
}

export async function editIssueImpl(
  repo: RepoRef,
  issueNumber: number,
  input: EditIssueInput
): Promise<Issue> {
  const { data } = await gitlabRest<GitLabIssue>({
    host: repo.host,
    method: "PUT",
    path: `${projectPath(repo)}/issues/${issueNumber}`,
    body: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { description: input.body } : {}),
    },
  });
  clearGitLabCaches();
  return gitlabIssueToForgeIssue(data, repo.host);
}

export async function addIssueCommentImpl(
  repo: RepoRef,
  issueNumber: number,
  body: string
): Promise<IssueComment> {
  const { data } = await gitlabRest<GitLabNote>({
    host: repo.host,
    method: "POST",
    path: `${projectPath(repo)}/issues/${issueNumber}/notes`,
    body: { body },
  });
  clearGitLabCaches();
  const issueUrl = `${repoWebUrl(repo)}/-/issues/${issueNumber}`;
  return gitlabNoteToIssueComment(data, issueUrl, repo.host);
}

export async function addIssueLabelImpl(
  repo: RepoRef,
  issueNumber: number,
  label: string
): Promise<ForgeLabel[]> {
  const { data } = await gitlabRest<GitLabIssue>({
    host: repo.host,
    method: "PUT",
    path: `${projectPath(repo)}/issues/${issueNumber}`,
    body: { add_labels: label },
  });
  clearGitLabCaches();
  return gitlabLabelsToForgeLabels(data.labels);
}

export async function removeIssueLabelImpl(
  repo: RepoRef,
  issueNumber: number,
  label: string
): Promise<ForgeLabel[]> {
  const issue = await fetchIssueRaw(repo, issueNumber);
  const present = Array.isArray(issue.labels) && issue.labels.some((l) => l === label);
  if (!present) {
    throw new Error(`Label "${label}" is not on issue #${issueNumber}`);
  }
  const { data } = await gitlabRest<GitLabIssue>({
    host: repo.host,
    method: "PUT",
    path: `${projectPath(repo)}/issues/${issueNumber}`,
    body: { remove_labels: label },
  });
  clearGitLabCaches();
  return gitlabLabelsToForgeLabels(data.labels);
}
