import { vi } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import type { Project, ProjectState } from "../../../../shared/types/project.js";
import type { WorktreeState } from "../../../../shared/types/worktree.js";
import type {
  ViewlessDeps,
  ViewlessTerminalRecord,
  ViewlessWorkspaceHosts,
} from "../ViewlessActionExecutor.js";

export const PROJECT: Project = {
  id: "proj-1",
  path: "/repo",
  name: "Repo",
  emoji: "tree",
  lastOpened: 0,
} as Project;

/**
 * An in-memory project state store that queues updates the way the real one
 * does, so "the next hydrate sees it" is a read of what was written.
 */
export function makeStateStore(initial: ProjectState | null = null) {
  let state = initial;
  return {
    read: () => state,
    getProjectState: vi.fn(async () => state),
    enqueueProjectStateUpdate: vi.fn(
      async (
        _projectId: string,
        updater: (
          existing: ProjectState | null
        ) => ProjectState | null | Promise<ProjectState | null>
      ) => {
        const next = await updater(state);
        if (next !== null) state = next;
      }
    ),
  };
}

/**
 * A pty-host holding the given records, all owned by {@link PROJECT}. Its
 * listing answers as the real one does: every terminal, trashed ones included,
 * each stamped with its project.
 */
export function makePty(
  records: Record<string, ViewlessTerminalRecord> = {},
  screens: Record<string, string> = {}
) {
  return {
    records,
    getTerminalProjectId: vi.fn((id: string) => (Object.hasOwn(records, id) ? PROJECT.id : null)),
    getTerminalAsync: vi.fn(
      async (id: string, _submissionToken?: string, _options?: { strict?: boolean }) =>
        Object.hasOwn(records, id) ? (records[id] ?? null) : null
    ),
    getAllTerminalsAsync: vi.fn<() => Promise<ViewlessTerminalRecord[]>>(async () =>
      Object.entries(records).map(([id, record]) => ({ projectId: PROJECT.id, ...record, id }))
    ),
    getTerminalsForProjectAsync: vi.fn(async (projectId: string) =>
      projectId === PROJECT.id
        ? Object.entries(records)
            .filter(([, record]) => record.isTrashed !== true)
            .map(([id]) => id)
        : []
    ),
    getSerializedStateAsync: vi.fn(async (id: string, _options?: { tailRows: number }) =>
      Object.hasOwn(screens, id) ? { data: screens[id] ?? "" } : null
    ),
  };
}

export function makeHosts(loaded = true) {
  return {
    getHostForProject: vi.fn((_path: string): unknown => (loaded ? {} : undefined)),
    prewarmProject: vi.fn((_path: string) => {}),
    waitForReady: vi.fn(async () => {}),
    isWorktreeOwnedByProject: vi.fn(
      async (_id: string, _path: string, _projectId: string): Promise<boolean | null> => true
    ),
    getDeletePreview: vi.fn(
      async (
        _path: string,
        _projectId: string,
        worktreeId: string
      ): ReturnType<ViewlessWorkspaceHosts["getDeletePreview"]> => ({
        changes: { worktreeId, rootPath: worktreeId, changedFileCount: 0, changes: [] },
        risk: {
          entries: [],
          dirtyFiles: [],
          untrackedFiles: [],
          atRiskCommits: [],
          requiresMechanicalForce: false,
          incomplete: false,
        },
        teardown: null,
      })
    ),
  } satisfies ViewlessWorkspaceHosts;
}

export function makeWorktree(overrides: Partial<WorktreeState> = {}): WorktreeState {
  return {
    id: "/repo",
    worktreeId: "/repo",
    path: "/repo",
    name: "repo",
    branch: "main",
    isCurrent: true,
    isMainWorktree: true,
    worktreeChanges: null,
    lastActivityTimestamp: null,
    ...overrides,
  } as WorktreeState;
}

export function makeDeps(
  overrides: Partial<ViewlessDeps> = {},
  options: { state?: ProjectState | null; worktrees?: WorktreeState[] } = {}
) {
  const store = makeStateStore(options.state ?? null);
  const worktrees = options.worktrees ?? [makeWorktree()];
  const invoke = vi.fn<(projectId: string, channel: string, args: unknown[]) => Promise<unknown>>(
    async (_projectId, channel, args) => {
      if (channel === CHANNELS.TERMINAL_SPAWN) return (args[0] as { id: string }).id;
      if (channel === CHANNELS.WORKTREE_CREATE) {
        return { worktreeId: "/repo-wt/feature", branch: "feature", setupState: "pending" };
      }
      if (channel === CHANNELS.WORKTREE_GET_ALL_WITH_STATUS) return { worktrees, gitBacked: true };
      return undefined;
    }
  );
  const send = vi.fn((_projectId: string, _channel: string, _args: unknown[]) => {});
  const deps: ViewlessDeps = {
    getProject: (id) => (id === PROJECT.id ? PROJECT : null),
    getLaunchEnvLayers: async () => ({ global: {}, project: {} }),
    getProjectState: store.getProjectState,
    stateWriter: store,
    getPtyReader: () => null,
    getWorkspaceHosts: () => null,
    invoke: invoke as ViewlessDeps["invoke"],
    send,
    agents: {
      getSettings: async () => null,
      getCcrPresets: async () => undefined,
      getProjectPresets: async () => ({}),
      getCliDetail: async () => ({
        state: "ready",
        resolvedPath: "/usr/local/bin/claude",
        via: "which",
      }),
      getAvailability: async () => ({ availability: {}, live: true }),
    },
    readTerminalStatus: async () => ({ terminals: [], source: "pty", unavailableFields: [] }),
    hostPlatform: { shellDialect: "posix", tmpDir: "/tmp", totalMemoryBytes: 64 * 1024 ** 3 },
    sleep: async () => {},
    ...overrides,
  };
  return { deps, store, invoke, send };
}

export function request(
  actionId: string,
  args: unknown,
  extra: { confirmed?: boolean } = {}
): { workspaceId: string; actionId: string; args: unknown; confirmed: boolean } {
  return { workspaceId: PROJECT.id, actionId, args, confirmed: extra.confirmed ?? false };
}
