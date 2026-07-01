import type { AgentSettings, AgentSettingsEntry } from "@shared/types";

// Value cache + singleflight on get(): burst paths (bulk restart, duplicate,
// recipe spawns) coalesce concurrent reads into one IPC round-trip, and later
// reads are served from the cached snapshot without touching main. Freshness
// contract: writes through this client invalidate (at call time AND on
// settle, so a read that raced the write window can't leave a pre-write
// snapshot cached); external changes (cross-window writes, config reloads)
// are re-pulled by agentSettingsStore.refresh(), which calls invalidate()
// first so its get() always hits main.
let cachedSettings: AgentSettings | null = null;
let inflightGet: Promise<AgentSettings> | null = null;

function invalidate(): void {
  cachedSettings = null;
  inflightGet = null;
}

export const agentSettingsClient = {
  get: (): Promise<AgentSettings> => {
    if (cachedSettings) return Promise.resolve(cachedSettings);
    if (inflightGet) return inflightGet;

    const promise = window.electron.agentSettings.get().then(
      (settings) => {
        // Only cache if no invalidation superseded this fetch mid-flight —
        // a write that landed while we were reading makes this snapshot stale.
        if (inflightGet === promise) {
          cachedSettings = settings;
          inflightGet = null;
        }
        return settings;
      },
      (error: unknown) => {
        if (inflightGet === promise) {
          inflightGet = null;
        }
        throw error;
      }
    );
    inflightGet = promise;
    return promise;
  },

  /** Drop the cached snapshot so the next get() hits main. */
  invalidate,

  set: (agentId: string, settings: Partial<AgentSettingsEntry>): Promise<AgentSettings> => {
    invalidate();
    return window.electron.agentSettings.set(agentId, settings).finally(invalidate);
  },

  setGlobal: (value: boolean): Promise<AgentSettings> => {
    invalidate();
    return window.electron.agentSettings.setGlobal(value).finally(invalidate);
  },

  setGlobalInline: (value: boolean): Promise<AgentSettings> => {
    invalidate();
    return window.electron.agentSettings.setGlobalInline(value).finally(invalidate);
  },

  reset: (agentType?: string): Promise<AgentSettings> => {
    invalidate();
    return window.electron.agentSettings.reset(agentType).finally(invalidate);
  },

  stampVersion: (version: number): Promise<Record<string, unknown>> => {
    invalidate();
    return window.electron.agentSettings.stampVersion(version).finally(invalidate);
  },
} as const;
