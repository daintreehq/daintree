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

export function registerForgeDataHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    typedHandle(
      CHANNELS.FORGE_LIST_ISSUES,
      async (payload: { cwd: string; opts?: ListOptions }) => {
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        const cwd = requireCwd(payload.cwd);
        const { impl, repoRef } = await resolveForCwd(cwd);
        return impl.listIssues(repoRef, payload.opts ?? {});
      }
    )
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_LIST_PRS, async (payload: { cwd: string; opts?: ListOptions }) => {
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload");
      }
      const cwd = requireCwd(payload.cwd);
      const { impl, repoRef } = await resolveForCwd(cwd);
      return impl.listPRs(repoRef, payload.opts ?? {});
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_GET_ISSUE, async (payload: { cwd: string; issueNumber: number }) => {
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload");
      }
      const cwd = requireCwd(payload.cwd);
      const issueNumber = requirePositiveInt(payload.issueNumber, "issue number");
      const { impl, repoRef } = await resolveForCwd(cwd);
      return impl.getIssue(repoRef, issueNumber);
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_GET_PR, async (payload: { cwd: string; prNumber: number }) => {
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload");
      }
      const cwd = requireCwd(payload.cwd);
      const prNumber = requirePositiveInt(payload.prNumber, "PR number");
      const { impl, repoRef } = await resolveForCwd(cwd);
      return impl.getPR(repoRef, prNumber);
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
