import { CHANNELS } from "../channels.js";
import { checkRateLimit, typedHandle } from "../utils.js";
import { resolveForCwd } from "./forgeResolution.js";
import { auditForgeCall, summarizeForgeArgs } from "../../services/forge/forgeAuditService.js";
import type { ListOptions } from "../../../shared/types/forge.js";

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

  return () => cleanups.forEach((c) => c());
}
