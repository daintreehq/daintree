import type {
  AuthValidation,
  Credentials,
  FetchOptions,
  ForgeIssueProviderImpl,
  ForgeUser,
  IdentityCapability,
  Issue,
  IssueComment,
  IssueCommentCapability,
  ListOptions,
  Page,
  RepoRef,
  RepoStatsCapability,
  RepoStatsSnapshot,
} from "../../../../shared/types/forge.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { normalizeEmail, normalizeSiteUrl, siteHostOf } from "../shared/connection.js";
import {
  JiraApiError,
  clearJiraCooldown,
  getToken,
  getTokenVersion,
  jiraRequest,
  setMemoryToken,
  type JiraConnection,
} from "./JiraClient.js";
import { buildIssueJql, issueFilterJql, issueKeyInSearch, textSearchClause } from "./jql.js";
import {
  ISSUE_FIELDS,
  issueNumberOf,
  mapComment,
  mapIssue,
  mapUser,
  type JiraCommentNode,
  type JiraIssueNode,
  type JiraUserNode,
} from "./mappers.js";

const DEFAULT_PAGE_SIZE = 50;
/** Jira caps a search that returns fields at 100 per page, whatever is asked for. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_COMMENTS_PAGE_SIZE = 20;
const MAX_COMMENTS_PAGE_SIZE = 100;

/** Jira project keys: letters and digits, starting with a letter. */
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,15}$/;
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;
/** What `stableIssueId` hands out: `acme.atlassian.net/10042`. */
const STABLE_ISSUE_ID_PATTERN = /^([a-z0-9.-]+)\/(\d+)$/;

/**
 * The host polls stats every 30s while visible, against a rate limit shared with
 * everything else the account does, so a count is reused for a few minutes
 * unless the host asks for a fresh one.
 */
const STATS_CACHE_TTL_MS = 5 * 60_000;

const NOT_CONNECTED_MESSAGE =
  "Jira isn't connected. Add your site, email and API token in Settings → Code forge.";

interface ConnectionSettings {
  siteUrl?: unknown;
  email?: unknown;
}

let connectionSettingsReader: (() => Promise<ConnectionSettings>) | null = null;
let projectKeyReader: ((projectPath: string) => Promise<string | undefined>) | null = null;

/** Wired by `activate()`: reads the user-scoped site URL and account email. */
export function setConnectionSettingsReader(
  reader: (() => Promise<ConnectionSettings>) | null
): void {
  connectionSettingsReader = reader;
}

/** Wired by `activate()`: reads the project's `projectKey` setting for one project path. */
export function setProjectKeyReader(
  reader: ((projectPath: string) => Promise<string | undefined>) | null
): void {
  projectKeyReader = reader;
}

/**
 * One operation's connection, captured once, so every request it makes goes to
 * the same site as the same account. `scope` names that connection in cache
 * keys: what one connection learned is never served to another, with no
 * subscription needed to notice the settings changing.
 */
interface Op {
  connection: JiraConnection;
  scope: string;
}

async function readConnectionSettings(): Promise<{
  siteUrl: string | null;
  email: string | null;
}> {
  const settings = (await connectionSettingsReader?.()) ?? {};
  return { siteUrl: normalizeSiteUrl(settings.siteUrl), email: normalizeEmail(settings.email) };
}

/** `null` until a token, site and email are all set. */
async function connectedOp(): Promise<Op | null> {
  const token = getToken();
  const version = getTokenVersion();
  const { siteUrl, email } = await readConnectionSettings();
  if (!token || !siteUrl || !email) return null;
  return {
    connection: { siteUrl, email, token },
    scope: `${version}\u0000${siteUrl}\u0000${email}`,
  };
}

async function beginOp(): Promise<Op> {
  const op = await connectedOp();
  if (!op) throw new JiraApiError(NOT_CONNECTED_MESSAGE);
  return op;
}

const statsCache = new Map<string, { at: number; issueCount: number | null }>();
let statsCacheScope: string | null = null;

interface Viewer {
  accountId: string;
  user: ForgeUser;
}

/** The connection's own account, for the connection it was read under. */
let cachedViewer: { scope: string; viewer: Viewer } | null = null;

/** Who an issue was assigned to before "Assign to me": `null` when nobody was. */
type PreviousAssignee = { accountId: string; user: ForgeUser } | null;

/**
 * By connection and issue. Jira issues take one assignee, so the Undo has to put
 * that person back rather than leave the issue unassigned, and leave it alone
 * when it was already the viewer's. Undo is offered for seconds, so only the
 * latest few are kept.
 */
const previousAssignees = new Map<string, PreviousAssignee>();
const PREVIOUS_ASSIGNEES_LIMIT = 50;

export function clearJiraCaches(): void {
  statsCache.clear();
  statsCacheScope = null;
  cachedViewer = null;
  previousAssignees.clear();
  clearJiraCooldown();
}

async function getViewer(op: Op): Promise<Viewer> {
  if (cachedViewer?.scope === op.scope) return cachedViewer.viewer;
  const node = await jiraRequest<JiraUserNode>(op.connection, "/myself");
  if (!node.accountId) throw new JiraApiError("Jira didn't recognize this account");
  const viewer = { accountId: node.accountId, user: mapUser(node) };
  cachedViewer = { scope: op.scope, viewer };
  return viewer;
}

/**
 * The host only ever assigns the viewer ("Assign to me" and its Undo), passing
 * the login `getCurrentUser` gave it, so assigning anyone else is refused rather
 * than guessed at.
 */
async function requireViewerFor(username: string, op: Op): Promise<Viewer> {
  const viewer = await getViewer(op);
  if (username !== viewer.user.login.trim() && username !== viewer.accountId) {
    throw new Error("Jira issues can only be assigned to you from Daintree");
  }
  return viewer;
}

function previousAssigneeKey(op: Op, issueId: string): string {
  return `${op.scope}\u0000${issueId}`;
}

function rememberPreviousAssignee(key: string, previous: PreviousAssignee): void {
  previousAssignees.delete(key);
  previousAssignees.set(key, previous);
  if (previousAssignees.size > PREVIOUS_ASSIGNEES_LIMIT) {
    const oldest = previousAssignees.keys().next().value;
    if (oldest !== undefined) previousAssignees.delete(oldest);
  }
}

/** Normalize a stored project key, or `null` when it can't be one. */
export function normalizeProjectKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toUpperCase();
  return PROJECT_KEY_PATTERN.test(key) ? key : null;
}

function notSupported(action: string): Promise<never> {
  return Promise.reject(
    new Error(`${action} isn't supported for Jira issues yet. Do it in Jira instead.`)
  );
}

async function findIssueNode(
  idOrKey: string,
  fields: readonly string[],
  op: Op
): Promise<JiraIssueNode | null> {
  try {
    return await jiraRequest<JiraIssueNode>(
      op.connection,
      `/issue/${encodeURIComponent(idOrKey)}?fields=${fields.join(",")}`
    );
  } catch (err) {
    // Jira answers an unknown issue and one the account can't see alike.
    if (err instanceof JiraApiError && err.status === 404) return null;
    throw err;
  }
}

async function fetchIssue(idOrKey: string, op: Op): Promise<Issue | null> {
  const node = await findIssueNode(idOrKey, ISSUE_FIELDS, op);
  return node ? mapIssue(node, op.connection.siteUrl) : null;
}

/**
 * The project's issue with this number, by the same rule as `getIssue`: a moved
 * issue answers to its old key with a new number, and isn't this one.
 */
async function requireIssueNode(
  repo: RepoRef,
  number: number,
  fields: readonly string[],
  op: Op
): Promise<JiraIssueNode> {
  const key = `${repo.repo}-${number}`;
  const node = await findIssueNode(key, fields, op);
  if (!node || issueNumberOf(node.key) !== number) {
    throw new JiraApiError(`Jira issue ${key} wasn't found`, 404);
  }
  return node;
}

async function setAssignee(issueId: string, accountId: string | null, op: Op): Promise<void> {
  await jiraRequest<void>(op.connection, `/issue/${encodeURIComponent(issueId)}/assignee`, {
    method: "PUT",
    body: { accountId },
  });
}

function assigneesOf(node: JiraIssueNode): ForgeUser[] {
  const assignee = node.fields?.assignee;
  return assignee ? [mapUser(assignee)] : [];
}

interface JiraSearchResponse {
  issues?: JiraIssueNode[];
  nextPageToken?: string | null;
  isLast?: boolean;
}

/**
 * `POST /search/jql`, the replacement for the retired `/search`. It has no
 * `total` and no offsets: its `nextPageToken` is the only way forward, and it
 * only works with the JQL that produced it. That holds here, because the host
 * sends a cursor back with the same options.
 */
async function searchIssues(jql: string, opts: ListOptions, op: Op): Promise<Page<Issue>> {
  const maxResults = Math.min(Math.max(opts.perPage ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const data = await jiraRequest<JiraSearchResponse>(op.connection, "/search/jql", {
    method: "POST",
    body: {
      jql,
      maxResults,
      fields: ISSUE_FIELDS,
      ...(opts.cursor ? { nextPageToken: opts.cursor } : {}),
    },
  });
  const nextCursor = data.isLast === true ? null : (data.nextPageToken ?? null);
  return {
    items: (data.issues ?? []).map((node) => mapIssue(node, op.connection.siteUrl)),
    nextCursor,
    hasMore: nextCursor !== null,
  };
}

function matchesState(issue: Issue, state: ListOptions["state"]): boolean {
  if (state === "all") return true;
  return issue.state === (state === "closed" ? "closed" : "open");
}

async function validateWithToken(token: string): Promise<AuthValidation> {
  try {
    const { siteUrl, email } = await readConnectionSettings();
    if (!siteUrl) {
      return {
        valid: false,
        error: "Add your Jira Cloud site URL, like https://acme.atlassian.net",
      };
    }
    if (!email) return { valid: false, error: "Add your Atlassian account email" };
    const me = await jiraRequest<{
      accountId?: string;
      displayName?: string;
      emailAddress?: string;
    }>({ siteUrl, email, token }, "/myself", { ignoreCooldown: true });
    if (!me.accountId) return { valid: false, error: "Jira didn't recognize this account" };
    return { valid: true, account: me.displayName || me.emailAddress || me.accountId };
  } catch (err) {
    return { valid: false, error: formatErrorMessage(err, "Couldn't validate the Jira API token") };
  }
}

/**
 * Without this the host would count the toolbar's issues by listing one issue
 * per poll, which carries no total. Jira has no pull requests, so the PR count is
 * always unknown here; the host takes only the issue side of an issues provider's
 * snapshot.
 */
const repoStatsCapability: RepoStatsCapability = {
  async getRepoStats(repo: RepoRef, opts?: { bypassCache?: boolean }): Promise<RepoStatsSnapshot> {
    const op = await beginOp();
    // Entries for a connection that's gone can never be read again.
    if (statsCacheScope !== op.scope) {
      statsCache.clear();
      statsCacheScope = op.scope;
    }
    // Qualified anyway: a count landing after a switch mustn't pass for the new one's.
    const key = `${op.scope}\u0000${repo.repo}`;
    const now = Date.now();
    const cached = statsCache.get(key);
    if (!opts?.bypassCache && cached && now - cached.at < STATS_CACHE_TTL_MS) {
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
    const data = await jiraRequest<{ count?: unknown }>(
      op.connection,
      "/search/approximate-count",
      { method: "POST", body: { jql: issueFilterJql(repo.repo, "open") } }
    );
    const issueCount = typeof data.count === "number" ? data.count : null;
    statsCache.set(key, { at: now, issueCount });
    return {
      counts: { issueCount, prCount: null, lastUpdated: now, issueCountRefreshedAt: now },
      source: "network",
    };
  },
};

const identityCapability: IdentityCapability = {
  async getCurrentUser(): Promise<ForgeUser | null> {
    const op = await connectedOp();
    if (!op) return null;
    try {
      return (await getViewer(op)).user;
    } catch (err) {
      if (err instanceof JiraApiError && err.credentialRejected) return null;
      throw err;
    }
  },
};

function pageSizeOf(perPage: number | undefined): number {
  if (typeof perPage !== "number" || !Number.isFinite(perPage)) return DEFAULT_COMMENTS_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(perPage), 1), MAX_COMMENTS_PAGE_SIZE);
}

/** A comment cursor is the offset of the page's first comment, as this hands it out. */
function offsetOf(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = /^\d+$/.test(cursor) ? Number(cursor) : NaN;
  if (!Number.isSafeInteger(offset)) throw new Error("Invalid Jira comments cursor");
  return offset;
}

interface JiraCommentsResponse {
  startAt?: number;
  total?: number;
  comments?: JiraCommentNode[];
}

/**
 * Oldest first, the contract's order and Jira's own, asked for by name anyway.
 * The issue is looked up first so a missing one throws rather than reading as a
 * thread nobody has replied to, and so a moved one is refused as `getIssue`
 * refuses it, though Jira would serve its comments under the old key.
 */
const issueCommentCapability: IssueCommentCapability = {
  async listIssueComments(
    repo: RepoRef,
    issueNumber: number,
    opts: ListOptions
  ): Promise<Page<IssueComment>> {
    const startAt = offsetOf(opts.cursor);
    const maxResults = pageSizeOf(opts.perPage);
    const op = await beginOp();
    const issue = await requireIssueNode(repo, issueNumber, ["summary"], op);
    const query = new URLSearchParams({
      startAt: String(startAt),
      maxResults: String(maxResults),
      orderBy: "created",
    });
    const data = await jiraRequest<JiraCommentsResponse>(
      op.connection,
      `/issue/${encodeURIComponent(issue.id)}/comment?${query}`
    );
    const comments = data.comments ?? [];
    const next = (typeof data.startAt === "number" ? data.startAt : startAt) + comments.length;
    const total = typeof data.total === "number" ? data.total : null;
    // An empty page ends the thread whatever the total says, or a total that
    // drifted up would hand out the same cursor forever.
    const hasMore =
      comments.length > 0 && (total === null ? comments.length >= maxResults : next < total);
    return {
      items: comments.map((node) => mapComment(node, op.connection.siteUrl, issue.key)),
      nextCursor: hasMore ? String(next) : null,
      hasMore,
      ...(total === null ? {} : { totalCount: total }),
    };
  },
};

export const jiraForgeProvider: ForgeIssueProviderImpl = {
  async getCredentials(): Promise<Credentials | null> {
    const token = getToken();
    return token ? { kind: "bearer", value: token } : null;
  },

  setCredentials(credentials: Credentials | null): void {
    const before = getTokenVersion();
    setMemoryToken(credentials?.value ?? null);
    if (getTokenVersion() !== before) clearJiraCaches();
  },

  async validateCredentials(): Promise<AuthValidation> {
    const token = getToken();
    if (!token) return { valid: false, error: "No Jira API token configured" };
    return validateWithToken(token);
  },

  /**
   * The host hands over the token alone, so the site and email it's checked with
   * are the plugin's own settings. The settings tab writes those first.
   */
  async validateToken(token: string): Promise<AuthValidation> {
    if (!token || !token.trim()) return { valid: false, error: "API token is required" };
    return validateWithToken(token.trim());
  },

  /**
   * Answered from settings alone, on purpose. Branch claims hang off this, and the
   * host reads a failure here as "no claim" without trying again, so a network
   * blip at project load would lose them until the next reload. A key that doesn't
   * exist comes back in Jira's own words from the first search.
   */
  async resolveIssueRepo(projectPath: string): Promise<RepoRef | null> {
    const projectKey = normalizeProjectKey(await projectKeyReader?.(projectPath));
    if (!projectKey) return null;
    const { siteUrl } = await readConnectionSettings();
    if (!siteUrl) throw new JiraApiError(NOT_CONNECTED_MESSAGE);
    const host = siteHostOf(siteUrl);
    return { host, owner: host.split(".")[0], repo: projectKey, rawData: null };
  },

  async listIssues(repo: RepoRef, opts: ListOptions): Promise<Page<Issue>> {
    const jql = buildIssueJql(repo.repo, opts);
    if (jql === null) return { items: [], nextCursor: null, hasMore: false };
    const op = await beginOp();
    const namedKey = opts.search && !opts.cursor ? issueKeyInSearch(opts.search, repo.repo) : null;
    const [named, page] = await Promise.all([
      namedKey ? fetchIssue(namedKey, op) : null,
      searchIssues(jql, opts, op),
    ]);
    // A moved issue answers to its old key with a new number, and isn't this
    // project's. A renamed project keeps the number.
    if (
      !named ||
      !namedKey ||
      named.number !== issueNumberOf(namedKey) ||
      !matchesState(named, opts.state)
    ) {
      return page;
    }
    return { ...page, items: [named, ...page.items.filter((item) => item.id !== named.id)] };
  },

  async getIssue(repo: RepoRef, number: number, _options?: FetchOptions): Promise<Issue | null> {
    const issue = await fetchIssue(`${repo.repo}-${number}`, await beginOp());
    return issue && issue.number === number ? issue : null;
  },

  async getIssueById(_repo: RepoRef, id: string, _options?: FetchOptions): Promise<Issue | null> {
    const trimmed = id.trim();
    const stable = STABLE_ISSUE_ID_PATTERN.exec(trimmed);
    if (stable) {
      const op = await beginOp();
      return stable[1] === siteHostOf(op.connection.siteUrl) ? fetchIssue(stable[2], op) : null;
    }
    const key = trimmed.toUpperCase();
    return ISSUE_KEY_PATTERN.test(key) ? fetchIssue(key, await beginOp()) : null;
  },

  async getIssueBranchKeys(repo: RepoRef): Promise<string[]> {
    return [repo.repo];
  },

  buildIssueUrl(repo: RepoRef, number: number): string {
    return `https://${repo.host}/browse/${repo.repo}-${number}`;
  },

  buildIssuesUrl(repo: RepoRef, options?: { query?: string; state?: string }): string {
    const state = options?.state === "closed" || options?.state === "all" ? options.state : "open";
    const filter = issueFilterJql(repo.repo, state);
    const text = options?.query ? textSearchClause(options.query) : null;
    const jql = text ? `${filter} AND ${text}` : filter;
    return `https://${repo.host}/issues/?jql=${encodeURIComponent(jql)}`;
  },

  async assignIssue(repo: RepoRef, issueNumber: number, username: string): Promise<ForgeUser[]> {
    const op = await beginOp();
    const viewer = await requireViewerFor(username, op);
    const issue = await requireIssueNode(repo, issueNumber, ["assignee"], op);
    const before = issue.fields?.assignee ?? null;
    const key = previousAssigneeKey(op, issue.id);
    if (before?.accountId === viewer.accountId) {
      rememberPreviousAssignee(key, viewer);
      return assigneesOf(issue);
    }
    await setAssignee(issue.id, viewer.accountId, op);
    rememberPreviousAssignee(
      key,
      before?.accountId ? { accountId: before.accountId, user: mapUser(before) } : null
    );
    return [viewer.user];
  },

  async unassignIssue(repo: RepoRef, issueNumber: number, username: string): Promise<ForgeUser[]> {
    const op = await beginOp();
    const viewer = await requireViewerFor(username, op);
    const issue = await requireIssueNode(repo, issueNumber, ["assignee"], op);
    const key = previousAssigneeKey(op, issue.id);
    const previous = previousAssignees.get(key) ?? null;
    // Only take the issue off the viewer, and only if "Assign to me" put it
    // there: if someone else picked it up since, or it was already the
    // viewer's, there is nothing of ours to undo.
    if (
      issue.fields?.assignee?.accountId !== viewer.accountId ||
      previous?.accountId === viewer.accountId
    ) {
      previousAssignees.delete(key);
      return assigneesOf(issue);
    }
    // Hand it back to whoever "Assign to me" took it from. A failure keeps the
    // record, so trying again still knows who that was.
    await setAssignee(issue.id, previous?.accountId ?? null, op);
    previousAssignees.delete(key);
    return previous ? [previous.user] : [];
  },
  createIssue: () => notSupported("Creating issues"),
  closeIssue: () => notSupported("Closing issues"),
  reopenIssue: () => notSupported("Reopening issues"),
  editIssue: () => notSupported("Editing issues"),
  addIssueComment: () => notSupported("Commenting on issues"),
  addIssueLabel: () => notSupported("Adding labels"),
  removeIssueLabel: () => notSupported("Removing labels"),

  identity: identityCapability,
  issueComments: issueCommentCapability,
  repoStats: repoStatsCapability,
};
