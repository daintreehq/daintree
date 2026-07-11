import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { CHANNELS } from "../channels.js";
import { broadcastToRenderer, checkRateLimit, typedHandle } from "../utils.js";
import { defineIpcNamespace, op } from "../define.js";
import { resolveForCwd } from "./forgeResolution.js";
import { auditForgeCall, summarizeForgeArgs } from "../../services/forge/forgeAuditService.js";
import { getForgeProviderImpl } from "../../services/forgeProviderRegistry.js";
import { getCommitCount } from "../../utils/git.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { normalizeProviderId } from "../../../shared/utils/forgeProviderIds.js";
import type {
  ForgeRepoCounts,
  ForgeTokenHealthState,
  Issue,
  IssueTooltipData,
  ListOptions,
  PR,
  PRTooltipData,
  RateLimitDetails,
  ReviewThread,
} from "../../../shared/types/forge.js";
import type {
  ForgeFirstPageCachePayload,
  ForgeProjectHealthPayload,
  ForgeRepoCountsUpdatedPayload,
  ForgeRepositoryStats,
  ForgeRepoStatsAndPagePayload,
} from "../../../shared/types/ipc/forge.js";

/**
 * Provider-agnostic forge *data* handlers (list/get queries). The sibling
 * `forge.ts` owns side-effectful actions (open in browser, assign);
 * `forgeSettings.ts` owns config CRUD. Splitting queries out keeps the read
 * surface from tangling with the action surface. Every handler opens with a
 * `checkRateLimit` guard whose budget matches the `github.*` channel it
 * replaced (#9956).
 *
 * Every handler resolves `cwd → ForgeProviderImpl` via {@link resolveForCwd}
 * and delegates to the normalized contract — the renderer never sees
 * GitHub-shaped data through this path. Handlers throw on resolution or
 * provider failure; the IPC envelope serializes the error (see #3769).
 */

function requirePositiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function requireCwd(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Invalid working directory");
  }
  return value;
}

/** Blend provider-reported forge counts with the host-computed commit count. */
function buildForgeRepositoryStats(
  commitCount: number,
  counts: ForgeRepoCounts
): ForgeRepositoryStats {
  return {
    commitCount,
    issueCount: counts.issueCount,
    prCount: counts.prCount,
    loading: false,
    error: counts.error,
    stale: counts.stale,
    lastUpdated: counts.lastUpdated,
    issueCountRefreshedAt: counts.issueCountRefreshedAt,
    prCountRefreshedAt: counts.prCountRefreshedAt,
    rateLimitResetAt: counts.rateLimitResetAt,
    rateLimitKind: counts.rateLimitKind,
    nextPollIntervalMs: counts.nextPollIntervalMs,
  };
}

/**
 * Forge-neutral port of the GitHub plugin's `buildEmptyProjectHealthData` —
 * the "no signal" payload the project pulse card renders when health can't
 * be fetched. Local copy so this handler never imports plugin code.
 */
function buildEmptyForgeProjectHealth(
  opts: { error?: string; hasRemote?: boolean } = {}
): ForgeProjectHealthPayload {
  return {
    ciStatus: "none",
    issueCount: 0,
    prCount: 0,
    latestRelease: null,
    securityAlerts: { visible: false, count: 0 },
    mergeVelocity: { mergedCounts: { 60: 0, 120: 0, 180: 0 } },
    repoUrl: "",
    hasRemote: opts.hasRemote ?? false,
    loading: false,
    error: opts.error,
  };
}

/**
 * Whether a provider health error means "this repository has no forge
 * remote" (legacy check: `error !== "Not a GitHub repository"`). Matched as
 * a pattern so non-GitHub providers reporting e.g. "Not a GitLab repository"
 * get the same `hasRemote: false` treatment.
 */
function isNotForgeRepoError(error: string | undefined): boolean {
  return typeof error === "string" && /^not a \S+ repository$/i.test(error.trim());
}

// Brief in-flight collapse window after a read resolves. These handlers are
// point lookups that can't be batched but get hammered by concurrent renderer
// callers (e.g. several panels mounting against the same cwd). 150ms mirrors
// the WorkspaceClient singleflight TTL (#4832): long enough to collapse a
// mount burst, short enough never to serve stale read data.
const SINGLE_FLIGHT_TTL_MS = 150;

/**
 * Closure-scoped single-flight coalescer. Concurrent callers with the same key
 * share one in-flight promise; a key keeps collapsing for {@link
 * SINGLE_FLIGHT_TTL_MS} after it resolves, and is evicted immediately on
 * rejection so the next caller retries. The map is per-`registerForgeDataHandlers`
 * call so it never leaks across project teardown.
 */
function createSingleFlight() {
  const inflight = new Map<string, Promise<unknown>>();
  return function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = inflight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = run();
    inflight.set(key, promise);
    promise.then(
      () => {
        setTimeout(() => {
          if (inflight.get(key) === promise) inflight.delete(key);
        }, SINGLE_FLIGHT_TTL_MS);
      },
      () => {
        if (inflight.get(key) === promise) inflight.delete(key);
      }
    );
    return promise;
  };
}

/**
 * Deterministic key for a {@link ListOptions} value. Built from explicit fields
 * in a fixed order rather than `JSON.stringify`, whose output depends on
 * property insertion order and would split otherwise-identical queries into
 * separate in-flight slots.
 */
function listOptionsKey(opts: ListOptions): string {
  // JSON-encode a fixed-order tuple so each field is unambiguously delimited:
  // a string separator would let a `|` inside a value (or `["a,b"]` vs
  // `["a","b"]` labels) collide two distinct queries into one in-flight slot.
  return JSON.stringify([
    opts.state ?? null,
    opts.cursor ?? null,
    opts.perPage ?? null,
    opts.labels ?? null,
    opts.assignee ?? null,
    opts.sort ?? null,
    opts.direction ?? null,
    opts.search ?? null,
  ]);
}

export function registerForgeDataHandlers(): () => void {
  const cleanups: Array<() => void> = [];
  const coalesce = createSingleFlight();

  cleanups.push(
    typedHandle(
      CHANNELS.FORGE_LIST_ISSUES,
      async (payload: { cwd: string; opts?: ListOptions }) => {
        checkRateLimit(CHANNELS.FORGE_LIST_ISSUES, 10, 10_000);
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        const cwd = requireCwd(payload.cwd);
        const opts = payload.opts ?? {};
        return coalesce(`${cwd}::listIssues::${listOptionsKey(opts)}`, async () => {
          const { impl, repoRef, namespaceId } = await resolveForCwd(cwd);
          return auditForgeCall(
            {
              providerId: namespaceId,
              methodName: "listIssues",
              repoOwner: repoRef.owner,
              repoName: repoRef.repo,
              argsSummary: summarizeForgeArgs("listIssues", opts),
            },
            () => impl.listIssues(repoRef, opts)
          );
        });
      }
    )
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_LIST_PRS, async (payload: { cwd: string; opts?: ListOptions }) => {
      checkRateLimit(CHANNELS.FORGE_LIST_PRS, 10, 10_000);
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload");
      }
      const cwd = requireCwd(payload.cwd);
      const opts = payload.opts ?? {};
      return coalesce(`${cwd}::listPRs::${listOptionsKey(opts)}`, async () => {
        const { impl, repoRef, namespaceId } = await resolveForCwd(cwd);
        return auditForgeCall(
          {
            providerId: namespaceId,
            methodName: "listPRs",
            repoOwner: repoRef.owner,
            repoName: repoRef.repo,
            argsSummary: summarizeForgeArgs("listPRs", opts),
          },
          () => impl.listPRs(repoRef, opts)
        );
      });
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_GET_ISSUE, async (payload: { cwd: string; issueNumber: number }) => {
      checkRateLimit(CHANNELS.FORGE_GET_ISSUE, 25, 10_000);
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload");
      }
      const cwd = requireCwd(payload.cwd);
      const issueNumber = requirePositiveInt(payload.issueNumber, "issue number");
      return coalesce(`${cwd}::getIssue::${issueNumber}`, async () => {
        const { impl, repoRef, namespaceId } = await resolveForCwd(cwd);
        return auditForgeCall(
          {
            providerId: namespaceId,
            methodName: "getIssue",
            repoOwner: repoRef.owner,
            repoName: repoRef.repo,
            argsSummary: summarizeForgeArgs("getIssue", issueNumber),
          },
          () => impl.getIssue(repoRef, issueNumber),
          (value) => (value === null ? "not-found" : "success")
        );
      });
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_GET_PR, async (payload: { cwd: string; prNumber: number }) => {
      checkRateLimit(CHANNELS.FORGE_GET_PR, 25, 10_000);
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload");
      }
      const cwd = requireCwd(payload.cwd);
      const prNumber = requirePositiveInt(payload.prNumber, "PR number");
      return coalesce(`${cwd}::getPR::${prNumber}`, async () => {
        const { impl, repoRef, namespaceId } = await resolveForCwd(cwd);
        return auditForgeCall(
          {
            providerId: namespaceId,
            methodName: "getPR",
            repoOwner: repoRef.owner,
            repoName: repoRef.repo,
            argsSummary: summarizeForgeArgs("getPR", prNumber),
          },
          () => impl.getPR(repoRef, prNumber),
          (value) => (value === null ? "not-found" : "success")
        );
      });
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_GET_REPO_METADATA, async (payload: { cwd: string }) => {
      checkRateLimit(CHANNELS.FORGE_GET_REPO_METADATA, 10, 10_000);
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload");
      }
      const cwd = requireCwd(payload.cwd);
      const { impl, repoRef, namespaceId } = await resolveForCwd(cwd);
      return auditForgeCall(
        {
          providerId: namespaceId,
          methodName: "getRepoMetadata",
          repoOwner: repoRef.owner,
          repoName: repoRef.repo,
        },
        () => impl.getRepoMetadata(repoRef)
      );
    })
  );

  // Read probe — no audit envelope. Mirrors `getRateLimit` (a probe, not a
  // mutation): the audit ring should record meaningful lookups, not the
  // renderer's identity probe fired on every worktree dialog open. The
  // `ForgeProviderMethodName` union still carries the name so the
  // `summarizeForgeArgs` switch stays exhaustive.
  cleanups.push(
    typedHandle(CHANNELS.FORGE_GET_CURRENT_USER, async (payload: { cwd: string }) => {
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload");
      }
      const cwd = requireCwd(payload.cwd);
      const { impl } = await resolveForCwd(cwd);
      return impl.identity ? impl.identity.getCurrentUser() : null;
    })
  );

  cleanups.push(forgeCapabilityDataNamespace.register());

  return () => cleanups.forEach((c) => c());
}

// Capability handlers below are read probes against optional capabilities
// (stats, tooltips, health, avatars) — like FORGE_GET_CURRENT_USER they
// skip the audit envelope; the meaningful lookups already audit through
// the core list/get handlers.

async function handleForgeGetRepoStats(payload: {
  cwd: string;
  bypassCache?: boolean;
}): Promise<ForgeRepositoryStats> {
  checkRateLimit(CHANNELS.FORGE_GET_REPO_STATS, 10, 10_000);
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid payload");
  }
  const cwd = requireCwd(payload.cwd);
  // #10663: short-circuit before any git call if the project directory was
  // deleted or moved externally. The renderer's `useRepositoryStats` loop
  // keeps polling this handler (every 2min on its error backoff) even after
  // the path is gone; without this guard each poll runs `getCommitCount` ->
  // `createHardenedGit` against the dead path and emits a WARN log. Return a
  // commits-only zero snapshot — the same shape as the no-provider fallback.
  if (!existsSync(cwd)) {
    return buildForgeRepositoryStats(0, { issueCount: null, prCount: null });
  }
  let resolved: Awaited<ReturnType<typeof resolveForCwd>>;
  try {
    resolved = await resolveForCwd(cwd);
  } catch {
    // No forge provider for this repo (no matching remote, plugin disabled,
    // or not yet activated): the toolbar still shows the local commit count,
    // so return a commit-only snapshot instead of failing the whole surface.
    // Forge counts stay null — the renderer renders the commits-only pill.
    const commitCount = await getCommitCount(cwd).catch(() => 0);
    return buildForgeRepositoryStats(commitCount, { issueCount: null, prCount: null });
  }
  const { impl, repoRef, namespaceId } = resolved;
  if (!impl.repoStats) {
    throw new Error("Provider does not support repository stats");
  }
  const snapshot = await impl.repoStats.getRepoStats(repoRef, {
    bypassCache: payload.bypassCache === true,
  });
  const commitCount = await getCommitCount(cwd).catch(() => 0);
  const stats = buildForgeRepositoryStats(commitCount, snapshot.counts);

  const fresh = snapshot.source === "network" && !snapshot.counts.stale;
  if (snapshot.issues && snapshot.prs && fresh) {
    const push: ForgeRepoStatsAndPagePayload = {
      providerId: namespaceId,
      projectPath: path.resolve(cwd),
      stats,
      issues: snapshot.issues,
      prs: snapshot.prs,
      fetchedAt: Date.now(),
    };
    broadcastToRenderer(CHANNELS.FORGE_REPO_STATS_AND_PAGE_UPDATED, push);
  } else if (fresh) {
    // Count-only poll (the cheap path) — push the fresh counts to other
    // views of the same project without page data.
    const push: ForgeRepoCountsUpdatedPayload = {
      providerId: namespaceId,
      projectPath: path.resolve(cwd),
      stats,
      fetchedAt: Date.now(),
    };
    broadcastToRenderer(CHANNELS.FORGE_REPO_COUNTS_UPDATED, push);
  }

  return stats;
}

async function handleForgeGetFirstPageCache(payload: {
  cwd: string;
}): Promise<ForgeFirstPageCachePayload | null> {
  checkRateLimit(CHANNELS.FORGE_GET_FIRST_PAGE_CACHE, 10, 10_000);
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.cwd !== "string" || !payload.cwd.trim()) return null;
  // Cold-start hydration is best-effort — resolution or provider failure
  // means "no cache", never an error.
  try {
    const { impl, repoRef, namespaceId } = await resolveForCwd(payload.cwd);
    const snapshot = await impl.repoStats?.getFirstPageCache?.(repoRef);
    if (!snapshot) return null;
    return {
      providerId: namespaceId,
      projectPath: path.resolve(payload.cwd),
      issues: snapshot.issues,
      prs: snapshot.prs,
      lastUpdated: snapshot.lastUpdated,
      stats: snapshot.counts,
    };
  } catch {
    return null;
  }
}

async function handleForgeGetProjectHealth(payload: {
  cwd: string;
  bypassCache?: boolean;
}): Promise<ForgeProjectHealthPayload> {
  checkRateLimit(CHANNELS.FORGE_GET_PROJECT_HEALTH, 10, 10_000);
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid payload");
  }
  const cwd = requireCwd(payload.cwd);
  try {
    const resolved = path.resolve(cwd);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return buildEmptyForgeProjectHealth({ error: "Path is not a directory" });
    }

    const { impl, repoRef } = await resolveForCwd(cwd);
    if (!impl.projectHealth) {
      // Capability absent is not an error and not a missing remote — mark it
      // so the pulse card hides the health section rather than telling the
      // user to "connect a git remote" they already have.
      return {
        ...buildEmptyForgeProjectHealth({ hasRemote: true }),
        unsupported: true,
      };
    }
    const result = await impl.projectHealth.getProjectHealth(repoRef, {
      bypassCache: payload.bypassCache === true,
    });
    if (result.health) {
      return { ...result.health, hasRemote: true, loading: false, error: result.error };
    }
    return buildEmptyForgeProjectHealth({
      error: result.error,
      hasRemote: !isNotForgeRepoError(result.error),
    });
  } catch (err) {
    return buildEmptyForgeProjectHealth({
      error: formatErrorMessage(err, "Failed to fetch project health"),
    });
  }
}

async function handleForgeGetIssueTooltip(payload: {
  cwd: string;
  issueNumber: number;
}): Promise<IssueTooltipData | null> {
  checkRateLimit(CHANNELS.FORGE_GET_ISSUE_TOOLTIP, 20, 10_000);
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.cwd !== "string" || !payload.cwd.trim()) return null;
  if (
    typeof payload.issueNumber !== "number" ||
    !Number.isInteger(payload.issueNumber) ||
    payload.issueNumber <= 0
  ) {
    return null;
  }
  try {
    const { impl, repoRef } = await resolveForCwd(payload.cwd);
    return (await impl.tooltips?.getIssueTooltip(repoRef, payload.issueNumber)) ?? null;
  } catch {
    return null;
  }
}

async function handleForgeGetPRTooltip(payload: {
  cwd: string;
  prNumber: number;
}): Promise<PRTooltipData | null> {
  checkRateLimit(CHANNELS.FORGE_GET_PR_TOOLTIP, 20, 10_000);
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.cwd !== "string" || !payload.cwd.trim()) return null;
  if (
    typeof payload.prNumber !== "number" ||
    !Number.isInteger(payload.prNumber) ||
    payload.prNumber <= 0
  ) {
    return null;
  }
  try {
    const { impl, repoRef } = await resolveForCwd(payload.cwd);
    return (await impl.tooltips?.getPRTooltip(repoRef, payload.prNumber)) ?? null;
  } catch {
    return null;
  }
}

async function handleForgeGetIssuesByNumbers(payload: {
  cwd: string;
  numbers: number[];
}): Promise<Issue[]> {
  checkRateLimit(CHANNELS.FORGE_GET_ISSUES_BY_NUMBERS, 20, 10_000);
  if (!payload || typeof payload !== "object") return [];
  if (typeof payload.cwd !== "string" || !payload.cwd.trim()) return [];
  if (!Array.isArray(payload.numbers)) return [];
  const numbers = payload.numbers.filter(
    (n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0
  );
  if (numbers.length === 0) return [];
  const { impl, repoRef } = await resolveForCwd(payload.cwd);
  const batch = impl.batchLookups;
  if (!batch?.findIssuesByNumbers) return [];
  const found = await batch.findIssuesByNumbers(repoRef, numbers);
  const result: Issue[] = [];
  for (const n of numbers) {
    const issue = found.get(n);
    if (issue) result.push(issue);
  }
  return result;
}

async function handleForgeGetPRsByNumbers(payload: {
  cwd: string;
  numbers: number[];
}): Promise<PR[]> {
  checkRateLimit(CHANNELS.FORGE_GET_PRS_BY_NUMBERS, 20, 10_000);
  if (!payload || typeof payload !== "object") return [];
  if (typeof payload.cwd !== "string" || !payload.cwd.trim()) return [];
  if (!Array.isArray(payload.numbers)) return [];
  const numbers = payload.numbers.filter(
    (n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0
  );
  if (numbers.length === 0) return [];
  const { impl, repoRef } = await resolveForCwd(payload.cwd);
  const batch = impl.batchLookups;
  if (!batch?.findPRsByNumbers) return [];
  const found = await batch.findPRsByNumbers(repoRef, numbers);
  const result: PR[] = [];
  for (const n of numbers) {
    const pr = found.get(n);
    if (pr) result.push(pr);
  }
  return result;
}

async function handleForgeGetPRReviewThreads(payload: {
  cwd: string;
  prNumber: number;
}): Promise<ReviewThread[]> {
  checkRateLimit(CHANNELS.FORGE_GET_PR_REVIEW_THREADS, 10, 10_000);
  if (!payload || typeof payload !== "object") return [];
  if (typeof payload.cwd !== "string" || !payload.cwd.trim()) return [];
  if (
    typeof payload.prNumber !== "number" ||
    !Number.isInteger(payload.prNumber) ||
    payload.prNumber <= 0
  ) {
    return [];
  }
  const { impl, repoRef } = await resolveForCwd(payload.cwd);
  if (!impl.reviews) return [];
  return impl.reviews.getReviewThreads(repoRef, payload.prNumber);
}

async function handleForgeResolveAuthorAvatar(payload: {
  cwd: string;
  email: string;
}): Promise<string | null> {
  checkRateLimit(CHANNELS.FORGE_RESOLVE_AUTHOR_AVATAR, 30, 60_000);
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.cwd !== "string" || !payload.cwd.trim()) return null;
  if (typeof payload.email !== "string" || !payload.email.trim()) return null;
  try {
    const { impl } = await resolveForCwd(payload.cwd);
    return (await impl.avatars?.resolveAuthorAvatar(payload.email.trim().toLowerCase())) ?? null;
  } catch {
    return null;
  }
}

// Replay the current token-health state on mount so a second window can
// surface the banner without waiting for the next probe push.
async function handleForgeGetTokenHealth(payload: {
  providerId: string;
}): Promise<ForgeTokenHealthState | null> {
  if (!payload || typeof payload !== "object") return null;
  const providerId = normalizeProviderId(payload.providerId);
  if (!providerId) return null;
  const impl = getForgeProviderImpl(providerId);
  return impl?.healthEvents?.getTokenHealth() ?? null;
}

async function handleForgeGetRateLimitDetails(payload: {
  cwd: string;
}): Promise<RateLimitDetails | null> {
  checkRateLimit(CHANNELS.FORGE_GET_RATE_LIMIT_DETAILS, 30, 60_000);
  if (!payload || typeof payload !== "object") return null;
  const cwd = requireCwd(payload.cwd);
  const { impl } = await resolveForCwd(cwd);
  return (await impl.healthEvents?.getRateLimitDetails?.()) ?? null;
}

export const forgeCapabilityDataNamespace = defineIpcNamespace({
  name: "forgeCapabilityData",
  ops: {
    getRepoStats: op(CHANNELS.FORGE_GET_REPO_STATS, handleForgeGetRepoStats),
    getFirstPageCache: op(CHANNELS.FORGE_GET_FIRST_PAGE_CACHE, handleForgeGetFirstPageCache),
    getProjectHealth: op(CHANNELS.FORGE_GET_PROJECT_HEALTH, handleForgeGetProjectHealth),
    getIssueTooltip: op(CHANNELS.FORGE_GET_ISSUE_TOOLTIP, handleForgeGetIssueTooltip),
    getPRTooltip: op(CHANNELS.FORGE_GET_PR_TOOLTIP, handleForgeGetPRTooltip),
    getIssuesByNumbers: op(CHANNELS.FORGE_GET_ISSUES_BY_NUMBERS, handleForgeGetIssuesByNumbers),
    getPRsByNumbers: op(CHANNELS.FORGE_GET_PRS_BY_NUMBERS, handleForgeGetPRsByNumbers),
    getPRReviewThreads: op(CHANNELS.FORGE_GET_PR_REVIEW_THREADS, handleForgeGetPRReviewThreads),
    resolveAuthorAvatar: op(CHANNELS.FORGE_RESOLVE_AUTHOR_AVATAR, handleForgeResolveAuthorAvatar),
    getTokenHealth: op(CHANNELS.FORGE_GET_TOKEN_HEALTH, handleForgeGetTokenHealth),
    getRateLimitDetails: op(CHANNELS.FORGE_GET_RATE_LIMIT_DETAILS, handleForgeGetRateLimitDetails),
  },
});
