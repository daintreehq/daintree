import type { SlashCommand, SlashCommandListRequest } from "@shared/types";

const CACHE_TTL = 30_000;
const cache = new Map<string, Promise<SlashCommand[]>>();

function cacheKey(agentId: string, projectPath?: string): string {
  return `${agentId}:${projectPath ?? ""}`;
}

export const slashCommandsClient = {
  list: (payload: SlashCommandListRequest): Promise<SlashCommand[]> => {
    const key = cacheKey(payload.agentId, payload.projectPath);
    const existing = cache.get(key);
    if (existing) return existing;

    const promise = window.electron.slashCommands.list(payload);
    cache.set(key, promise);

    promise.then(
      () => {
        setTimeout(() => {
          if (cache.get(key) === promise) cache.delete(key);
        }, CACHE_TTL);
      },
      () => {
        if (cache.get(key) === promise) cache.delete(key);
      }
    );

    return promise;
  },

  clearCache: (): void => {
    cache.clear();
  },
};
