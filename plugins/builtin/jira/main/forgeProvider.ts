import type {
  AuthValidation,
  Credentials,
  FetchOptions,
  ForgeIssueProviderImpl,
  Issue,
  ListOptions,
  Page,
  RepoRef,
  RepoStatsCapability,
  RepoStatsSnapshot,
} from "../../../../shared/types/forge.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { normalizeEmail, normalizeSiteUrl } from "../shared/connection.js";
import {
  JiraApiError,
  getToken,
  getTokenVersion,
  jiraRequest,
  setMemoryToken,
  type JiraConnection,
} from "./JiraClient.js";
import { buildIssueJql, issueFilterJql, issueKeyInSearch, textSearchClause } from "./jql.js";
import { ISSUE_FIELDS, mapIssue, type JiraIssueNode } from "./mappers.js";

const DEFAULT_PAGE_SIZE = 50;
/** Jira caps a search that returns fields at 100 per page, whatever is asked for. */
const MAX_PAGE_SIZE = 100;

/** Jira project keys: letters and digits, starting with a letter. */
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,15}$/;
/** What Jira's issue endpoint is addressed by: its stable id or a full key. */
const ISSUE_ID_PATTERN = /^(?:\d+|[A-Z][A-Z0-9_]*-\d+)$/;

/**
 * The host polls stats every 30s while visible, against a rate limit shared with
 * everything else the account does, so a count is reused for a few minutes
 * unless the host asks for a fresh one.
 */
const STATS_CACHE_TTL_MS = 5 * 60_000;

const NOT_CONNECTED_MESSAGE = "Jira isn't connected. Add your site, email and API token in Settings → Code forge.";

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

async function beginOp(): Promise<Op> {
  const token = getToken();
  const version = getTokenVersion();
  const { siteUrl, email } = await readConnectionSettings();
  if (!token || !siteUrl || !email) {
    throw new JiraApiError(NOT_CONNECTED_MESSAGE, { credentialRejected: true });
  }
  return {
    connection: { siteUrl, email, token },
    scope: `${version}\u0000${siteUrl}\u0000${email}`,
  };
}

interface JiraProject {
  id: string;
  key: string;
}

const projectCache = new Map<string, JiraProject>();
const statsCache = new Map<string, { at: number; issueCount: number | null }>();

export function clearJiraCaches(): void {
  projectCache.clear();
  statsCache.clear();
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

async function fetchIssue(idOrKey: string, op: Op): Promise<Issue | null> {
  try {
    const node = await jiraRequest<JiraIssueNode>(
      op.connection,
      `/issue/${encodeURIComponent(idOrKey)}?fields=${ISSUE_FIELDS.join(",")}`
    );
    return mapIssue(node, op.connection.siteUrl);
  } catch (err) {
    // Jira answers an unknown issue and one the account can't see alike.
    if (err instanceof JiraApiError && err.status === 404) return null;
    throw err;
  }
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
    }>({ siteUrl, email, token }, "/myself");
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

  async resolveIssueRepo(projectPath: string): Promise<RepoRef | null> {
    const projectKey = normalizeProjectKey(await projectKeyReader?.(projectPath));
    if (!projectKey) return null;
    const op = await beginOp();
    const cacheKey = `${op.scope}\u0000${projectKey}`;
    let project = projectCache.get(cacheKey);
    if (!project) {
      try {
        project = await jiraRequest<JiraProject>(
          op.connection,
          `/project/${encodeURIComponent(projectKey)}`
        );
      } catch (err) {
        if (err instanceof JiraApiError && err.status === 404) {
          throw new Error(
            `Jira has no project ${projectKey} on this site, or this account can't see it. Check the project key in Project settings.`
          );
        }
        throw err;
      }
      projectCache.set(cacheKey, project);
    }
    const host = new URL(op.connection.siteUrl).hostname;
    return {
      host,
      owner: host.split(".")[0],
      repo: project.key,
      rawData: { projectId: project.id },
    };
  },

  async listIssues(repo: RepoRef, opts: ListOptions): Promise<Page<Issue>> {
    const jql = buildIssueJql(repo.repo, opts);
    if (jql === null) return { items: [], nextCursor: null, hasMore: false };
    const op = await beginOp();
    const namedKey =
      opts.search && !opts.cursor ? issueKeyInSearch(opts.search, repo.repo) : null;
    const [named, page] = await Promise.all([
      namedKey ? fetchIssue(namedKey, op) : null,
      searchIssues(jql, opts, op),
    ]);
    // A moved issue answers to its old key under its new one, and isn't this project's.
    if (!named || named.key !== namedKey || !matchesState(named, opts.state)) return page;
    return { ...page, items: [named, ...page.items.filter((item) => item.id !== named.id)] };
  },

  async getIssue(repo: RepoRef, number: number, _options?: FetchOptions): Promise<Issue | null> {
    const issue = await fetchIssue(`${repo.repo}-${number}`, await beginOp());
    return issue && issue.number === number ? issue : null;
  },

  async getIssueById(_repo: RepoRef, id: string, _options?: FetchOptions): Promise<Issue | null> {
    const idOrKey = id.trim().toUpperCase();
    if (!ISSUE_ID_PATTERN.test(idOrKey)) return null;
    return fetchIssue(idOrKey, await beginOp());
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

  assignIssue: () => notSupported("Assigning issues"),
  unassignIssue: () => notSupported("Unassigning issues"),
  createIssue: () => notSupported("Creating issues"),
  closeIssue: () => notSupported("Closing issues"),
  reopenIssue: () => notSupported("Reopening issues"),
  editIssue: () => notSupported("Editing issues"),
  addIssueComment: () => notSupported("Commenting on issues"),
  addIssueLabel: () => notSupported("Adding labels"),
  removeIssueLabel: () => notSupported("Removing labels"),

  repoStats: repoStatsCapability,
};
