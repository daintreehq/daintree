import type { PRCheckCandidate } from "./types.js";

// Combined poll query: returns the count badges AND the first page of open
// issues + open PRs (default filter + sort) in a single round-trip. Cost on
// GitHub's GraphQL rate limit is dominated by nested `first:` connections —
// roughly ~6 points/query — vs 1 point for the count-only query, but it
// eliminates the click-time round-trip entirely, so the dropdown opens
// instantly against renderer cache primed by the poll. Field shape mirrors
// LIST_ISSUES_QUERY / LIST_PRS_QUERY so parseIssueNode / parsePRNode parse
// the response without modification.
export const REPO_STATS_AND_PAGE_QUERY = `
  query GetRepoStatsAndPage($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      issues(first: 20, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          url
          state
          updatedAt
          author { login avatarUrl }
          assignees(first: 10) { nodes { login avatarUrl } }
          comments { totalCount }
          labels(first: 10) { nodes { name color } }
          timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT], last: 20) {
            nodes {
              ... on CrossReferencedEvent {
                source { ... on PullRequest { number state merged url updatedAt } }
              }
              ... on ConnectedEvent {
                subject { ... on PullRequest { number state merged url updatedAt } }
              }
            }
          }
        }
      }
      pullRequests(first: 20, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          url
          state
          isDraft
          updatedAt
          merged
          headRefName
          reviewDecision
          mergeStateStatus
          headRepository { nameWithOwner }
          baseRepository { nameWithOwner }
          author { login avatarUrl }
          comments { totalCount }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                  contexts {
                    checkRunCount
                    statusContextCount
                    checkRunCountsByState {
                      state
                      count
                    }
                    statusContextCountsByState {
                      state
                      count
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    rateLimit {
      cost
      remaining
      resetAt
      limit
    }
  }
`;

// Fast-changing project health: CI status, latest release, security alerts.
// The open issue/PR counts are NOT fetched here — they are already retrieved
// (and cached) by REPO_STATS_AND_PAGE_QUERY, so `getProjectHealth` reads them
// from `repoStatsCache` instead of duplicating the fetch every poll cycle.
// The slow-changing merged-PR velocity windows moved to MERGE_VELOCITY_QUERY.
export const PROJECT_HEALTH_QUERY = `
  query GetProjectHealth($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      defaultBranchRef {
        target {
          ... on Commit {
            statusCheckRollup {
              state
            }
          }
        }
      }
      latestRelease {
        tagName
        publishedAt
        url
      }
      vulnerabilityAlerts(first: 1) {
        totalCount
      }
    }
    rateLimit {
      cost
      remaining
      resetAt
    }
  }
`;

// Slow-changing 60/120/180-day merged-PR velocity. Each `search` block is the
// heaviest GraphQL connection type, so this query runs at most once per cache
// window (4h / UTC day) instead of every 30s poll — the velocity windows shift
// on a days timescale, not seconds.
export const MERGE_VELOCITY_QUERY = `
  query GetMergeVelocity($merged60: String!, $merged120: String!, $merged180: String!) {
    mergedPRs60: search(query: $merged60, type: ISSUE, first: 1) {
      issueCount
    }
    mergedPRs120: search(query: $merged120, type: ISSUE, first: 1) {
      issueCount
    }
    mergedPRs180: search(query: $merged180, type: ISSUE, first: 1) {
      issueCount
    }
    rateLimit {
      cost
      remaining
      resetAt
      limit
    }
  }
`;

export const LIST_ISSUES_QUERY = `
  query GetIssues($owner: String!, $repo: String!, $states: [IssueState!], $cursor: String, $limit: Int = 20, $orderBy: IssueOrder) {
    repository(owner: $owner, name: $repo) {
      issues(first: $limit, after: $cursor, states: $states, orderBy: $orderBy) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          title
          bodyText
          url
          state
          createdAt
          updatedAt
          closedAt
          author {
            login
            avatarUrl
          }
          assignees(first: 10) {
            nodes {
              login
              avatarUrl
            }
          }
          comments {
            totalCount
          }
          labels(first: 10) {
            nodes {
              name
              color
            }
          }
          timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT], last: 20) {
            nodes {
              ... on CrossReferencedEvent {
                source {
                  ... on PullRequest {
                    number
                    state
                    merged
                    url
                    updatedAt
                  }
                }
              }
              ... on ConnectedEvent {
                subject {
                  ... on PullRequest {
                    number
                    state
                    merged
                    url
                    updatedAt
                  }
                }
              }
            }
          }
        }
      }
    }
    rateLimit {
      cost
      remaining
      resetAt
      limit
    }
  }
`;

export const LIST_PRS_QUERY = `
  query GetPRs($owner: String!, $repo: String!, $states: [PullRequestState!], $cursor: String, $limit: Int = 20, $orderBy: IssueOrder) {
    repository(owner: $owner, name: $repo) {
      pullRequests(first: $limit, after: $cursor, states: $states, orderBy: $orderBy) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          title
          bodyText
          url
          state
          isDraft
          createdAt
          updatedAt
          closedAt
          mergedAt
          merged
          baseRefName
          headRefName
          reviewDecision
          mergeStateStatus
          headRepository {
            nameWithOwner
          }
          baseRepository {
            nameWithOwner
          }
          author {
            login
            avatarUrl
          }
          assignees(first: 10) {
            nodes {
              login
              avatarUrl
            }
          }
          labels(first: 10) {
            nodes {
              name
              color
            }
          }
          comments {
            totalCount
          }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                  contexts {
                    checkRunCount
                    statusContextCount
                    checkRunCountsByState {
                      state
                      count
                    }
                    statusContextCountsByState {
                      state
                      count
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    rateLimit {
      cost
      remaining
      resetAt
      limit
    }
  }
`;

export const SEARCH_QUERY = `
  query SearchItems($searchQuery: String!, $type: SearchType!, $cursor: String, $limit: Int = 20) {
    search(query: $searchQuery, type: $type, first: $limit, after: $cursor) {
      issueCount
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ... on Issue {
          number
          title
          bodyText
          url
          state
          createdAt
          updatedAt
          closedAt
          author {
            login
            avatarUrl
          }
          assignees(first: 10) {
            nodes {
              login
              avatarUrl
            }
          }
          comments {
            totalCount
          }
          labels(first: 10) {
            nodes {
              name
              color
            }
          }
          timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT], last: 20) {
            nodes {
              ... on CrossReferencedEvent {
                source {
                  ... on PullRequest {
                    number
                    state
                    merged
                    url
                    updatedAt
                  }
                }
              }
              ... on ConnectedEvent {
                subject {
                  ... on PullRequest {
                    number
                    state
                    merged
                    url
                    updatedAt
                  }
                }
              }
            }
          }
        }
        ... on PullRequest {
          number
          title
          bodyText
          url
          state
          isDraft
          createdAt
          updatedAt
          closedAt
          mergedAt
          merged
          reviewDecision
          baseRefName
          headRefName
          headRepository {
            nameWithOwner
          }
          baseRepository {
            nameWithOwner
          }
          author {
            login
            avatarUrl
          }
          assignees(first: 10) {
            nodes {
              login
              avatarUrl
            }
          }
          labels(first: 10) {
            nodes {
              name
              color
            }
          }
          comments {
            totalCount
          }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                }
              }
            }
          }
        }
      }
    }
    rateLimit {
      cost
      remaining
      resetAt
      limit
    }
  }
`;

export const GET_ISSUE_QUERY = `
  query GetIssue($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        number
        title
        bodyText
        url
        state
        createdAt
        updatedAt
        closedAt
        author {
          login
          avatarUrl
        }
        assignees(first: 10) {
          nodes {
            login
            avatarUrl
          }
        }
        comments {
          totalCount
        }
        labels(first: 10) {
          nodes {
            name
            color
          }
        }
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT], last: 20) {
          nodes {
            ... on CrossReferencedEvent {
              source {
                ... on PullRequest {
                  number
                  state
                  merged
                  url
                  updatedAt
                }
              }
            }
            ... on ConnectedEvent {
              subject {
                ... on PullRequest {
                  number
                  state
                  merged
                  url
                  updatedAt
                }
              }
            }
          }
        }
      }
    }
    rateLimit {
      cost
      remaining
      resetAt
      limit
    }
  }
`;

export const GET_PR_REVIEW_THREADS_QUERY = `
  query GetPRReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          nodes {
            path
            isResolved
            isOutdated
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
    rateLimit {
      cost
      remaining
      resetAt
      limit
    }
  }
`;

export const GET_PR_QUERY = `
  query GetPR($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number
        title
        bodyText
        url
        state
        isDraft
        merged
        reviewDecision
        createdAt
        updatedAt
        closedAt
        mergedAt
        baseRefName
        headRefName
        headRepository {
          nameWithOwner
        }
        baseRepository {
          nameWithOwner
        }
        author {
          login
          avatarUrl
        }
        assignees(first: 10) {
          nodes {
            login
            avatarUrl
          }
        }
        labels(first: 10) {
          nodes {
            name
            color
          }
        }
        comments {
          totalCount
        }
      }
    }
    rateLimit {
      cost
      remaining
      resetAt
      limit
    }
  }
`;

export function buildGitHubSearchQuery(
  searchText: string | undefined,
  state: string | undefined,
  resourceType: "issue" | "pr"
): string {
  const parts: string[] = [];

  const defaultState = "open";
  const effectiveState = state || defaultState;

  if (effectiveState !== "open") {
    if (resourceType === "pr" && effectiveState === "merged") {
      parts.push("is:merged");
    } else if (effectiveState === "closed") {
      parts.push("is:closed");
    } else if (effectiveState === "all") {
      // No state qualifier for "all"
    }
  }

  if (searchText?.trim()) {
    parts.push(searchText.trim());
  }

  if (effectiveState === "open" && !searchText?.trim()) {
    return "";
  }

  if (effectiveState === "open" && searchText?.trim()) {
    parts.unshift("is:open");
  }

  return parts.join(" ");
}

function escapeGraphQLString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export function buildBatchPRQuery(
  owner: string,
  repo: string,
  candidates: PRCheckCandidate[]
): string {
  const escapedOwner = escapeGraphQLString(owner);
  const escapedRepo = escapeGraphQLString(repo);
  const issueQueries: string[] = [];
  const branchQueries: string[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const validIssueNumber =
      typeof candidate.issueNumber === "number" &&
      Number.isInteger(candidate.issueNumber) &&
      candidate.issueNumber > 0
        ? candidate.issueNumber
        : undefined;
    const branchName = candidate.branchName?.trim();

    if (!validIssueNumber && !branchName) {
      continue;
    }

    const alias = `wt_${i}`;

    if (validIssueNumber) {
      issueQueries.push(`
        ${alias}_issue: repository(owner: "${escapedOwner}", name: "${escapedRepo}") {
          issue(number: ${validIssueNumber}) {
            title
            timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT], last: 20) {
              nodes {
                ... on CrossReferencedEvent {
                  source {
                    ... on PullRequest {
                      number
                      title
                      url
                      state
                      isDraft
                      merged
                      bodyText
                      createdAt
                      updatedAt
                      author { login avatarUrl }
                      assignees(first: 10) { nodes { login avatarUrl } }
                      labels(first: 10) { nodes { name color } }
                      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
                    }
                  }
                }
                ... on ConnectedEvent {
                  subject {
                    ... on PullRequest {
                      number
                      title
                      url
                      state
                      isDraft
                      merged
                      bodyText
                      createdAt
                      updatedAt
                      author { login avatarUrl }
                      assignees(first: 10) { nodes { login avatarUrl } }
                      labels(first: 10) { nodes { name color } }
                      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
                    }
                  }
                }
              }
            }
          }
        }
      `);
    }

    // Query by branch whenever branchName exists - enables PR detection for branches without issue numbers
    // Fetch multiple PRs to allow preference selection (open > merged > closed)
    if (branchName) {
      const escapedBranch = escapeGraphQLString(branchName);
      branchQueries.push(`
        ${alias}_branch: repository(owner: "${escapedOwner}", name: "${escapedRepo}") {
          pullRequests(first: 10, states: [OPEN, MERGED, CLOSED], headRefName: "${escapedBranch}", orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes {
              number
              title
              url
              state
              isDraft
              merged
              bodyText
              createdAt
              updatedAt
              author { login avatarUrl }
              assignees(first: 10) { nodes { login avatarUrl } }
              labels(first: 10) { nodes { name color } }
              commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
            }
          }
        }
      `);
    }
  }

  return `query { ${issueQueries.join("\n")} ${branchQueries.join("\n")} rateLimit { cost remaining resetAt limit } }`;
}

/**
 * Per-chunk cap for {@link buildBatchBranchPRQuery}. GitHub's GraphQL gateway
 * caps complexity per request, and aliased `repository { pullRequests(...) }`
 * blocks each carry a `first: 1` PR connection. 20 aliases per chunk is the
 * empirically safe ceiling — well under the alias resource limit and small
 * enough that retry blast radius stays bounded if one chunk fails.
 */
export const BATCH_BRANCH_CHUNK_SIZE = 20;

/**
 * Build a batched GraphQL query that resolves the most-recent PR for each of
 * `branches` in a single round-trip. Returns one aliased
 * `repository { pullRequests(headRefName: ..., first: 1, ...) }` block per
 * branch; the alias name is index-based (`b0`, `b1`, …) so branch values with
 * special characters never appear as identifiers — only as escaped string
 * literals via {@link escapeGraphQLString}. The caller maps each result back
 * to its branch using the same index order it passed in.
 *
 * The branch list is expected to be ≤ {@link BATCH_BRANCH_CHUNK_SIZE}; the
 * implementation does not chunk internally because chunks must be separate
 * HTTP requests (cost rolls up per-request on the rate limit).
 *
 * Returns an empty string for an empty `branches` array so the caller can
 * skip the request entirely.
 *
 * Field shape matches the per-branch `SEARCH_QUERY` PR fragment subset that
 * `toForgePR` reads: number, title, bodyText, url, state, isDraft, merged,
 * baseRefName, headRefName, createdAt, updatedAt, closedAt, mergedAt, author,
 * and `comments { totalCount }`. Also carries `assignees`/`labels` so
 * `findPRsByBranches` can pre-warm the PR tooltip cache with complete hover
 * data (parity with `buildBatchPRQuery`).
 */
export function buildBatchBranchPRQuery(owner: string, repo: string, branches: string[]): string {
  if (branches.length === 0) return "";
  const escapedOwner = escapeGraphQLString(owner);
  const escapedRepo = escapeGraphQLString(repo);

  const parts = branches.map((branch, i) => {
    const escapedBranch = escapeGraphQLString(branch);
    return `
      b${i}: repository(owner: "${escapedOwner}", name: "${escapedRepo}") {
        pullRequests(first: 1, states: [OPEN, MERGED, CLOSED], headRefName: "${escapedBranch}", orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
            number
            title
            bodyText
            url
            state
            isDraft
            merged
            baseRefName
            headRefName
            createdAt
            updatedAt
            closedAt
            mergedAt
            author { login avatarUrl }
            assignees(first: 10) { nodes { login avatarUrl } }
            labels(first: 10) { nodes { name color } }
            comments { totalCount }
          }
        }
      }
    `;
  });

  return `query { ${parts.join("\n")} rateLimit { cost remaining resetAt limit } }`;
}

/**
 * Build a batched GraphQL query that fetches statusCheckRollup.contexts with per-context
 * `isRequired` flags for each supplied PR number. `pullRequestNumber` must be inlined
 * as an integer literal per alias — GraphQL variables are global to an operation and
 * cannot differ per-alias.
 */
/**
 * Per-chunk cap for aliased GraphQL batch queries. Reuses the empirically
 * safe ceiling from {@link BATCH_BRANCH_CHUNK_SIZE} — 20 aliases per request
 * stays well under GitHub's node-limit ceiling.
 */
export const GRAPHQL_BATCH_CHUNK_SIZE = BATCH_BRANCH_CHUNK_SIZE;

/**
 * Build a batched GraphQL query that fetches multiple issues by number in a
 * single round-trip. Uses a single `repository` block with field-level
 * `i{num}: issue(number: {num})` aliases so the GraphQL engine resolves the
 * repository object once instead of N times.
 *
 * Returns an empty string when `numbers` contains no valid positive integers
 * so the caller can skip the request entirely.
 *
 * Field shape matches {@link GET_ISSUE_QUERY} so {@link parseIssueNode} works
 * unchanged on each per-alias result node.
 */
export function buildBatchIssuesQuery(owner: string, repo: string, numbers: number[]): string {
  const escapedOwner = escapeGraphQLString(owner);
  const escapedRepo = escapeGraphQLString(repo);
  const validNumbers = numbers.filter((n) => typeof n === "number" && Number.isInteger(n) && n > 0);
  if (validNumbers.length === 0) return "";

  const parts = validNumbers.map(
    (num) => `
      i${num}: issue(number: ${num}) {
        number
        title
        bodyText
        url
        state
        createdAt
        updatedAt
        closedAt
        author {
          login
          avatarUrl
        }
        assignees(first: 10) {
          nodes {
            login
            avatarUrl
          }
        }
        comments {
          totalCount
        }
        labels(first: 10) {
          nodes {
            name
            color
          }
        }
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT], last: 20) {
          nodes {
            ... on CrossReferencedEvent {
              source {
                ... on PullRequest {
                  number
                  state
                  merged
                  url
                  updatedAt
                }
              }
            }
            ... on ConnectedEvent {
              subject {
                ... on PullRequest {
                  number
                  state
                  merged
                  url
                  updatedAt
                }
              }
            }
          }
        }
      }
    `
  );

  return `query {
  repository(owner: "${escapedOwner}", name: "${escapedRepo}") {
    ${parts.join("\n    ")}
  }
  rateLimit { cost remaining resetAt limit }
}`;
}

/**
 * Build a batched GraphQL query that fetches multiple PRs by number in a
 * single round-trip. Uses a single `repository` block with field-level
 * `p{num}: pullRequest(number: {num})` aliases.
 *
 * Returns an empty string when `numbers` contains no valid positive integers
 * so the caller can skip the request entirely.
 *
 * Field shape matches {@link GET_PR_QUERY} so {@link parsePRNode} works
 * unchanged on each per-alias result node.
 */
export function buildBatchPRsQuery(owner: string, repo: string, numbers: number[]): string {
  const escapedOwner = escapeGraphQLString(owner);
  const escapedRepo = escapeGraphQLString(repo);
  const validNumbers = numbers.filter((n) => typeof n === "number" && Number.isInteger(n) && n > 0);
  if (validNumbers.length === 0) return "";

  const parts = validNumbers.map(
    (num) => `
      p${num}: pullRequest(number: ${num}) {
        number
        title
        bodyText
        url
        state
        isDraft
        merged
        createdAt
        updatedAt
        closedAt
        mergedAt
        baseRefName
        headRefName
        headRepository {
          nameWithOwner
        }
        baseRepository {
          nameWithOwner
        }
        author {
          login
          avatarUrl
        }
        assignees(first: 10) {
          nodes {
            login
            avatarUrl
          }
        }
        comments {
          totalCount
        }
        labels(first: 10) {
          nodes {
            name
            color
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
              }
            }
          }
        }
      }
    `
  );

  return `query {
  repository(owner: "${escapedOwner}", name: "${escapedRepo}") {
    ${parts.join("\n    ")}
  }
  rateLimit { cost remaining resetAt limit }
}`;
}

export function buildBatchRequiredChecksQuery(
  owner: string,
  repo: string,
  prNumbers: number[]
): string {
  const escapedOwner = escapeGraphQLString(owner);
  const escapedRepo = escapeGraphQLString(repo);
  const validNumbers = prNumbers.filter(
    (n) => typeof n === "number" && Number.isInteger(n) && n > 0
  );
  if (validNumbers.length === 0) return "";

  const parts = validNumbers.map(
    (num) => `
      pr_${num}: repository(owner: "${escapedOwner}", name: "${escapedRepo}") {
        pullRequest(number: ${num}) {
          number
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                  contexts(first: 100) {
                    pageInfo { hasNextPage }
                    nodes {
                      __typename
                      ... on CheckRun {
                        conclusion
                        status
                        isRequired(pullRequestNumber: ${num})
                      }
                      ... on StatusContext {
                        state
                        isRequired(pullRequestNumber: ${num})
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `
  );

  return `query { ${parts.join("\n")} rateLimit { cost remaining resetAt limit } }`;
}

// Narrow lookup of a PR's GraphQL node id. Draft-toggle mutations
// (convertPullRequestToDraft / markPullRequestReadyForReview) require the node
// id, which the normalized PR type intentionally omits — fetch it on demand
// rather than bleed a GitHub-specific id into the provider-neutral contract.
export const GET_PR_NODE_ID_QUERY = `
  query GetPRNodeId($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        id
      }
    }
  }
`;

// REST PATCH can't toggle a PR's draft state; these GraphQL mutations are the
// only path. Both take the PR node id resolved via GET_PR_NODE_ID_QUERY.
export const CONVERT_PR_TO_DRAFT_MUTATION = `
  mutation ConvertPRToDraft($id: ID!) {
    convertPullRequestToDraft(input: { pullRequestId: $id }) {
      pullRequest { id isDraft }
    }
  }
`;

export const MARK_PR_READY_FOR_REVIEW_MUTATION = `
  mutation MarkPRReady($id: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $id }) {
      pullRequest { id isDraft }
    }
  }
`;

export const REPO_METADATA_QUERY = `
  query GetRepoMetadata($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      defaultBranchRef { name }
      isPrivate
      isFork
      isArchived
      description
      licenseInfo { name }
      repositoryTopics(first: 20) { nodes { topic { name } } }
    }
    rateLimit { cost remaining resetAt limit }
  }
`;

export const PR_CI_STATUS_QUERY = `
  query GetPRCIStatus($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      conclusion
                      status
                      isRequired(pullRequestNumber: $number)
                    }
                    ... on StatusContext {
                      context
                      state
                      isRequired(pullRequestNumber: $number)
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    rateLimit { cost remaining resetAt limit }
  }
`;
