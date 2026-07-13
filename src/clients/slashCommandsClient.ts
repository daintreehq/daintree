import type { SlashCommand, SlashCommandListRequest } from "@shared/types";

// In-flight coalescing only. The 30s result cache lives in the Main-process
// discovery engine (CompletionDiscoveryEngine); keeping a second completed-result
// cache here would compound to ~60s of effective staleness. Concurrent callers
// for the same key still share one IPC round-trip.
const inflight = new Map<string, Promise<SlashCommand[]>>();

function cacheKey(agentId: string, projectPath?: string): string {
  return `${agentId}:${projectPath ?? ""}`;
}

export const slashCommandsClient = {
  list: (payload: SlashCommandListRequest): Promise<SlashCommand[]> => {
    const key = cacheKey(payload.agentId, payload.projectPath);
    const existing = inflight.get(key);
    if (existing) return existing;

    const promise = window.electron.slashCommands.list(payload);
    inflight.set(key, promise);

    const clear = (): void => {
      if (inflight.get(key) === promise) inflight.delete(key);
    };
    promise.then(clear, clear);

    return promise;
  },

  clearCache: (): void => {
    inflight.clear();
  },
};
