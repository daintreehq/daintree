import type { TerminalStreamBridge } from "../../terminal/TerminalStreamBridge.js";
import type { initRemoteHostsClient } from "../../client/initClient.js";

/**
 * What the harness's module mocks read, reset per harness. The mocks stand in
 * for the app's persistent stores and its OS-facing pieces; everything the
 * remote boot wires between them is the real code.
 */

export interface HarnessProject {
  id: string;
  name: string;
  path: string;
}

export interface OwnedProcessRecord {
  file: string;
  args: readonly string[];
  killed: boolean;
}

export const harnessState = {
  userDataDir: "/nonexistent-harness-user-data",
  store: new Map<string, unknown>(),
  projects: new Map<string, HarnessProject>(),
  /** Saved project state (layout, terminals), as ProjectStore would persist it. */
  projectStates: new Map<string, unknown>(),
  /** Host-side terminal bridges by the Shell's endpoint id (the id stream messages carry). */
  bridges: new Map<string, TerminalStreamBridge>(),
  /** What boot's `initRemoteHostsClient` returned for the running Shell. */
  client: null as ReturnType<typeof initRemoteHostsClient> | null,
  /** Long-running children Host mode started (the mDNS advertiser). */
  spawned: [] as OwnedProcessRecord[],
};

export function resetHarnessState(userDataDir: string): void {
  harnessState.userDataDir = userDataDir;
  harnessState.store.clear();
  harnessState.projects.clear();
  harnessState.projectStates.clear();
  harnessState.bridges.clear();
  harnessState.client = null;
  harnessState.spawned.length = 0;
}

/** The slice of electron-store the remote modules use, over `harnessState.store`. */
export const memoryStore = {
  get(key: string, fallback?: unknown): unknown {
    return harnessState.store.has(key) ? harnessState.store.get(key) : fallback;
  },
  set(key: string, value: unknown): void {
    harnessState.store.set(key, value);
  },
  has: (key: string) => harnessState.store.has(key),
  delete(key: string): void {
    harnessState.store.delete(key);
  },
  onDidChange: () => () => undefined,
};

export const memoryProjectStore = {
  getProjectById: (id: string) => harnessState.projects.get(id) ?? null,
  getAllProjects: () => [...harnessState.projects.values()],
  getAllProjectIdentities: () =>
    [...harnessState.projects.values()].map(({ id, path, name }) => ({ id, path, name })),
  getProjectSettings: async () => null,
  getProjectState: async (id: string) => harnessState.projectStates.get(id) ?? null,
  async enqueueProjectStateUpdate(id: string, update: (existing: unknown) => unknown) {
    const next = update(harnessState.projectStates.get(id) ?? null);
    if (next !== null) harnessState.projectStates.set(id, next);
  },
};
