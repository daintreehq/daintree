import type { PRCheckCandidate } from "./types.js";

export const REPO_STATS_QUERY = `
  query GetRepoStats($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      issues(states: OPEN) { totalCount }
      pullRequests(states: OPEN) { totalCount }
    }
  }
`;

export const LIST_ISSUES_QUERY = `
  query GetIssues($owner: String!, $repo: String!, $states: [IssueState!], $cursor: String, $limit: Int = 20) {
    repository(owner: $owner, name: $repo) {
      issues(first: $limit, after: $cursor, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}) {
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
          timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 10) {
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
            }
          }
        }
      }
    }
  }
`;

export const LIST_PRS_QUERY = `
  query GetPRs($owner: String!, $repo: String!, $states: [PullRequestState!], $cursor: String, $limit: Int = 20) {
    repository(owner: $owner, name: $repo) {
      pullRequests(first: $limit, after: $cursor, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}) {
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
          author {
            login
            avatarUrl
          }
          reviews(first: 1) {
            totalCount
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
          author {
            login
            avatarUrl
          }
          reviews(first: 1) {
            totalCount
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
        labels(first: 10) {
          nodes {
            name
            color
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
      }
    }
  }
`;

export function buildBatchPRQuery(
  owner: string,
  repo: string,
  candidates: PRCheckCandidate[]
): string {
  const issueQueries: string[] = [];
  const branchQueries: string[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];

    if (!candidate.issueNumber && !candidate.branchName) {
      continue;
    }

    const alias = `wt_${i}`;

    if (candidate.issueNumber) {
      issueQueries.push(`
        ${alias}_issue: repository(owner: "${owner}", name: "${repo}") {
          issue(number: ${candidate.issueNumber}) {
            title
            timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 10) {
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
                    }
                  }
                }
              }
            }
          }
        }
      `);
    }

    if (candidate.issueNumber && candidate.branchName) {
      const escapedBranch = JSON.stringify(candidate.branchName).slice(1, -1);
      branchQueries.push(`
        ${alias}_branch: repository(owner: "${owner}", name: "${repo}") {
          pullRequests(first: 1, states: [OPEN, MERGED, CLOSED], headRefName: "${escapedBranch}", orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes {
              number
              title
              url
              state
              isDraft
              merged
            }
          }
        }
      `);
    }
  }

  return `query { ${issueQueries.join("\n")} ${branchQueries.join("\n")} }`;
}
