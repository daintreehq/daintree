/**
 * #12434 acceptance scenarios end to end through the real respawn builder and
 * the real agent registry: what each restored pane is actually launched with,
 * or that it is held instead. `panelRestorePhase.test.ts` covers the decisions
 * with a stubbed builder; this is what those decisions turn into.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalState } from "@shared/types/ipc/terminal";
import type { WorktreeState } from "@shared/types";
import type { PtyPanelData } from "@shared/types/panel";

vi.mock("@/utils/logger", () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: { initializeBackendTier: vi.fn(), setTargetSize: vi.fn() },
}));

const resolveResumeLatestSession = vi.hoisted(() =>
  vi.fn(async (_payload: { cwd: string }): Promise<string | null> => null)
);
vi.mock("@/clients/codexClient", () => ({
  codexClient: { resolveResumeLatestSession },
}));

vi.mock("../reconnectManager", () => ({
  reconnectWithTimeout: async () => ({ status: "not_found" }),
}));

vi.mock("@/utils/agentLaunchCommand", () => ({
  getCurrentLaunchCliDetail: async () => undefined,
  resolveAgentLaunchBaseCommand: (registryCommand: string) => registryCommand,
}));

vi.mock("@/config/agents", () => ({
  isRegisteredAgent: (id: string) => ["claude", "codex", "gemini"].includes(id),
  getAgentConfig: (id: string) => ({ command: id, name: id }),
  getMergedPreset: () => undefined,
  sanitizeAgentEnv: (env: Record<string, unknown> | undefined) => {
    if (!env) return undefined;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") result[key] = value;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  },
}));

vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: { getState: () => ({ ccrPresetsByAgent: {} }) },
}));

vi.mock("@shared/config/panelKindRegistry", async () => {
  const actual = await vi.importActual<typeof import("@shared/config/panelKindRegistry")>(
    "@shared/config/panelKindRegistry"
  );
  const ptyKinds = new Set(["terminal", "agent"]);
  return {
    ...actual,
    panelKindHasPty: (kind: string) => ptyKinds.has(kind),
    getPanelKindConfig: (kind: string) => (ptyKinds.has(kind) ? { kind } : undefined),
    panelKindIsDockable: () => true,
  };
});

const { restorePanelsPhase } = await import("../panelRestorePhase");
const { serializePtyPanel } = await import("@/panels/terminal/serializer");

type RestoreContext = Parameters<typeof restorePanelsPhase>[1];
type RestoredArgs = Parameters<RestoreContext["addPanel"]>[0];

const TASKS = ["a", "b", "c", "d", "e"];

function worktree(path: string): WorktreeState {
  return {
    id: path,
    worktreeId: path,
    name: path,
    path,
    branch: path,
    isCurrent: false,
    isMainWorktree: path === "/repo",
    worktreeChanges: null,
    lastActivityTimestamp: null,
  };
}

function movedPane(name: string, overrides: Partial<TerminalState> = {}): TerminalState {
  return {
    id: name,
    title: `Task ${name}`,
    kind: "terminal",
    launchAgentId: "codex",
    cwd: "/repo",
    worktreeId: `/worktrees/task-${name}`,
    location: "grid",
    agentLaunchFlags: ["--no-alt-screen"],
    ...overrides,
  };
}

async function restore(panels: TerminalState[]): Promise<Map<string, RestoredArgs>> {
  const byId = new Map<string, RestoredArgs>();
  await restorePanelsPhase(panels, {
    addPanel: async (options) => {
      const id = options.requestedId ?? options.existingId ?? "unknown";
      byId.set(id, options);
      return id;
    },
    withHydrationBatch: async (run) => run(),
    backendTerminalMap: new Map(),
    terminalSizes: {},
    activeWorktreeId: "/repo",
    workspaceHasWorktreesPromise: Promise.resolve(true),
    projectRoot: "/repo",
    projectId: "proj",
    agentSettings: { agents: { codex: {} } },
    clipboardDirectory: undefined,
    projectPresetsByAgent: {},
    worktreesPromise: Promise.resolve([
      worktree("/repo"),
      ...TASKS.map((t) => worktree(`/worktrees/task-${t}`)),
    ]),
    safeMode: false,
    logHydrationInfo: () => {},
  });
  return byId;
}

beforeEach(() => {
  resolveResumeLatestSession.mockReset();
  resolveResumeLatestSession.mockResolvedValue(null);
});

describe("cold restore of moved Codex panes (#12434)", () => {
  it("resumes five panes with their own ids, each pinned to its own worktree", async () => {
    const byId = await restore(TASKS.map((t) => movedPane(t, { agentSessionId: `sess-${t}` })));

    for (const t of TASKS) {
      const args = byId.get(t);
      expect(args?.cwd).toBe(`/worktrees/task-${t}`);
      expect(args?.worktreeId).toBe(`/worktrees/task-${t}`);
      expect(args?.command).toMatch(new RegExp(`^codex .*resume sess-${t} -C \\S+$`));
      expect(args?.agentSessionId).toBe(`sess-${t}`);
      expect(args?.conversationCwd).toBe("/repo");
      expect(args?.restoreRecovery).toBeUndefined();
    }
  });

  it("holds all five when none has an id and the folder's latest can't be named", async () => {
    const byId = await restore(TASKS.map((t, i) => movedPane(t, { lastActiveAt: 10 + i })));

    const reasons = TASKS.map((t) => byId.get(t)?.restoreRecovery?.reason);
    expect(reasons).toEqual([
      "sibling-owns-resume-latest-slot",
      "sibling-owns-resume-latest-slot",
      "sibling-owns-resume-latest-slot",
      "sibling-owns-resume-latest-slot",
      "session-unresolved",
    ]);
    for (const t of TASKS) {
      const args = byId.get(t);
      // Nothing launches blank, and nothing runs `--last` from a fresh worktree.
      expect(args?.command).not.toContain("resume");
      expect(args?.agentSessionId).toBeUndefined();
      expect(args?.sessionLostOnRestore).toBeUndefined();
      expect(args?.cwd).toBe(`/worktrees/task-${t}`);
      expect(args?.conversationCwd).toBe("/repo");
    }
    expect(resolveResumeLatestSession).toHaveBeenCalledTimes(1);
    expect(resolveResumeLatestSession).toHaveBeenCalledWith({ cwd: "/repo" });
  });

  it("resumes the named latest for the one pane allowed to use it, in its worktree", async () => {
    resolveResumeLatestSession.mockResolvedValue("sess-latest");

    const byId = await restore(TASKS.map((t, i) => movedPane(t, { lastActiveAt: 10 + i })));

    const winner = byId.get("e");
    expect(winner?.command).toMatch(/resume sess-latest -C \S+$/);
    expect(winner?.cwd).toBe("/worktrees/task-e");
    expect(winner?.agentSessionId).toBe("sess-latest");
    for (const t of TASKS.slice(0, 4)) {
      expect(byId.get(t)?.restoreRecovery).toEqual({ reason: "sibling-owns-resume-latest-slot" });
    }
  });

  it("resumes the one known conversation and holds the four without an id", async () => {
    const byId = await restore([
      movedPane("a", { agentSessionId: "sess-a" }),
      ...TASKS.slice(1).map((t) => movedPane(t)),
    ]);

    expect(byId.get("a")?.command).toMatch(/resume sess-a -C \S+$/);
    expect(byId.get("a")?.cwd).toBe("/worktrees/task-a");
    for (const t of TASKS.slice(1)) {
      expect(byId.get(t)?.restoreRecovery).toEqual({ reason: "sibling-owns-resume-latest-slot" });
    }
    expect(resolveResumeLatestSession).not.toHaveBeenCalled();
  });

  it("gives a duplicated id to one pane and holds the other", async () => {
    const byId = await restore([
      movedPane("a", { agentSessionId: "sess-dup", lastActiveAt: 5 }),
      movedPane("b", { agentSessionId: "sess-dup", lastActiveAt: 9 }),
    ]);

    expect(byId.get("b")?.command).toMatch(/resume sess-dup -C \S+$/);
    expect(byId.get("a")?.restoreRecovery).toEqual({ reason: "sibling-owns-session-id" });
    expect(byId.get("a")?.agentSessionId).toBeUndefined();
  });

  it("keeps a hold across another restart, without launching or losing its folder", async () => {
    const first = await restore([
      movedPane("a", { agentSessionId: "sess-a", lastActiveAt: 9 }),
      movedPane("b", { agentSessionId: "sess-a", lastActiveAt: 1 }),
    ]);
    const heldArgs = first.get("b");
    expect(heldArgs?.restoreRecovery).toBeDefined();

    // What the held pane writes to disk, read back as the next restore sees it.
    const heldPanel: PtyPanelData = {
      id: "b",
      kind: "terminal",
      title: "Task b",
      location: "grid",
      cols: 80,
      rows: 24,
      cwd: heldArgs?.cwd ?? "",
      worktreeId: heldArgs?.worktreeId,
      launchAgentId: "codex",
      command: heldArgs?.command,
      agentLaunchFlags: heldArgs?.agentLaunchFlags,
      conversationCwd: heldArgs?.conversationCwd,
      restoreRecovery: heldArgs?.restoreRecovery,
      hasPty: false,
    };
    const snapshot: TerminalState = {
      id: "b",
      title: "Task b",
      location: "grid",
      kind: "terminal",
      worktreeId: heldPanel.worktreeId,
      ...serializePtyPanel(heldPanel),
    };

    // The sibling is gone this time, so nothing contests the slot — the hold
    // still stands until the user picks.
    const second = await restore([snapshot]);

    const args = second.get("b");
    expect(args?.restoreRecovery).toEqual({ reason: "sibling-owns-session-id" });
    expect(args?.command).not.toContain("resume");
    expect(args?.cwd).toBe("/worktrees/task-b");
    expect(args?.conversationCwd).toBe("/repo");
    expect(resolveResumeLatestSession).not.toHaveBeenCalled();
  });

  it("asks where to run a pane filed under a worktree this project no longer has", async () => {
    const byId = await restore([
      movedPane("a", { worktreeId: "/worktrees/deleted", agentSessionId: "sess-a" }),
    ]);

    expect(byId.get("a")?.restoreRecovery).toEqual({
      reason: "destination-unavailable",
      sessionId: "sess-a",
      awaitingDestination: true,
    });
    expect(byId.get("a")?.cwd).toBe("/repo");
    // Shown under a worktree that exists, which is not where it will run.
    expect(byId.get("a")?.worktreeId).toBe("/repo");
  });

  it("leaves Claude panes exactly as restore always launched them", async () => {
    const byId = await restore([
      movedPane("a", { launchAgentId: "claude", agentSessionId: "sess-c", agentLaunchFlags: [] }),
    ]);

    expect(byId.get("a")?.cwd).toBe("/repo");
    expect(byId.get("a")?.command).toMatch(/--resume sess-c$/);
    expect(byId.get("a")?.conversationCwd).toBeUndefined();
    expect(byId.get("a")?.restoreRecovery).toBeUndefined();
  });
});
