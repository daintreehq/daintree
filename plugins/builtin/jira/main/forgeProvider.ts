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
import {
  deploymentOf,
  normalizeEmail,
  normalizeSiteUrl,
  siteHostOf,
  siteIdOf,
} from "../shared/connection.js";
import {
  getToken,
  getTokenVersion,
  recordProvenValidation,
  setMemoryToken,
  tokenMayGoTo,
} from "./JiraAuth.js";
import { JiraApiError, clearJiraCooldown, jiraRequest, type JiraConnection } from "./JiraClient.js";
import { buildIssueJql, issueFilterJql, issueKeyInSearch, textSearchClause } from "./jql.js";
import {
  ISSUE_FIELDS,
  issueNumberOf,
  mapComment,
  mapIssue,
  mapUser,
  userIdOf,
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
/** What `stableIssueId` hands out: `acme.atlassian.net/10042`, `example.com/jira/10042`. */
const STABLE_ISSUE_ID_PATTERN = /^(.+)\/(\d+)$/;

/** Personal access tokens, and so this provider's Server and Data Center support, start here. */
const MIN_DATA_CENTER_VERSION = [8, 14] as const;

/**
 * The host polls stats every 30s while visible, against a rate limit shared with
 * everything else the account does, so a count is reused for a few minutes
 * unless the host asks for a fresh one.
 */
const STATS_CACHE_TTL_MS = 5 * 60_000;

// Both keep "isn't connected. Add your … API token", which is how the host
// tells a tracker waiting for credentials from one that failed.
const NOT_CONNECTED_MESSAGE =
  "Jira isn't connected. Add your site and API token in Settings → Code forge.";
const OTHER_SITE_MESSAGE =
  "Jira isn't connected. Add your API token again in Settings → Code forge, since the saved one belongs to another site.";

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

function connectionFor(
  siteUrl: string,
  email: string | null,
  token: string
): JiraConnection | null {
  if (deploymentOf(siteUrl) === "dataCenter") return { deployment: "dataCenter", siteUrl, token };
  return email ? { deployment: "cloud", siteUrl, email, token } : null;
}

/**
 * The stored token's connection, or why there isn't one. The settings are read
 * first and the token after, with nothing awaited in between, so the token, its
 * version and where it may go are one snapshot. A token goes only to the site it
 * was proven against: the settings tab writes a new site before the token that
 * goes with it, and a poll landing in between must not send the old token there.
 */
async function storedConnection(): Promise<
  { connection: JiraConnection; scope: string } | { error: string }
> {
  const { siteUrl, email } = await readConnectionSettings();
  const token = getToken();
  const version = getTokenVersion();
  if (!token || !siteUrl) return { error: NOT_CONNECTED_MESSAGE };
  if (!tokenMayGoTo(siteUrl)) return { error: OTHER_SITE_MESSAGE };
  const connection = connectionFor(siteUrl, email, token);
  if (!connection) return { error: NOT_CONNECTED_MESSAGE };
  return { connection, scope: `${version}\u0000${siteUrl}\u0000${email ?? ""}` };
}

/** `null` until a token, and the site and email it may be used with, are all set. */
async function connectedOp(): Promise<Op | null> {
  const stored = await storedConnection();
  return "error" in stored ? null : stored;
}

async function beginOp(): Promise<Op> {
  const stored = await storedConnection();
  if ("error" in stored) throw new JiraApiError(stored.error);
  return stored;
}

const statsCache = new Map<string, { at: number; issueCount: number | null }>();
let statsCacheScope: string | null = null;

/** `id` is what Jira assigns the account by: see {@link userIdOf}. */
interface Viewer {
  id: string;
  user: ForgeUser;
}

/** The connection's own account, for the connection it was read under. */
let cachedViewer: { scope: string; viewer: Viewer } | null = null;

/** Who an issue was assigned to before "Assign to me": `null` when nobody was. */
type PreviousAssignee = { id: string; user: ForgeUser } | null;

/** What a run of assignments in a row found, and how many of their Undos are left. */
interface PreviousAssigneeRun {
  previous: PreviousAssignee;
  count: number;
}

/**
 * By connection and issue, what each "Assign to me" still open to Undo found,
 * latest last. Jira issues take one assignee, so the Undo has to put that person
 * back rather than leave the issue unassigned, and leave it alone when it was
 * already the viewer's. Two worktrees made from one issue each offer an Undo, so
 * the second assignment, which finds the issue already the viewer's, must not
 * take the first one's record. Assignments in a row that found the same assignee
 * share one run, so only a change of hands adds one. Undo is offered for
 * seconds, so only the latest few issues are kept.
 */
const previousAssignees = new Map<string, PreviousAssigneeRun[]>();
const PREVIOUS_ASSIGNEES_LIMIT = 50;
const PREVIOUS_ASSIGNEE_RUNS_PER_ISSUE = 10;

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
  const id = userIdOf(node);
  if (!id) throw new JiraApiError("Jira didn't recognize this account");
  const viewer = { id, user: mapUser(node) };
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
  if (username !== viewer.user.login.trim() && username !== viewer.id) {
    throw new Error("Jira issues can only be assigned to you from Daintree");
  }
  return viewer;
}

function previousAssigneeKey(op: Op, issueId: string): string {
  return `${op.scope}\u0000${issueId}`;
}

function rememberPreviousAssignee(key: string, previous: PreviousAssignee): void {
  const runs = previousAssignees.get(key) ?? [];
  const latest = runs.at(-1);
  if (latest && (latest.previous?.id ?? null) === (previous?.id ?? null)) {
    // The same account; its newest name and avatar are what an Undo hands back.
    latest.previous = previous;
    latest.count++;
  } else {
    runs.push({ previous, count: 1 });
    // Past the cap, the oldest after the first go: the first is who the issue
    // goes back to once every Undo has run.
    if (runs.length > PREVIOUS_ASSIGNEE_RUNS_PER_ISSUE) runs.splice(1, 1);
  }
  previousAssignees.delete(key);
  previousAssignees.set(key, runs);
  if (previousAssignees.size > PREVIOUS_ASSIGNEES_LIMIT) {
    const oldest = previousAssignees.keys().next().value;
    if (oldest !== undefined) previousAssignees.delete(oldest);
  }
}

/** What the latest assignment still open to Undo found; `undefined` when none is. */
function latestPreviousAssignee(key: string): PreviousAssignee | undefined {
  return previousAssignees.get(key)?.at(-1)?.previous;
}

/** One Undo is used up. Assignments and Undos for an issue run in turn, so it's the latest. */
function forgetLatestPreviousAssignee(key: string): void {
  const runs = previousAssignees.get(key);
  const latest = runs?.at(-1);
  if (!runs || !latest) return;
  if (--latest.count > 0) return;
  runs.pop();
  if (runs.length === 0) previousAssignees.delete(key);
}

const assignmentQueues = new Map<string, Promise<void>>();

/**
 * Runs an assign or Undo for one issue after any still under way for it, so
 * each reads the assignee, writes and keeps its record without another landing
 * in between and leaving the records out of order.
 */
function queueAssignment<T>(
  op: Op,
  repo: RepoRef,
  issueNumber: number,
  run: () => Promise<T>
): Promise<T> {
  const key = `${op.scope}\u0000${repo.repo}-${issueNumber}`;
  const result = (assignmentQueues.get(key) ?? Promise.resolve()).then(run);
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  assignmentQueues.set(key, settled);
  void settled.then(() => {
    if (assignmentQueues.get(key) === settled) assignmentQueues.delete(key);
  });
  return result;
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

/** `null` unassigns. Cloud assigns by account id, Server and Data Center by username. */
async function setAssignee(issueId: string, userId: string | null, op: Op): Promise<void> {
  await jiraRequest<void>(op.connection, `/issue/${encodeURIComponent(issueId)}/assignee`, {
    method: "PUT",
    body: op.connection.deployment === "cloud" ? { accountId: userId } : { name: userId },
    noContent: true,
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

/** What Jira's offset-paged lists (Server and Data Center search, comments) answer with. */
interface JiraOffsetPage {
  startAt?: number;
  maxResults?: number;
  total?: number;
}

/** An offset cursor is the position of the page's first item, as this hands it out. */
function offsetOf(cursor: string | null | undefined, list: string): number {
  if (!cursor) return 0;
  const offset = /^\d+$/.test(cursor) ? Number(cursor) : NaN;
  if (!Number.isSafeInteger(offset)) throw new Error(`Invalid Jira ${list} cursor`);
  return offset;
}

/**
 * Where an offset-paged list goes next. Jira may serve fewer than were asked
 * for, and says how many it meant to. An empty page, or one that doesn't move
 * forward, ends the list whatever the total says, or a total that drifted up
 * would hand out the same cursor forever.
 */
function nextOffset(
  startAt: number,
  count: number,
  data: JiraOffsetPage,
  requested: number
): { nextCursor: string | null; total: number | null } {
  const next = (typeof data.startAt === "number" ? data.startAt : startAt) + count;
  const total = typeof data.total === "number" ? data.total : null;
  const pageSize =
    typeof data.maxResults === "number" && data.maxResults > 0 ? data.maxResults : requested;
  const hasMore =
    count > 0 && next > startAt && (total === null ? count >= pageSize : next < total);
  return { nextCursor: hasMore ? String(next) : null, total };
}

function searchPageSize(perPage: number | undefined): number {
  return Math.min(Math.max(perPage ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

/**
 * Server and Data Center keep the offset-paged `POST /search`, with a `total`;
 * Cloud retired it for `/search/jql`.
 */
async function searchIssuesByOffset(jql: string, opts: ListOptions, op: Op): Promise<Page<Issue>> {
  const startAt = offsetOf(opts.cursor, "issues");
  const maxResults = searchPageSize(opts.perPage);
  const data = await jiraRequest<JiraOffsetPage & { issues?: JiraIssueNode[] }>(
    op.connection,
    "/search",
    { method: "POST", body: { jql, startAt, maxResults, fields: ISSUE_FIELDS } }
  );
  const issues = data.issues ?? [];
  // No total for the host: a search naming a key adds that issue to the page,
  // and Cloud's search has none either.
  const { nextCursor } = nextOffset(startAt, issues.length, data, maxResults);
  return {
    items: issues.map((node) => mapIssue(node, op.connection.siteUrl)),
    nextCursor,
    hasMore: nextCursor !== null,
  };
}

/**
 * `POST /search/jql`, the replacement for the retired `/search`. It has no
 * `total` and no offsets: its `nextPageToken` is the only way forward, and it
 * only works with the JQL that produced it. That holds here, because the host
 * sends a cursor back with the same options.
 */
async function searchIssues(jql: string, opts: ListOptions, op: Op): Promise<Page<Issue>> {
  if (op.connection.deployment === "dataCenter") return searchIssuesByOffset(jql, opts, op);
  const maxResults = searchPageSize(opts.perPage);
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

/**
 * The site a reference was resolved against, which keeps a Data Center
 * instance's port and context path. Only links are built from it.
 */
function siteUrlOf(repo: RepoRef): string {
  const raw = (repo.rawData as { siteUrl?: unknown } | null | undefined)?.siteUrl;
  return normalizeSiteUrl(raw) ?? `https://${repo.host}`;
}

function matchesState(issue: Issue, state: ListOptions["state"]): boolean {
  if (state === "all") return true;
  return issue.state === (state === "closed" ? "closed" : "open");
}

interface JiraServerInfo {
  version?: unknown;
  versionNumbers?: unknown;
  deploymentType?: unknown;
}

function versionParts(parts: unknown): number[] | null {
  if (!Array.isArray(parts) || parts.length < 2) return null;
  return parts.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
    ? (parts as number[])
    : null;
}

/** `[8, 14, 0]` from `serverInfo`, or `null` when it doesn't say. */
function serverVersionOf(info: JiraServerInfo): number[] | null {
  return (
    versionParts(info.versionNumbers) ??
    (typeof info.version === "string" && /^\d+(?:\.\d+)+$/.test(info.version)
      ? versionParts(info.version.split(".").map(Number))
      : null)
  );
}

function isOlderThan(version: number[], floor: readonly number[]): boolean {
  for (let i = 0; i < floor.length; i++) {
    const part = version[i] ?? 0;
    if (part !== floor[i]) return part < floor[i];
  }
  return false;
}

const SERVER_DEPLOYMENTS: readonly unknown[] = ["Server", "DataCenter"];

/**
 * What the site is, asked before it's trusted with the token. `serverInfo` is
 * open to anyone, and Jira Cloud always answers it, so a custom domain in front
 * of Cloud says `Cloud` here without the token ever reaching it. A Server or
 * Data Center instance says which and what version; one too old for personal
 * access tokens is named rather than left to read as a rejected token. An
 * instance that keeps even `serverInfo` from anonymous callers isn't Cloud's
 * open answer, so it's asked again with the token, which `/myself` would carry
 * there next anyway.
 */
async function checkDataCenter(connection: JiraConnection): Promise<string | null> {
  let info: JiraServerInfo;
  try {
    info = await jiraRequest<JiraServerInfo>(connection, "/serverInfo", {
      ignoreCooldown: true,
      anonymous: true,
      metadata: true,
    });
  } catch (err) {
    if (!(err instanceof JiraApiError) || (err.status !== 401 && err.status !== 403)) throw err;
    info = await jiraRequest<JiraServerInfo>(connection, "/serverInfo", {
      ignoreCooldown: true,
      metadata: true,
    });
  }
  if (info.deploymentType === "Cloud") {
    return "That address is a Jira Cloud site. Choose Jira Cloud and use its atlassian.net address.";
  }
  if (!SERVER_DEPLOYMENTS.includes(info.deploymentType)) {
    return "That address didn't answer as Jira Server or Data Center. Check the site URL.";
  }
  const version = serverVersionOf(info);
  if (!version) {
    return "Jira didn't say which version it is. Daintree needs Jira 8.14 or later.";
  }
  if (isOlderThan(version, MIN_DATA_CENTER_VERSION)) {
    return `Jira ${version.join(".")} doesn't have personal access tokens. Daintree needs Jira 8.14 or later.`;
  }
  return null;
}

/**
 * Check a token against a connection. Only a `candidate`, a token the person
 * just entered for these settings, is recorded as proven there, which is what
 * lets the save that follows bind it to this site.
 */
async function validateConnection(
  connection: JiraConnection,
  candidate: boolean
): Promise<AuthValidation> {
  try {
    if (connection.deployment === "dataCenter") {
      const refusal = await checkDataCenter(connection);
      if (refusal) return { valid: false, error: refusal };
    }
    const me = await jiraRequest<JiraUserNode>(connection, "/myself", { ignoreCooldown: true });
    // Each deployment's own kind of id: a Cloud-shaped account behind a Data
    // Center address couldn't be assigned anything there.
    const id = connection.deployment === "cloud" ? me.accountId : me.name;
    if (!id) return { valid: false, error: "Jira didn't recognize this account" };
    if (candidate) recordProvenValidation(connection.token, connection.siteUrl);
    return { valid: true, account: me.displayName || me.emailAddress || id };
  } catch (err) {
    return { valid: false, error: formatErrorMessage(err, "Couldn't validate the Jira API token") };
  }
}

/** A token the person just entered, checked against the site and email in the settings. */
async function validateCandidate(token: string): Promise<AuthValidation> {
  try {
    const { siteUrl, email } = await readConnectionSettings();
    if (!siteUrl) {
      return {
        valid: false,
        error:
          "Add your Jira site URL: an atlassian.net address for Cloud, or your Server or Data Center address",
      };
    }
    const connection = connectionFor(siteUrl, email, token);
    if (!connection) return { valid: false, error: "Add your Atlassian account email" };
    return await validateConnection(connection, true);
  } catch (err) {
    return { valid: false, error: formatErrorMessage(err, "Couldn't validate the Jira API token") };
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
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
    const jql = issueFilterJql(repo.repo, "open");
    // Server and Data Center count with an empty page of the offset search.
    const issueCount =
      op.connection.deployment === "cloud"
        ? numberOrNull(
            (
              await jiraRequest<{ count?: unknown }>(op.connection, "/search/approximate-count", {
                method: "POST",
                body: { jql },
              })
            ).count
          )
        : numberOrNull(
            (
              await jiraRequest<{ total?: unknown }>(op.connection, "/search", {
                method: "POST",
                body: { jql, maxResults: 0 },
              })
            ).total
          );
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

interface JiraCommentsResponse extends JiraOffsetPage {
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
    const startAt = offsetOf(opts.cursor, "comments");
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
    const { nextCursor, total } = nextOffset(startAt, comments.length, data, maxResults);
    return {
      items: comments.map((node) => mapComment(node, op.connection.siteUrl, issue.key)),
      nextCursor,
      hasMore: nextCursor !== null,
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

  /** The stored token, checked only where it may go: never proof for a new binding. */
  async validateCredentials(): Promise<AuthValidation> {
    if (!getToken()) return { valid: false, error: "No Jira API token configured" };
    try {
      const stored = await storedConnection();
      if ("error" in stored) return { valid: false, error: stored.error };
      return await validateConnection(stored.connection, false);
    } catch (err) {
      return {
        valid: false,
        error: formatErrorMessage(err, "Couldn't validate the Jira API token"),
      };
    }
  },

  /**
   * The host hands over the token alone, so the site and email it's checked with
   * are the plugin's own settings. The settings tab writes those first, and a
   * token that checks out here is bound to that site when the host saves it.
   */
  async validateToken(token: string): Promise<AuthValidation> {
    if (!token || !token.trim()) return { valid: false, error: "API token is required" };
    return validateCandidate(token.trim());
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
    // The base rides along for the URL builders: a Data Center instance's
    // context path isn't in its host.
    return { host, owner: host.split(".")[0], repo: projectKey, rawData: { siteUrl } };
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
      return stable[1] === siteIdOf(op.connection.siteUrl) ? fetchIssue(stable[2], op) : null;
    }
    const key = trimmed.toUpperCase();
    return ISSUE_KEY_PATTERN.test(key) ? fetchIssue(key, await beginOp()) : null;
  },

  async getIssueBranchKeys(repo: RepoRef): Promise<string[]> {
    return [repo.repo];
  },

  buildIssueUrl(repo: RepoRef, number: number): string {
    return `${siteUrlOf(repo)}/browse/${repo.repo}-${number}`;
  },

  buildIssuesUrl(repo: RepoRef, options?: { query?: string; state?: string }): string {
    const state = options?.state === "closed" || options?.state === "all" ? options.state : "open";
    const filter = issueFilterJql(repo.repo, state);
    const text = options?.query ? textSearchClause(options.query) : null;
    const jql = text ? `${filter} AND ${text}` : filter;
    return `${siteUrlOf(repo)}/issues/?jql=${encodeURIComponent(jql)}`;
  },

  async assignIssue(repo: RepoRef, issueNumber: number, username: string): Promise<ForgeUser[]> {
    const op = await beginOp();
    const viewer = await requireViewerFor(username, op);
    return queueAssignment(op, repo, issueNumber, async () => {
      const issue = await requireIssueNode(repo, issueNumber, ["assignee"], op);
      const before = issue.fields?.assignee ?? null;
      const key = previousAssigneeKey(op, issue.id);
      const beforeId = userIdOf(before);
      if (beforeId === viewer.id) {
        rememberPreviousAssignee(key, viewer);
        return assigneesOf(issue);
      }
      await setAssignee(issue.id, viewer.id, op);
      rememberPreviousAssignee(
        key,
        before && beforeId ? { id: beforeId, user: mapUser(before) } : null
      );
      return [viewer.user];
    });
  },

  async unassignIssue(repo: RepoRef, issueNumber: number, username: string): Promise<ForgeUser[]> {
    const op = await beginOp();
    const viewer = await requireViewerFor(username, op);
    return queueAssignment(op, repo, issueNumber, async () => {
      const issue = await requireIssueNode(repo, issueNumber, ["assignee"], op);
      const key = previousAssigneeKey(op, issue.id);
      // `undefined` when nothing is remembered.
      const previous = latestPreviousAssignee(key);
      // Someone else has picked the issue up since: this Undo has nothing of
      // ours left to undo, and its record goes with it.
      if (userIdOf(issue.fields?.assignee) !== viewer.id) {
        forgetLatestPreviousAssignee(key);
        return assigneesOf(issue);
      }
      // With nothing remembered this only takes the issue off the viewer, which
      // is what an agent's unassign asks for.
      if (previous === undefined) {
        await setAssignee(issue.id, null, op);
        return [];
      }
      // That assignment found the issue already the viewer's.
      if (previous?.id === viewer.id) {
        forgetLatestPreviousAssignee(key);
        return assigneesOf(issue);
      }
      // Hand it back to whoever "Assign to me" took it from. A failure keeps
      // the record, so trying again still knows who that was.
      await setAssignee(issue.id, previous?.id ?? null, op);
      forgetLatestPreviousAssignee(key);
      return previous ? [previous.user] : [];
    });
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
