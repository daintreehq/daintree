import { CHANNELS } from "../../channels.js";
import { typedHandle } from "../../utils.js";
import { buildSwitchHydrateResult } from "../../../services/AppHydrationService.js";
import { prefetchHydrateResult } from "../../../services/prefetchHydrateCache.js";
import { projectStore } from "../../../services/ProjectStore.js";
import type { HandlerDependencies } from "../../types.js";

/**
 * Hover-prefetch entry point for the project switcher palette. The renderer
 * fires this as a debounced, fire-and-forget call when the mouse settles on a
 * project row for 150ms; the main process builds the `HydrateResult` payload
 * and caches it so the subsequent `app:hydrate` call from the new project view
 * resolves as a cache hit (no second disk read). The workspace host is
 * prewarmed in the same pass so the post-swap worktree load skips the cold
 * fork — `prewarmProject` is idempotent and self-reclaims if the hover never
 * becomes a click.
 *
 * Errors are swallowed inside the cache layer — a failed prefetch must never
 * surface to the user, since the click-time hydrate will simply fall through
 * to the normal read path.
 */
export function registerProjectPrefetchHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleProjectPrefetchHydrate = async (projectId: string): Promise<void> => {
    if (typeof projectId !== "string" || !projectId) return;
    const project = projectStore.getProjectById(projectId);
    if (!project) return;
    deps.worktreeService?.prewarmProject(project.path);
    await prefetchHydrateResult(projectId, buildSwitchHydrateResult);
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_PREFETCH_HYDRATE, handleProjectPrefetchHydrate));

  return () => handlers.forEach((cleanup) => cleanup());
}
