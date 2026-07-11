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
} from "../../../../shared/types/forge.js";
import type { GitLabIssue, GitLabMergeRequest, GitLabNote, GitLabUser } from "../shared/types.js";
import { GitLabApiError, gitlabRest } from "./GitLabClient.js";
import { encodeProjectId, repoWebUrl } from "./gitlabRemote.js";
import {
  gitlabIssueToForgeIssue,
  gitlabLabelsToForgeLabels,
  gitlabNoteToIssueComment,
  isDraftMergeRequest,
  isDraftTitle,
  mergeRequestToForgePR,
  stripDraftPrefix,
} from "./mappers.js";

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
  return gitlabIssueToForgeIssue(data, repo.host);
}

export async function assignIssueImpl(
  repo: RepoRef,
  issueNumber: number,
  username: string
): Promise<void> {
  const [userId, issue] = await Promise.all([
    resolveUserId(repo, username),
    fetchIssueRaw(repo, issueNumber),
  ]);
  const ids = currentAssigneeIds(issue);
  if (ids.includes(userId)) return;
  await gitlabRest({
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
}

export async function unassignIssueImpl(
  repo: RepoRef,
  issueNumber: number,
  username: string
): Promise<void> {
  const issue = await fetchIssueRaw(repo, issueNumber);
  const assignees = Array.isArray(issue.assignees) ? issue.assignees : [];
  const remaining = assignees
    .filter((a) => (a.username ?? "").toLowerCase() !== username.toLowerCase())
    .map((a) => a.id)
    .filter((id): id is number => typeof id === "number");
  if (remaining.length === assignees.length) return;
  await gitlabRest({
    host: repo.host,
    method: "PUT",
    path: `${projectPath(repo)}/issues/${issueNumber}`,
    // `[0]` is GitLab's documented "unassign everyone" sentinel.
    body: { assignee_ids: remaining.length > 0 ? remaining : [0] },
  });
}

export async function createPRImpl(repo: RepoRef, input: CreatePRInput): Promise<PR> {
  const title =
    input.draft === true && !/^\s*draft:/i.test(input.title)
      ? `Draft: ${input.title}`
      : input.title;
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
  return mergeRequestToForgePR(data, repo.host);
}

async function setMRStateEvent(
  repo: RepoRef,
  prNumber: number,
  stateEvent: "close" | "reopen"
): Promise<void> {
  await gitlabRest({
    host: repo.host,
    method: "PUT",
    path: `${projectPath(repo)}/merge_requests/${prNumber}`,
    body: { state_event: stateEvent },
  });
}

export async function closePRImpl(repo: RepoRef, prNumber: number): Promise<void> {
  await setMRStateEvent(repo, prNumber, "close");
}

export async function reopenPRImpl(repo: RepoRef, prNumber: number): Promise<void> {
  await setMRStateEvent(repo, prNumber, "reopen");
}

export async function mergePRImpl(
  repo: RepoRef,
  prNumber: number,
  input?: MergePRInput
): Promise<void> {
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
    await gitlabRest({
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

export async function convertPRToDraftImpl(repo: RepoRef, prNumber: number): Promise<void> {
  const mr = await fetchMRRaw(repo, prNumber);
  if (isDraftMergeRequest(mr)) return;
  await gitlabRest({
    host: repo.host,
    method: "PUT",
    path: `${projectPath(repo)}/merge_requests/${prNumber}`,
    // Draft state IS the title prefix in GitLab — there's no writable flag.
    body: { title: `Draft: ${mr.title ?? ""}` },
  });
}

export async function markPRReadyForReviewImpl(repo: RepoRef, prNumber: number): Promise<void> {
  const mr = await fetchMRRaw(repo, prNumber);
  if (!isDraftMergeRequest(mr)) return;
  await gitlabRest({
    host: repo.host,
    method: "PUT",
    path: `${projectPath(repo)}/merge_requests/${prNumber}`,
    body: { title: stripDraftPrefix(mr.title ?? "") },
  });
}

export async function commentOnPRImpl(
  repo: RepoRef,
  prNumber: number,
  body: string
): Promise<void> {
  await gitlabRest({
    host: repo.host,
    method: "POST",
    path: `${projectPath(repo)}/merge_requests/${prNumber}/notes`,
    body: { body },
  });
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
  return gitlabIssueToForgeIssue(data, repo.host);
}

export async function reopenIssueImpl(repo: RepoRef, issueNumber: number): Promise<Issue> {
  const { data } = await gitlabRest<GitLabIssue>({
    host: repo.host,
    method: "PUT",
    path: `${projectPath(repo)}/issues/${issueNumber}`,
    body: { state_event: "reopen" },
  });
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
  return gitlabLabelsToForgeLabels(data.labels);
}
