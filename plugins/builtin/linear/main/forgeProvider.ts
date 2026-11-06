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
/**
 * Linear accepts `first` up to 250, but a full issue page of that size runs into
 * its per-query complexity limit, so listing pages stop well short of it.
 */
const MAX_PAGE_SIZE = 100;

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

/**
 * One operation's credential, captured once. Every request an operation makes
 * carries the same key, so a key swapped mid-way can't have its later requests
 * answered for a different account, and `version` lets it drop what it learned
 * rather than cache it under the new key.
 */
interface Op {
  auth: { token?: string };
  version: number;
}

function beginOp(): Op {
  const token = getToken();
  return { auth: token ? { token } : {}, version: getTokenVersion() };
}

function isCurrent(op: Op): boolean {
  return op.version === getTokenVersion();
}

/** The key's own user and workspace, cached for as long as the key is unchanged. */
async function getViewer(op: Op = beginOp()): Promise<Viewer> {
  if (cachedViewer && cachedViewer.version === op.version) return cachedViewer.viewer;
  const data = await linearGraphQL<{ viewer: Viewer }>(
    `query { viewer { id name displayName avatarUrl organization { urlKey } } }`,
    {},
    op.auth
  );
  if (isCurrent(op)) cachedViewer = { version: op.version, viewer: data.viewer };
  return data.viewer;
}

/** Counting pages through every open issue's id; past this many, the count reads as unknown. */
const COUNT_PAGE_SIZE = 250;
const COUNT_PAGE_LIMIT = 8;
/**
 * The host polls stats every 30s while visible, and a count can cost several
 * requests against a per-user quota shared with everything else the key does,
 * so a count is reused for a few minutes unless the host asks for a fresh one.
 */
const STATS_CACHE_TTL_MS = 5 * 60_000;

const statsCache = new Map<string, { version: number; at: number; issueCount: number | null }>();
/** Team key → team, per key version: every issue call resolves the project's team first. */
const teamCache = new Map<string, { id: string; key: string }>();
/**
 * Who an issue was assigned to before "Assign to me", by issue id. Linear
 * issues take one assignee, so the Undo has to put that person back rather
 * than leave the issue unassigned — and leave it alone when it was already the
 * viewer's. Undo is offered for seconds, so only the latest few are kept.
 */
const previousAssignees = new Map<string, string | null>();
const PREVIOUS_ASSIGNEES_LIMIT = 50;

function rememberPreviousAssignee(op: Op, issueId: string, assigneeId: string | null): void {
  // A key change cleared this history; don't refill it from the old key's work.
  if (!isCurrent(op)) return;
  previousAssignees.delete(issueId);
  previousAssignees.set(issueId, assigneeId);
  if (previousAssignees.size > PREVIOUS_ASSIGNEES_LIMIT) {
    const oldest = previousAssignees.keys().next().value;
    if (oldest !== undefined) previousAssignees.delete(oldest);
  }
}

export function clearLinearCaches(): void {
  cachedViewer = null;
  statsCache.clear();
  teamCache.clear();
  previousAssignees.clear();
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
    // A full key only means a number in this team: `DES-42` is not `ENG-42`.
    const asKey = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(search);
    const number =
      asNumber?.[1] ?? (asKey?.[1].toUpperCase() === teamKeyOf(repo) ? asKey[2] : undefined);
    filter.or = [
      { title: { containsIgnoreCase: search } },
      ...(number ? [{ number: { eq: Number(number) } }] : []),
    ];
  }
  return filter;
}

/**
 * Linear's public `issues(orderBy:)` takes `createdAt` (its default) or
 * `updatedAt` and always lists newest first; the argument that carries a
 * direction, `sort`, is `[INTERNAL]` in its schema. An order it can't serve is
 * refused by name, never answered with a page in some other order (#15604).
 */
function issueOrderBy(opts: ListOptions): "createdAt" | "updatedAt" {
  const direction = opts.direction ?? "desc";
  if (direction !== "desc") {
    throw new Error(
      `Linear lists issues newest first only, so direction "${direction}" can't be served. Omit direction or pass "desc".`
    );
  }
  const sort = opts.sort ?? "created";
  if (sort === "created") return "createdAt";
  if (sort === "updated") return "updatedAt";
  throw new Error(`Linear can't sort issues by "${sort}". Pass sort "created" or "updated".`);
}

async function findIssue(
  filter: Record<string, unknown>,
  op: Op = beginOp()
): Promise<Issue | null> {
  const data = await linearGraphQL<{ issues: { nodes: LinearIssueNode[] } }>(
    `query ($filter: IssueFilter) { issues(filter: $filter, first: 1) { nodes { ${ISSUE_FIELDS} } } }`,
    { filter },
    op.auth
  );
  const node = data.issues.nodes[0];
  return node ? mapIssue(node) : null;
}

/** The issue a mutation targets, with the UUID every Linear mutation takes. */
async function requireIssue(
  repo: RepoRef,
  number: number,
  op: Op
): Promise<Issue & { id: string }> {
  const issue = await findIssue(
    { team: { key: { eq: teamKeyOf(repo) } }, number: { eq: number } },
    op
  );
  if (!issue?.id) {
    throw new Error(`Linear issue ${teamKeyOf(repo)}-${number} wasn't found`);
  }
  return issue as Issue & { id: string };
}

function assigneeIdOf(issue: Issue): string | null {
  return (issue.assignees[0]?.rawData as { id?: string } | undefined)?.id ?? null;
}

async function setAssignee(id: string, assigneeId: string | null, op: Op): Promise<ForgeUser[]> {
  const data = await linearGraphQL<{
    issueUpdate: { success: boolean; issue: { assignee: LinearUserNode | null } | null };
  }>(
    `mutation ($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue { assignee { id name displayName avatarUrl } }
      }
    }`,
    { id, input: { assigneeId } },
    op.auth
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
async function requireViewerFor(username: string, op: Op): Promise<Viewer> {
  const viewer = await getViewer(op);
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
async function countOpenIssues(repo: RepoRef, op: Op): Promise<number | null> {
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
      { filter, first: COUNT_PAGE_SIZE, after },
      op.auth
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
    const op = beginOp();
    const now = Date.now();
    const cached = statsCache.get(key);
    if (
      !opts?.bypassCache &&
      cached &&
      cached.version === op.version &&
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
    const issueCount = await countOpenIssues(repo, op);
    if (isCurrent(op)) statsCache.set(key, { version: op.version, at: now, issueCount });
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
    const op = beginOp();
    const viewer = await getViewer(op);
    const cacheKey = `${op.version}\u0000${teamKey}`;
    let team = teamCache.get(cacheKey);
    if (!team) {
      const data = await linearGraphQL<{ teams: { nodes: Array<{ id: string; key: string }> } }>(
        `query ($key: String!) { teams(filter: { key: { eq: $key } }, first: 1) { nodes { id key } } }`,
        { key: teamKey },
        op.auth
      );
      team = data.teams.nodes[0];
      if (!team) {
        throw new Error(
          `Linear has no team with the key ${teamKey} in this workspace. Check the team key in Project settings.`
        );
      }
      if (isCurrent(op)) teamCache.set(cacheKey, team);
    }
    const rawData: ResolvedRepoData = { teamId: team.id };
    return { host: LINEAR_HOST, owner: viewer.organization.urlKey, repo: team.key, rawData };
  },

  async listIssues(repo: RepoRef, opts: ListOptions): Promise<Page<Issue>> {
    const orderBy = issueOrderBy(opts);
    const first = Math.min(Math.max(opts.perPage ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const data = await linearGraphQL<{
      issues: {
        nodes: LinearIssueNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(
      `query ($filter: IssueFilter, $first: Int!, $after: String, $orderBy: PaginationOrderBy!) {
        issues(filter: $filter, first: $first, after: $after, orderBy: $orderBy) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { filter: issueFilter(repo, opts), first, after: opts.cursor ?? null, orderBy }
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
    const op = beginOp();
    const viewer = await requireViewerFor(username, op);
    const issue = await requireIssue(repo, issueNumber, op);
    const before = assigneeIdOf(issue);
    rememberPreviousAssignee(op, issue.id, before);
    if (before === viewer.id) return issue.assignees;
    return setAssignee(issue.id, viewer.id, op);
  },

  async unassignIssue(repo: RepoRef, issueNumber: number, username: string): Promise<ForgeUser[]> {
    const op = beginOp();
    const viewer = await requireViewerFor(username, op);
    const current = await requireIssue(repo, issueNumber, op);
    const previous = previousAssignees.has(current.id)
      ? (previousAssignees.get(current.id) ?? null)
      : null;
    previousAssignees.delete(current.id);
    // Only take the issue off the viewer, and only if "Assign to me" put it
    // there: if someone else picked it up since, or it was already the
    // viewer's, there is nothing of ours to undo.
    if (assigneeIdOf(current) !== viewer.id || previous === viewer.id) {
      return current.assignees;
    }
    // Hand it back to whoever "Assign to me" took it from.
    return setAssignee(current.id, previous, op);
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
