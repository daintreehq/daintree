import type {
  AuthValidation,
  Credentials,
  FetchOptions,
  ForgeIssueProviderImpl,
  ForgeUser,
  IdentityCapability,
  Issue,
  ListOptions,
  Page,
  RepoRef,
  RepoStatsCapability,
  RepoStatsSnapshot,
} from "../../../../shared/types/forge.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import {
  LinearApiError,
  getToken,
  getTokenVersion,
  linearGraphQL,
  setMemoryToken,
} from "./LinearClient.js";
import {
  CLOSED_STATE_TYPES,
  ISSUE_FIELDS,
  mapIssue,
  mapUser,
  type LinearIssueNode,
  type LinearUserNode,
} from "./mappers.js";

export const LINEAR_HOST = "linear.app";
const DEFAULT_PAGE_SIZE = 50;
/** Linear caps `first` at 250. */
const MAX_PAGE_SIZE = 250;

/** Linear team keys: letters and digits, starting with a letter. */
const TEAM_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;

interface Viewer extends LinearUserNode {
  organization: { urlKey: string };
}

interface ResolvedRepoData {
  teamId: string;
}

let teamKeyReader: ((projectPath: string) => Promise<string | undefined>) | null = null;

/** Wired by `activate()`: reads the project's `teamKey` setting for one project path. */
export function setTeamKeyReader(
  reader: ((projectPath: string) => Promise<string | undefined>) | null
): void {
  teamKeyReader = reader;
}

let cachedViewer: { version: number; viewer: Viewer } | null = null;

/** The key's own user and workspace, cached for as long as the key is unchanged. */
async function getViewer(): Promise<Viewer> {
  const version = getTokenVersion();
  if (cachedViewer && cachedViewer.version === version) return cachedViewer.viewer;
  const data = await linearGraphQL<{ viewer: Viewer }>(
    `query { viewer { id name displayName avatarUrl organization { urlKey } } }`
  );
  if (getTokenVersion() === version) cachedViewer = { version, viewer: data.viewer };
  return data.viewer;
}

/** Counting pages through every open issue's id; past this many, the count reads as unknown. */
const COUNT_PAGE_SIZE = 250;
const COUNT_PAGE_LIMIT = 8;
const STATS_CACHE_TTL_MS = 60_000;

const statsCache = new Map<string, { version: number; at: number; issueCount: number | null }>();

export function clearLinearCaches(): void {
  cachedViewer = null;
  statsCache.clear();
}

/** Normalize a stored team key, or `null` when it can't be one. */
export function normalizeTeamKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toUpperCase();
  return TEAM_KEY_PATTERN.test(key) ? key : null;
}

function teamKeyOf(repo: RepoRef): string {
  return repo.repo;
}

function notSupported(action: string): Promise<never> {
  return Promise.reject(
    new Error(`${action} isn't supported for Linear issues yet. Do it in Linear instead.`)
  );
}

function issueFilter(repo: RepoRef, opts: ListOptions): Record<string, unknown> {
  const filter: Record<string, unknown> = { team: { key: { eq: teamKeyOf(repo) } } };
  const state = opts.state ?? "open";
  if (state === "closed") {
    filter.state = { type: { in: [...CLOSED_STATE_TYPES] } };
  } else if (state !== "all") {
    // "merged" means nothing for an issue; it reads as the open set (ListOptions).
    filter.state = { type: { nin: [...CLOSED_STATE_TYPES] } };
  }
  const search = opts.search?.trim();
  if (search) {
    const asNumber = /^#?(\d+)$/.exec(search);
    const asKey = /^[A-Za-z][A-Za-z0-9_]*-(\d+)$/.exec(search);
    const number = asNumber?.[1] ?? asKey?.[1];
    filter.or = [
      { title: { containsIgnoreCase: search } },
      ...(number ? [{ number: { eq: Number(number) } }] : []),
    ];
  }
  return filter;
}

async function findIssue(filter: Record<string, unknown>): Promise<Issue | null> {
  const data = await linearGraphQL<{ issues: { nodes: LinearIssueNode[] } }>(
    `query ($filter: IssueFilter) { issues(filter: $filter, first: 1) { nodes { ${ISSUE_FIELDS} } } }`,
    { filter }
  );
  const node = data.issues.nodes[0];
  return node ? mapIssue(node) : null;
}

/** The issue's UUID, which every Linear mutation takes. */
async function requireIssueId(repo: RepoRef, number: number): Promise<string> {
  const issue = await findIssue({
    team: { key: { eq: teamKeyOf(repo) } },
    number: { eq: number },
  });
  if (!issue?.id) {
    throw new Error(`Linear issue ${teamKeyOf(repo)}-${number} wasn't found`);
  }
  return issue.id;
}

async function setAssignee(id: string, assigneeId: string | null): Promise<ForgeUser[]> {
  const data = await linearGraphQL<{
    issueUpdate: { success: boolean; issue: { assignee: LinearUserNode | null } | null };
  }>(
    `mutation ($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue { assignee { id name displayName avatarUrl } }
      }
    }`,
    { id, input: { assigneeId } }
  );
  if (!data.issueUpdate.success) throw new Error("Linear didn't update the issue's assignee");
  const assignee = data.issueUpdate.issue?.assignee;
  return assignee ? [mapUser(assignee)] : [];
}

/**
 * Linear issues have one assignee, and the host only ever assigns the viewer
 * ("Assign to me" and its Undo), so the username names the viewer: assigning
 * anyone else is refused rather than guessed at.
 */
async function requireViewerFor(username: string): Promise<Viewer> {
  const viewer = await getViewer();
  const handles = [viewer.displayName, viewer.name, viewer.id].filter(Boolean);
  if (!handles.includes(username)) {
    throw new Error("Linear issues can only be assigned to you from Daintree");
  }
  return viewer;
}

async function validateWithToken(token?: string): Promise<AuthValidation> {
  try {
    const data = await linearGraphQL<{ viewer: Viewer }>(
      `query { viewer { id name displayName avatarUrl organization { urlKey } } }`,
      {},
      token ? { token } : {}
    );
    const viewer = data.viewer;
    return { valid: true, account: viewer.displayName || viewer.name || viewer.id };
  } catch (err) {
    return { valid: false, error: formatErrorMessage(err, "Couldn't validate the Linear API key") };
  }
}

/**
 * Linear's issue connection carries no total, so the open count is read by
 * paging through the open set's ids — never the length of one page, which is
 * the page size rather than a count. Teams too large to count within
 * {@link COUNT_PAGE_LIMIT} pages report the count as unknown.
 */
async function countOpenIssues(repo: RepoRef): Promise<number | null> {
  const filter = issueFilter(repo, { state: "open" });
  let count = 0;
  let after: string | null = null;
  for (let page = 0; page < COUNT_PAGE_LIMIT; page++) {
    const data: {
      issues: {
        nodes: Array<{ id: string }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await linearGraphQL(
      `query ($filter: IssueFilter, $first: Int!, $after: String) {
        issues(filter: $filter, first: $first, after: $after) {
          nodes { id }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { filter, first: COUNT_PAGE_SIZE, after }
    );
    count += data.issues.nodes.length;
    if (!data.issues.pageInfo.hasNextPage) return count;
    after = data.issues.pageInfo.endCursor;
  }
  return null;
}

/**
 * Without this the host would count the toolbar's issues by listing one issue
 * per poll, which carries no total and so marks every stats poll unclean.
 * Linear has no pull requests, so the PR count is always unknown here; the host
 * takes only the issue side of an issues provider's snapshot.
 */
const repoStatsCapability: RepoStatsCapability = {
  async getRepoStats(repo: RepoRef, opts?: { bypassCache?: boolean }): Promise<RepoStatsSnapshot> {
    const key = `${repo.owner}/${teamKeyOf(repo)}`;
    const version = getTokenVersion();
    const now = Date.now();
    const cached = statsCache.get(key);
    if (
      !opts?.bypassCache &&
      cached &&
      cached.version === version &&
      now - cached.at < STATS_CACHE_TTL_MS
    ) {
      return {
        counts: {
          issueCount: cached.issueCount,
          prCount: null,
          lastUpdated: cached.at,
          issueCountRefreshedAt: cached.at,
        },
        source: "memory-cache",
      };
    }
    const issueCount = await countOpenIssues(repo);
    if (getTokenVersion() === version) statsCache.set(key, { version, at: now, issueCount });
    return {
      counts: { issueCount, prCount: null, lastUpdated: now, issueCountRefreshedAt: now },
      source: "network",
    };
  },
};

const identityCapability: IdentityCapability = {
  async getCurrentUser(): Promise<ForgeUser | null> {
    if (!getToken()) return null;
    try {
      return mapUser(await getViewer());
    } catch (err) {
      if (err instanceof LinearApiError && err.credentialRejected) return null;
      throw err;
    }
  },
};

export const linearForgeProvider: ForgeIssueProviderImpl = {
  async getCredentials(): Promise<Credentials | null> {
    const token = getToken();
    return token ? { kind: "bearer", value: token } : null;
  },

  setCredentials(credentials: Credentials | null): void {
    const before = getTokenVersion();
    setMemoryToken(credentials?.value ?? null);
    if (getTokenVersion() !== before) clearLinearCaches();
  },

  async validateCredentials(): Promise<AuthValidation> {
    if (!getToken()) return { valid: false, error: "No Linear API key configured" };
    return validateWithToken();
  },

  async validateToken(token: string): Promise<AuthValidation> {
    if (!token || !token.trim()) return { valid: false, error: "API key is required" };
    return validateWithToken(token.trim());
  },

  async resolveIssueRepo(projectPath: string): Promise<RepoRef | null> {
    const teamKey = normalizeTeamKey(await teamKeyReader?.(projectPath));
    if (!teamKey) return null;
    const viewer = await getViewer();
    const data = await linearGraphQL<{ teams: { nodes: Array<{ id: string; key: string }> } }>(
      `query ($key: String!) { teams(filter: { key: { eq: $key } }, first: 1) { nodes { id key } } }`,
      { key: teamKey }
    );
    const team = data.teams.nodes[0];
    if (!team) {
      throw new Error(
        `Linear has no team with the key ${teamKey} in this workspace. Check the team key in Project settings.`
      );
    }
    const rawData: ResolvedRepoData = { teamId: team.id };
    return { host: LINEAR_HOST, owner: viewer.organization.urlKey, repo: team.key, rawData };
  },

  async listIssues(repo: RepoRef, opts: ListOptions): Promise<Page<Issue>> {
    const first = Math.min(Math.max(opts.perPage ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const data = await linearGraphQL<{
      issues: {
        nodes: LinearIssueNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(
      `query ($filter: IssueFilter, $first: Int!, $after: String) {
        issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { filter: issueFilter(repo, opts), first, after: opts.cursor ?? null }
    );
    const { nodes, pageInfo } = data.issues;
    return {
      items: nodes.map(mapIssue),
      nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null,
      hasMore: pageInfo.hasNextPage,
    };
  },

  async getIssue(repo: RepoRef, number: number, _options?: FetchOptions): Promise<Issue | null> {
    return findIssue({ team: { key: { eq: teamKeyOf(repo) } }, number: { eq: number } });
  },

  async getIssueById(_repo: RepoRef, id: string, _options?: FetchOptions): Promise<Issue | null> {
    try {
      const data = await linearGraphQL<{ issue: LinearIssueNode | null }>(
        `query ($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
        { id }
      );
      return data.issue ? mapIssue(data.issue) : null;
    } catch (err) {
      // Linear answers an unknown id with an "Entity not found" error, not null.
      if (err instanceof LinearApiError && err.kind === "not_found") {
        return null;
      }
      throw err;
    }
  },

  async getIssueBranchKeys(repo: RepoRef): Promise<string[]> {
    return [teamKeyOf(repo)];
  },

  buildIssueUrl(repo: RepoRef, number: number): string {
    return `https://${LINEAR_HOST}/${repo.owner}/issue/${teamKeyOf(repo)}-${number}`;
  },

  buildIssuesUrl(repo: RepoRef): string {
    return `https://${LINEAR_HOST}/${repo.owner}/team/${teamKeyOf(repo)}/all`;
  },

  async assignIssue(repo: RepoRef, issueNumber: number, username: string): Promise<ForgeUser[]> {
    const viewer = await requireViewerFor(username);
    return setAssignee(await requireIssueId(repo, issueNumber), viewer.id);
  },

  async unassignIssue(repo: RepoRef, issueNumber: number, username: string): Promise<ForgeUser[]> {
    const viewer = await requireViewerFor(username);
    const current = await findIssue({
      team: { key: { eq: teamKeyOf(repo) } },
      number: { eq: issueNumber },
    });
    if (!current?.id) {
      throw new Error(`Linear issue ${teamKeyOf(repo)}-${issueNumber} wasn't found`);
    }
    // Only take the issue off the viewer: if someone else picked it up since,
    // the Undo has nothing of ours to undo.
    const assignee = current.assignees[0];
    if (!assignee || (assignee.rawData as { id?: string }).id !== viewer.id) {
      return current.assignees;
    }
    return setAssignee(current.id, null);
  },

  createIssue: () => notSupported("Creating issues"),
  closeIssue: () => notSupported("Closing issues"),
  reopenIssue: () => notSupported("Reopening issues"),
  editIssue: () => notSupported("Editing issues"),
  addIssueComment: () => notSupported("Commenting on issues"),
  addIssueLabel: () => notSupported("Adding labels"),
  removeIssueLabel: () => notSupported("Removing labels"),

  identity: identityCapability,
  repoStats: repoStatsCapability,
};
