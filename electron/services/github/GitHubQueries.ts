import type { PRCheckCandidate } from "./types.js";

export const REPO_STATS_QUERY = `
  query GetRepoStats($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      issues(states: OPEN) { totalCount }
      pullRequests(states: OPEN) { totalCount }
    }
  }
`;

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
          assignees(first: 5) { nodes { login avatarUrl } }
          comments { totalCount }
          labels(first: 10) { nodes { name color } }
          timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT], last: 20) {
            nodes {
              ... on CrossReferencedEvent {
                source { ... on PullRequest { number state merged url } }
              }
              ... on ConnectedEvent {
                subject { ... on PullRequest { number state merged url } }
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
          headRepository { nameWithOwner }
          baseRepository { nameWithOwner }
          author { login avatarUrl }
          reviews(first: 1) { totalCount }
          comments { totalCount }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup { state }
              }
            }
          }
        }
      }
    }
  }
`;

export const PROJECT_HEALTH_QUERY = `
  query GetProjectHealth($owner: String!, $repo: String!, $merged60: String!, $merged120: String!, $merged180: String!) {
    repository(owner: $owner, name: $repo) {
      issues(states: OPEN) { totalCount }
      pullRequests(states: OPEN) { totalCount }
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
    mergedPRs60: search(query: $merged60, type: ISSUE, first: 1) {
      issueCount
    }
    mergedPRs120: search(query: $merged120, type: ISSUE, first: 1) {
      issueCount
    }
    mergedPRs180: search(query: $merged180, type: ISSUE, first: 1) {
      issueCount
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
          url
          state
          updatedAt
          author {
            login
            avatarUrl
          }
          assignees(first: 5) {
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
                  }
                }
              }
            }
          }
        }
      }
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
          url
          state
          isDraft
          updatedAt
          merged
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
          reviews(first: 1) {
            totalCount
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
          url
          state
          updatedAt
          author {
            login
            avatarUrl
          }
          assignees(first: 5) {
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
        }
        ... on PullRequest {
          number
          title
          url
          state
          isDraft
          updatedAt
          merged
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
          reviews(first: 1) {
            totalCount
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
        author {
          login
          avatarUrl
        }
        assignees(first: 5) {
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
                }
              }
            }
          }
        }
      }
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
        createdAt
        updatedAt
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
        assignees(first: 5) {
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
        reviews(first: 1) {
          totalCount
        }
        comments {
          totalCount
        }
      }
    }
  }
`;

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
                      author { login avatarUrl }
                      assignees(first: 5) { nodes { login avatarUrl } }
                      labels(first: 10) { nodes { name color } }
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
                      author { login avatarUrl }
                      assignees(first: 5) { nodes { login avatarUrl } }
                      labels(first: 10) { nodes { name color } }
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
              author { login avatarUrl }
              assignees(first: 5) { nodes { login avatarUrl } }
              labels(first: 10) { nodes { name color } }
            }
          }
        }
      `);
    }
  }

  return `query { ${issueQueries.join("\n")} ${branchQueries.join("\n")} }`;
}

/**
 * Build a batched GraphQL query that fetches statusCheckRollup.contexts with per-context
 * `isRequired` flags for each supplied PR number. `pullRequestNumber` must be inlined
 * as an integer literal per alias — GraphQL variables are global to an operation and
 * cannot differ per-alias.
 */
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
                  contexts(first: 50) {
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

  return `query { ${parts.join("\n")} }`;
}
