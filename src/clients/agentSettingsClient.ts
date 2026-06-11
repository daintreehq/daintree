import type { AgentSettings, AgentSettingsEntry } from "@shared/types";

// Singleflight on get(): burst paths (bulk restart, duplicate, recipe spawns)
// coalesce concurrent reads into one IPC round-trip. Deliberately no resolved-
// value cache — agentSettingsStore.refresh() exists to re-pull external
// changes (cross-window writes, config reloads) and must always hit main.
// Writes clear the inflight read so post-write get() calls never coalesce
// onto a pre-write fetch.
let inflightGet: Promise<AgentSettings> | null = null;

function clearInflightGet(): void {
  inflightGet = null;
}

export const agentSettingsClient = {
  get: (): Promise<AgentSettings> => {
    if (inflightGet) return inflightGet;

    const promise = window.electron.agentSettings.get().finally(() => {
      if (inflightGet === promise) {
        inflightGet = null;
      }
    });
    inflightGet = promise;
    return promise;
  },

  set: (agentId: string, settings: Partial<AgentSettingsEntry>): Promise<AgentSettings> => {
    clearInflightGet();
    return window.electron.agentSettings.set(agentId, settings);
  },

  reset: (agentType?: string): Promise<AgentSettings> => {
    clearInflightGet();
    return window.electron.agentSettings.reset(agentType);
  },

  stampVersion: (version: number): Promise<Record<string, unknown>> => {
    clearInflightGet();
    return window.electron.agentSettings.stampVersion(version);
  },
} as const;
