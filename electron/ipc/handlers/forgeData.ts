import { CHANNELS } from "../channels.js";
import { typedHandle } from "../utils.js";
import { resolveForCwd } from "./forgeResolution.js";
import type { ListOptions } from "../../../shared/types/forge.js";

/**
 * Provider-agnostic forge *data* handlers (list/get queries). The sibling
 * `forge.ts` owns side-effectful actions (open in browser, assign);
 * `forgeSettings.ts` owns config CRUD. Splitting queries out keeps
 * rate-limit/error handling for reads from tangling with the action surface.
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
  return [
    opts.state ?? "",
    opts.cursor ?? "",
    opts.perPage ?? "",
    (opts.labels ?? []).join(","),
    opts.assignee ?? "",
    opts.sort ?? "",
    opts.direction ?? "",
  ].join("|");
}

export function registerForgeDataHandlers(): () => void {
  const cleanups: Array<() => void> = [];
  const coalesce = createSingleFlight();

  cleanups.push(
    typedHandle(
      CHANNELS.FORGE_LIST_ISSUES,
      async (payload: { cwd: string; opts?: ListOptions }) => {
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        const cwd = requireCwd(payload.cwd);
        const opts = payload.opts ?? {};
        return coalesce(`${cwd}::listIssues::${listOptionsKey(opts)}`, async () => {
          const { impl, repoRef } = await resolveForCwd(cwd);
          return impl.listIssues(repoRef, opts);
        });
      }
    )
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_LIST_PRS, async (payload: { cwd: string; opts?: ListOptions }) => {
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload");
      }
      const cwd = requireCwd(payload.cwd);
      const opts = payload.opts ?? {};
      return coalesce(`${cwd}::listPRs::${listOptionsKey(opts)}`, async () => {
        const { impl, repoRef } = await resolveForCwd(cwd);
        return impl.listPRs(repoRef, opts);
      });
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_GET_ISSUE, async (payload: { cwd: string; issueNumber: number }) => {
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload");
      }
      const cwd = requireCwd(payload.cwd);
      const issueNumber = requirePositiveInt(payload.issueNumber, "issue number");
      return coalesce(`${cwd}::getIssue::${issueNumber}`, async () => {
        const { impl, repoRef } = await resolveForCwd(cwd);
        return impl.getIssue(repoRef, issueNumber);
      });
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_GET_PR, async (payload: { cwd: string; prNumber: number }) => {
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload");
      }
      const cwd = requireCwd(payload.cwd);
      const prNumber = requirePositiveInt(payload.prNumber, "PR number");
      return coalesce(`${cwd}::getPR::${prNumber}`, async () => {
        const { impl, repoRef } = await resolveForCwd(cwd);
        return impl.getPR(repoRef, prNumber);
      });
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_GET_REPO_METADATA, async (payload: { cwd: string }) => {
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload");
      }
      const cwd = requireCwd(payload.cwd);
      const { impl, repoRef } = await resolveForCwd(cwd);
      return impl.getRepoMetadata(repoRef);
    })
  );

  return () => cleanups.forEach((c) => c());
}
