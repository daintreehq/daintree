import type {
  AuthValidation,
  CreateIssueInput,
  Credentials,
  EditIssueInput,
  FetchOptions,
  ForgeIssueProviderImpl,
  ForgeLabel,
  ForgeUser,
  IdentityCapability,
  Issue,
  IssueCloseReason,
  IssueComment,
  ListOptions,
  Page,
  RepoRef,
  RepoStatsCapability,
  RepoStatsSnapshot,
} from "../../../../shared/types/forge.js";
import { clearActorCache, resolveActor } from "./actor.js";
import {
  BeadsApiError,
  beadsRequest,
  getToken,
  getTokenVersion,
  setMemoryToken,
  type QueryValue,
} from "./BeadsClient.js";
import { IssueNumberIndex, beadNumber } from "./issueNumbers.js";
import { mapActor, mapBead, mapComment, type BeadComment, type BeadNode } from "./mappers.js";
import { isLoopbackUrl, resolveServerUrl } from "./serverTarget.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
/** Paging for a number lookup that missed: every bead, every status. */
const LOOKUP_PAGE_SIZE = 200;
const LOOKUP_PAGE_LIMIT = 50;
/** The toolbar's open count pages the picker's own set; past this it reads as unknown. */
const COUNT_PAGE_SIZE = 200;
const COUNT_PAGE_LIMIT = 5;
const STATS_CACHE_TTL_MS = 5 * 60_000;
const PREVIOUS_ASSIGNEES_LIMIT = 50;
const ID_FORBIDDEN = new Set(["/", "\\", "?", "#", "%"]);

function hasControlOrSpace(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || /\s/.test(char)) return true;
  }
  return false;
}

/** Bead ids are short; anything outside this isn't one, and never reaches a URL path. */
function isBeadId(id: string): boolean {
  if (id.length === 0 || id.length > 255 || hasControlOrSpace(id)) return false;
  for (const char of id) if (ID_FORBIDDEN.has(char)) return false;
  return true;
}

interface IssuesPage {
  items: BeadNode[];
  has_more: boolean;
  next_cursor?: string;
}

interface ContextResponse {
  database?: string;
  project_id?: string;
}

let serverUrlSettingReader: ((projectPath: string) => Promise<string | undefined>) | null = null;

/** Wired by `activate()`: reads the project's `serverUrl` setting for one project path. */
export function setServerUrlSettingReader(
  reader: ((projectPath: string) => Promise<string | undefined>) | null
): void {
  serverUrlSettingReader = reader;
}

/**
 * One operation's token, captured once, so a token swapped mid-way can't have
 * its later requests answered under another credential, and `version` lets the
 * operation drop what it learned rather than cache it under the new token.
 */
interface Op {
  token: string | null;
  version: number;
  generation: number;
  server: string | null;
  serverGeneration: number;
}

/** Bumps when the caches are reset, so work started before can't refill them. */
let generation = 0;
/** Per server: bumps when one is forgotten, leaving work on other servers alone. */
const serverGenerations = new Map<string, number>();

function serverGeneration(server: string): number {
  return serverGenerations.get(server) ?? 0;
}

function beginOp(repo?: RepoRef): Op {
  const server = repo ? serverOf(repo) : null;
  return {
    token: getToken(),
    version: getTokenVersion(),
    generation,
    server,
    serverGeneration: server ? serverGeneration(server) : 0,
  };
}

function isCurrent(op: Op): boolean {
  return (
    op.version === getTokenVersion() &&
    op.generation === generation &&
    (op.server === null || serverGeneration(op.server) === op.serverGeneration)
  );
}

const numbers = new IssueNumberIndex();
const contextCache = new Map<string, ContextResponse>();
const statsCache = new Map<string, { version: number; at: number; issueCount: number | null }>();
/** Who a bead was assigned to before "Assign to me", per server and bead, so Undo can put them back. */
const previousAssignees = new Map<string, string | null>();
/**
 * Servers the token may be sent to: one a project setting named, or a loopback
 * address. An address read from a repository's `.beads/` alone is not one,
 * since a cloned repo can name any server.
 */
const trustedServers = new Set<string>();
/** The workspace each server answered for, stamped on requests so a swapped server refuses them. */
const serverProjects = new Map<string, string>();

export function clearBeadsCaches(): void {
  generation++;
  numbers.clear();
  contextCache.clear();
  statsCache.clear();
  previousAssignees.clear();
  trustedServers.clear();
  serverProjects.clear();
  clearActorCache();
}

function forgetServer(server: string): void {
  // Work in flight learned from the old workspace; none of it may land.
  serverGenerations.set(server, serverGeneration(server) + 1);
  numbers.forget(server);
  serverProjects.delete(server);
  for (const key of [...contextCache.keys()]) {
    if (key.endsWith(`\u0000${server}`)) contextCache.delete(key);
  }
  for (const key of [...statsCache.keys()]) {
    if (key.startsWith(`${server}\u0000`)) statsCache.delete(key);
  }
  for (const key of [...previousAssignees.keys()]) {
    if (key.startsWith(`${server}\u0000`)) previousAssignees.delete(key);
  }
}

function tokenFor(server: string, op: Op): string | null {
  return trustedServers.has(server) ? op.token : null;
}

const WITHHELD_TOKEN_HINT =
  "This Beads server's address came from the project's .beads/http_target.json, so the saved token isn't sent to it. Enter the address as the Beads server URL in Project settings to use the token.";

/**
 * The workspace a ref was resolved against. Pinned to the ref rather than read
 * from the shared map, so an operation already under way keeps refusing the
 * old workspace's beads at an address that now serves another one.
 */
function projectIdOf(repo: RepoRef): string | undefined {
  const pinned = (repo.rawData as { projectId?: unknown } | null)?.projectId;
  if (typeof pinned === "string" && pinned) return pinned;
  return serverProjects.get(serverOf(repo));
}

/** The server a ref addresses. `owner` carries it, since `rawData` is opaque to the host. */
function serverOf(repo: RepoRef): string {
  return repo.owner;
}

async function request<T>(
  repo: RepoRef,
  op: Op,
  req: Omit<Parameters<typeof beadsRequest>[1], "token">
): Promise<T> {
  const server = serverOf(repo);
  const token = tokenFor(server, op);
  try {
    return await beadsRequest<T>(server, {
      ...req,
      token,
      projectId: projectIdOf(repo),
      ...(op.token && !token ? { withheldTokenHint: WITHHELD_TOKEN_HINT } : {}),
    });
  } catch (err) {
    if (err instanceof BeadsApiError && err.reason === "project_mismatch") {
      // Something else answers at this address now; nothing learned from the
      // old workspace may address the new one's beads.
      forgetServer(server);
      throw new BeadsApiError(
        `The Beads server at ${server} now serves a different workspace. Try again.`,
        { status: err.status, code: err.code, reason: err.reason }
      );
    }
    throw err;
  }
}

function beadPath(id: string, suffix = ""): string {
  if (!isBeadId(id)) throw new Error(`"${id}" isn't a bead id`);
  return `/v0/beads/issues/${encodeURIComponent(id)}${suffix}`;
}

function remember(repo: RepoRef, node: BeadNode, op: Op): Issue {
  const issue = mapBead(node);
  if (isCurrent(op)) numbers.remember(serverOf(repo), node.id, issue.number);
  return issue;
}

/**
 * The query for the picker's states. Open is `bd list`'s own default set,
 * which leaves out closed and the workspace's custom done and frozen statuses.
 */
function stateQuery(state: ListOptions["state"]): Record<string, QueryValue> {
  if (state === "closed") return { status: "closed" };
  if (state === "all") return { all: true };
  // "merged" means nothing for an issue; it reads as the open set (ListOptions).
  return {};
}

/**
 * `bd serve` lists newest first by creation, or by priority, and its cursors
 * are positions in one order, so any other order is refused by name rather
 * than answered with a page in some other order (#15604).
 */
function checkOrder(opts: ListOptions): void {
  const direction = opts.direction ?? "desc";
  if (direction !== "desc") {
    throw new Error(
      `Beads lists issues newest first only, so direction "${direction}" can't be served. Omit direction or pass "desc".`
    );
  }
  const sort = opts.sort ?? "created";
  if (sort !== "created") {
    throw new Error(`Beads can't sort issues by "${sort}". Pass sort "created".`);
  }
}

async function getBead(repo: RepoRef, id: string, op: Op): Promise<Issue | null> {
  try {
    return remember(repo, await request<BeadNode>(repo, op, { path: beadPath(id) }), op);
  } catch (err) {
    if (err instanceof BeadsApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * The bead behind a number. Numbers are learned from every bead this provider
 * maps, by list or by id; one it hasn't seen is looked for by listing, the
 * picker's open set first and then every status, within a fixed budget.
 */
async function resolveBeadId(repo: RepoRef, number: number, op: Op): Promise<string | null> {
  const server = serverOf(repo);
  const known = numbers.lookup(server, number);
  if (known) return known;
  let pages = 0;
  for (const query of [{}, { all: true }]) {
    let cursor: string | undefined;
    for (;;) {
      if (pages === LOOKUP_PAGE_LIMIT) {
        throw new Error(
          `Couldn't find Beads issue #${number} within the first ${LOOKUP_PAGE_LIMIT * LOOKUP_PAGE_SIZE} beads. Open it by its id instead.`
        );
      }
      pages++;
      const data = await request<IssuesPage>(repo, op, {
        path: "/v0/beads/issues",
        query: { ...query, limit: LOOKUP_PAGE_SIZE, cursor },
      });
      if (!isCurrent(op)) {
        throw new Error(`The Beads connection changed while looking up #${number}. Try again.`);
      }
      for (const item of data.items) numbers.remember(server, item.id, beadNumber(item.id));
      const found = numbers.lookup(server, number);
      if (found) return found;
      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }
  }
  return null;
}

async function requireBeadId(repo: RepoRef, number: number, op: Op): Promise<string> {
  const id = await resolveBeadId(repo, number, op);
  if (!id) throw new Error(`Beads issue #${number} wasn't found`);
  return id;
}

async function requireBead(repo: RepoRef, number: number, op: Op): Promise<Issue & { id: string }> {
  const id = await requireBeadId(repo, number, op);
  const issue = await getBead(repo, id, op);
  if (!issue) throw new Error(`Beads issue ${id} wasn't found`);
  return issue as Issue & { id: string };
}

async function patchBead(
  repo: RepoRef,
  id: string,
  op: Op,
  patch: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Promise<Issue> {
  const actor = await resolveActor();
  const data = await request<{ issue: BeadNode }>(repo, op, {
    method: "PATCH",
    path: beadPath(id),
    body: { actor, patch, ...extra },
  });
  return remember(repo, data.issue, op);
}

function undoKey(repo: RepoRef, id: string): string {
  return `${serverOf(repo)}\u0000${id}`;
}

function rememberPreviousAssignee(op: Op, key: string, assignee: string | null): void {
  if (!isCurrent(op)) return;
  previousAssignees.delete(key);
  previousAssignees.set(key, assignee);
  if (previousAssignees.size > PREVIOUS_ASSIGNEES_LIMIT) {
    const oldest = previousAssignees.keys().next().value;
    if (oldest !== undefined) previousAssignees.delete(oldest);
  }
}

function assigneeOf(issue: Issue): string | null {
  return issue.assignees[0]?.login ?? null;
}

const CLOSE_REASONS: Record<IssueCloseReason, string> = {
  completed: "Completed",
  not_planned: "Not planned",
  duplicate: "Duplicate",
};

async function countOpenBeads(repo: RepoRef, op: Op): Promise<number | null> {
  let count = 0;
  let cursor: string | undefined;
  for (let page = 0; page < COUNT_PAGE_LIMIT; page++) {
    const data = await request<IssuesPage>(repo, op, {
      path: "/v0/beads/issues",
      query: { limit: COUNT_PAGE_SIZE, cursor },
    });
    count += data.items.length;
    if (isCurrent(op)) {
      for (const item of data.items) numbers.remember(serverOf(repo), item.id, beadNumber(item.id));
    }
    if (!data.has_more || !data.next_cursor) return count;
    cursor = data.next_cursor;
  }
  return null;
}

/**
 * `issues:count` counts a different set from the listing (closed, templates
 * and gates included), so the toolbar's open count pages the listing the
 * picker shows instead, a few pages at most and reused for a few minutes.
 */
const repoStatsCapability: RepoStatsCapability = {
  async getRepoStats(repo: RepoRef, opts?: { bypassCache?: boolean }): Promise<RepoStatsSnapshot> {
    const key = `${serverOf(repo)}\u0000${repo.repo}`;
    const op = beginOp(repo);
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
    const issueCount = await countOpenBeads(repo, op);
    if (isCurrent(op)) statsCache.set(key, { version: op.version, at: now, issueCount });
    return {
      counts: { issueCount, prCount: null, lastUpdated: now, issueCountRefreshedAt: now },
      source: "network",
    };
  },
};

/** "Me" is the actor `bd` itself would record on this machine; see {@link resolveActor}. */
const identityCapability: IdentityCapability = {
  async getCurrentUser(): Promise<ForgeUser | null> {
    return mapActor(await resolveActor());
  },
};

export const beadsForgeProvider: ForgeIssueProviderImpl = {
  async getCredentials(): Promise<Credentials | null> {
    const token = getToken();
    return token ? { kind: "bearer", value: token } : null;
  },

  setCredentials(credentials: Credentials | null): void {
    const before = getTokenVersion();
    setMemoryToken(credentials?.value ?? null);
    if (getTokenVersion() !== before) {
      contextCache.clear();
      statsCache.clear();
      previousAssignees.clear();
      serverProjects.clear();
    }
  },

  async validateCredentials(): Promise<AuthValidation> {
    if (!getToken()) {
      return {
        valid: false,
        error: "No Beads token saved. A server started without --auth-token-file needs none.",
      };
    }
    return { valid: true };
  },

  /**
   * The token is one per provider while each project names its own server,
   * so there is no one server to try it against here; a server that refuses
   * it says so by name on the project's first request.
   */
  async validateToken(token: string): Promise<AuthValidation> {
    const trimmed = token?.trim() ?? "";
    if (!trimmed) return { valid: false, error: "Token is required" };
    if (hasControlOrSpace(trimmed)) {
      return { valid: false, error: "A Beads token can't contain spaces or control characters" };
    }
    return { valid: true };
  },

  async resolveIssueRepo(projectPath: string): Promise<RepoRef | null> {
    const op = beginOp();
    const target = await resolveServerUrl(projectPath, await serverUrlSettingReader?.(projectPath));
    if (!target) return null;
    const serverUrl = target.url;
    if (target.source === "setting" || isLoopbackUrl(serverUrl)) trustedServers.add(serverUrl);
    const cacheKey = `${op.version}\u0000${serverUrl}`;
    let context = contextCache.get(cacheKey);
    if (!context) {
      const token = tokenFor(serverUrl, op);
      const serverGen = serverGeneration(serverUrl);
      context = await beadsRequest<ContextResponse>(serverUrl, {
        path: "/v0/beads/context",
        token,
        ...(op.token && !token ? { withheldTokenHint: WITHHELD_TOKEN_HINT } : {}),
      });
      if (isCurrent(op) && serverGeneration(serverUrl) === serverGen) {
        contextCache.set(cacheKey, context);
        if (context.project_id) serverProjects.set(serverUrl, context.project_id);
        else serverProjects.delete(serverUrl);
      }
    }
    const url = new URL(serverUrl);
    return {
      host: url.host,
      owner: serverUrl,
      repo: context.database || context.project_id || url.host,
      rawData: { serverUrl, projectId: context.project_id ?? null },
    };
  },

  async listIssues(repo: RepoRef, opts: ListOptions): Promise<Page<Issue>> {
    checkOrder(opts);
    const op = beginOp(repo);
    const limit = Math.min(Math.max(opts.perPage ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const search = opts.search?.trim();
    const data = await request<IssuesPage>(repo, op, {
      path: "/v0/beads/issues",
      query: {
        ...stateQuery(opts.state),
        ...(opts.assignee ? { assignee: opts.assignee } : {}),
        ...(opts.labels?.length ? { label: opts.labels } : {}),
        ...(search ? { q: search } : {}),
        limit,
        cursor: opts.cursor ?? undefined,
      },
    });
    return {
      items: data.items.map((node) => remember(repo, node, op)),
      nextCursor: data.has_more ? (data.next_cursor ?? null) : null,
      hasMore: data.has_more && Boolean(data.next_cursor),
    };
  },

  async getIssue(repo: RepoRef, number: number, _options?: FetchOptions): Promise<Issue | null> {
    const op = beginOp(repo);
    const id = await resolveBeadId(repo, number, op);
    return id ? getBead(repo, id, op) : null;
  },

  async getIssueById(repo: RepoRef, id: string, _options?: FetchOptions): Promise<Issue | null> {
    if (!isBeadId(id)) return null;
    return getBead(repo, id, beginOp(repo));
  },

  buildIssueUrl(): string {
    return "";
  },

  buildIssuesUrl(): string {
    return "";
  },

  async createIssue(repo: RepoRef, input: CreateIssueInput): Promise<Issue> {
    const op = beginOp(repo);
    const actor = await resolveActor();
    const node = await request<BeadNode>(repo, op, {
      method: "POST",
      path: "/v0/beads/issues",
      body: {
        actor,
        title: input.title,
        ...(input.body ? { description: input.body } : {}),
        ...(input.labels?.length ? { labels: input.labels } : {}),
        // Optional in the schema, but workspaces refuse a create without a type.
        issue_type: "task",
        priority: 2,
      },
    });
    return remember(repo, node, op);
  },

  /**
   * A bead has one assignee. A live claim by someone else is left to the
   * server to refuse, never forced: taking work an agent holds is `bd`'s
   * call, not a click's. The write is fenced on the revision it was read at,
   * so the assignee Undo restores is the one the write actually replaced.
   */
  async assignIssue(repo: RepoRef, issueNumber: number, username: string): Promise<ForgeUser[]> {
    const op = beginOp(repo);
    for (let attempt = 0; ; attempt++) {
      const issue = await requireBead(repo, issueNumber, op);
      const key = undoKey(repo, issue.id);
      const before = assigneeOf(issue);
      if (before === username) {
        // Already theirs: Undo then has nothing to hand back, unless an
        // earlier assignment's record is still waiting for its Undo.
        if (!previousAssignees.has(key)) rememberPreviousAssignee(op, key, before);
        return issue.assignees;
      }
      const revision = (issue.rawData as { revision?: unknown }).revision;
      try {
        const updated = await patchBead(
          repo,
          issue.id,
          op,
          { assignee: username },
          typeof revision === "string" ? { expected_version: revision } : {}
        );
        rememberPreviousAssignee(op, key, before);
        return updated.assignees;
      } catch (err) {
        if (attempt === 0 && err instanceof BeadsApiError && err.code === "precondition_failed") {
          continue;
        }
        throw err;
      }
    }
  },

  async unassignIssue(repo: RepoRef, issueNumber: number, username: string): Promise<ForgeUser[]> {
    const op = beginOp(repo);
    const current = await requireBead(repo, issueNumber, op);
    const key = undoKey(repo, current.id);
    const previous = previousAssignees.has(key) ? (previousAssignees.get(key) ?? null) : null;
    // Only take the bead off this user, and hand it back to whoever "Assign to
    // me" took it from; if it was already theirs there is nothing to undo.
    if (assigneeOf(current) !== username || previous === username) {
      previousAssignees.delete(key);
      return current.assignees;
    }
    try {
      const updated = await patchBead(
        repo,
        current.id,
        op,
        { assignee: previous ?? "" },
        { expected_assignee: username }
      );
      previousAssignees.delete(key);
      return updated.assignees;
    } catch (err) {
      // Someone else took it between the read and the write: theirs now.
      if (err instanceof BeadsApiError && err.code === "precondition_failed") {
        previousAssignees.delete(key);
        return (await getBead(repo, current.id, op))?.assignees ?? [];
      }
      // Kept on any other failure, so a retried Undo still knows whom to restore.
      throw err;
    }
  },

  async closeIssue(
    repo: RepoRef,
    issueNumber: number,
    stateReason?: IssueCloseReason
  ): Promise<Issue> {
    const op = beginOp(repo);
    const id = await requireBeadId(repo, issueNumber, op);
    const actor = await resolveActor();
    const data = await request<{ issue: BeadNode }>(repo, op, {
      method: "POST",
      path: beadPath(id, ":close"),
      body: { actor, ...(stateReason ? { reason: CLOSE_REASONS[stateReason] } : {}) },
    });
    return remember(repo, data.issue, op);
  },

  async reopenIssue(repo: RepoRef, issueNumber: number): Promise<Issue> {
    const op = beginOp(repo);
    const id = await requireBeadId(repo, issueNumber, op);
    const actor = await resolveActor();
    const data = await request<{ issue: BeadNode }>(repo, op, {
      method: "POST",
      path: beadPath(id, ":reopen"),
      body: { actor },
    });
    return remember(repo, data.issue, op);
  },

  async editIssue(repo: RepoRef, issueNumber: number, input: EditIssueInput): Promise<Issue> {
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.body !== undefined) patch.description = input.body;
    if (Object.keys(patch).length === 0) throw new Error("Nothing to edit");
    const op = beginOp(repo);
    const id = await requireBeadId(repo, issueNumber, op);
    return patchBead(repo, id, op, patch);
  },

  async addIssueComment(repo: RepoRef, issueNumber: number, body: string): Promise<IssueComment> {
    const op = beginOp(repo);
    const id = await requireBeadId(repo, issueNumber, op);
    const author = await resolveActor();
    const comment = await request<BeadComment>(repo, op, {
      method: "POST",
      path: beadPath(id, "/comments"),
      body: { author, text: body },
    });
    return mapComment(comment);
  },

  async addIssueLabel(repo: RepoRef, issueNumber: number, label: string): Promise<ForgeLabel[]> {
    const op = beginOp(repo);
    const id = await requireBeadId(repo, issueNumber, op);
    return (await patchBead(repo, id, op, { add_labels: [label] })).labels;
  },

  /** Beads drops an absent label silently; the host's contract is to refuse it. */
  async removeIssueLabel(repo: RepoRef, issueNumber: number, label: string): Promise<ForgeLabel[]> {
    const op = beginOp(repo);
    const issue = await requireBead(repo, issueNumber, op);
    if (!issue.labels.some((l) => l.name === label)) {
      throw new Error(`Beads issue ${issue.id} has no label "${label}"`);
    }
    return (await patchBead(repo, issue.id, op, { remove_labels: [label] })).labels;
  },

  identity: identityCapability,
  repoStats: repoStatsCapability,
};
