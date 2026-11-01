/**
 * #12434 acceptance scenarios end to end through the real respawn builder and
 * the real agent registry: what each restored pane is actually launched with,
 * or that it is held instead. `panelRestorePhase.test.ts` covers the decisions
 * with a stubbed builder; this is what those decisions turn into.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendTerminalInfo, TerminalState } from "@shared/types/ipc/terminal";
import type { WorktreeState } from "@shared/types";
import type { PtyPanelData } from "@shared/types/panel";
import type { CodexRestoreMatchRequest } from "@shared/types/ipc/agentSubagents";
import { createHash } from "crypto";
import { launchPromptArgText } from "@shared/types/agentSettings";

vi.mock("@/utils/logger", () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = { initializeBackendTier: vi.fn(), setTargetSize: vi.fn() };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

const resolveResumeLatestSession = vi.hoisted(() =>
  vi.fn(async (_payload: { cwd: string }): Promise<string | null> => null)
);
// Stands in for main's prompt match (#15269): answers a pane asking for its
// conversation with the thread whose first message has the pane's digest.
const threadsByPromptHash = vi.hoisted(() => new Map<string, string>());
const matchRestoreSessions = vi.hoisted(() =>
  vi.fn(async (request: CodexRestoreMatchRequest) => ({
    matches: request.scopes.flatMap((scope) =>
      scope.panes.flatMap((pane) => {
        const sessionId = threadsByPromptHash.get(pane.promptHash);
        return pane.resolve && sessionId !== undefined ? [{ key: pane.key, sessionId }] : [];
      })
    ),
  }))
);
vi.mock("@/clients/codexClient", () => ({
  codexClient: { resolveResumeLatestSession, matchRestoreSessions },
}));

vi.mock("../reconnectManager", () => ({
  reconnectWithTimeout: async () => ({ status: "not_found" }),
}));

vi.mock("@/utils/agentLaunchCommand", () => ({
  getCurrentLaunchCliDetail: async () => undefined,
  resolveAgentLaunchBaseCommand: (registryCommand: string) => registryCommand,
}));

vi.mock("@/config/agents", async () => {
  const registry = await vi.importActual<typeof import("@shared/config/agentRegistry")>(
    "@shared/config/agentRegistry"
  );
  return {
    isRegisteredAgent: (id: string) => registry.getAgentConfig(id) !== undefined,
    getAgentConfig: (id: string) => ({
      command: registry.getAgentConfig(id)?.command ?? id,
      name: id,
    }),
    getMergedPreset: () => undefined,
    sanitizeAgentEnv: (env: Record<string, unknown> | undefined) => {
      if (!env) return undefined;
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string") result[key] = value;
      }
      return Object.keys(result).length > 0 ? result : undefined;
    },
  };
});

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

async function restore(
  panels: TerminalState[],
  overrides: Partial<RestoreContext> = {}
): Promise<Map<string, RestoredArgs>> {
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
    ...overrides,
  });
  return byId;
}

beforeEach(() => {
  resolveResumeLatestSession.mockReset();
  resolveResumeLatestSession.mockResolvedValue(null);
  matchRestoreSessions.mockClear();
  threadsByPromptHash.clear();
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

  it("keeps a pane waiting for a destination visible across another restart", async () => {
    // Saved while waiting, filed under a worktree that's gone, with nothing
    // selected to re-home onto.
    const byId = await restore(
      [
        movedPane("a", {
          worktreeId: "/worktrees/deleted",
          command: "codex",
          restoreRecovery: { reason: "destination-unavailable", awaitingDestination: true },
        }),
      ],
      { activeWorktreeId: null }
    );

    expect(byId.get("a")?.restoreRecovery).toEqual({
      reason: "destination-unavailable",
      awaitingDestination: true,
    });
    expect(byId.get("a")?.cwd).toBe("/repo");
    expect(byId.get("a")?.worktreeId).toBe("/repo");
  });

  it("falls back to the main worktree when the pane's folder is under none", async () => {
    const byId = await restore(
      [
        movedPane("a", {
          cwd: "/elsewhere/gone",
          worktreeId: "/worktrees/deleted",
          conversationCwd: "/elsewhere/origin",
          agentSessionId: "sess-a",
        }),
      ],
      { activeWorktreeId: null }
    );

    expect(byId.get("a")?.restoreRecovery?.awaitingDestination).toBe(true);
    expect(byId.get("a")?.cwd).toBe("/elsewhere/origin");
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

describe("the resume-on-restart setting through restore (#13509)", () => {
  const claudePane = (name: string, overrides: Partial<TerminalState> = {}): TerminalState => ({
    id: name,
    title: `Claude ${name}`,
    kind: "terminal",
    launchAgentId: "claude",
    cwd: "/repo",
    worktreeId: "/repo",
    location: "grid",
    ...overrides,
  });

  function persistHeld(id: string, args: RestoredArgs | undefined): TerminalState {
    const panel: PtyPanelData = {
      id,
      kind: "terminal",
      title: args?.title ?? id,
      location: "grid",
      cols: 80,
      rows: 24,
      cwd: args?.cwd ?? "",
      worktreeId: args?.worktreeId,
      launchAgentId: "claude",
      command: args?.command,
      agentLaunchFlags: args?.agentLaunchFlags,
      restoreRecovery: args?.restoreRecovery,
      hasPty: false,
    };
    return {
      id,
      title: panel.title,
      location: "grid",
      kind: "terminal",
      worktreeId: panel.worktreeId,
      ...serializePtyPanel(panel),
    };
  }

  it("holds every agent pane under never and keeps each conversation across a second restart", async () => {
    const agentSettings = { agents: { claude: {} }, resumeOnRestart: "never" as const };
    const first = await restore([claudePane("a", { agentSessionId: "sess-a" }), claudePane("b")], {
      agentSettings,
    });

    expect(first.get("a")?.restoreRecovery).toEqual({
      reason: "resume-deferred",
      sessionId: "sess-a",
    });
    expect(first.get("a")?.command).not.toContain("--resume");
    expect(first.get("b")?.restoreRecovery).toEqual({ reason: "resume-deferred" });

    // Even with the setting switched back, a held pane waits for the user.
    const second = await restore([persistHeld("a", first.get("a"))], {
      agentSettings: { agents: { claude: {} }, resumeOnRestart: "always" },
    });

    expect(second.get("a")?.restoreRecovery).toEqual({
      reason: "resume-deferred",
      sessionId: "sess-a",
    });
    expect(second.get("a")?.command).not.toContain("--resume");
    expect(second.get("a")?.agentSessionId).toBeUndefined();
  });

  it("resumes as before when the setting is absent", async () => {
    const byId = await restore([claudePane("a", { agentSessionId: "sess-a" })], {
      agentSettings: { agents: { claude: {} } },
    });

    expect(byId.get("a")?.restoreRecovery).toBeUndefined();
    expect(byId.get("a")?.command).toContain("--resume");
  });
});

describe("cold restore of agents that resume by history alone (#13847)", () => {
  const pane = (id: string, launchAgentId: string, overrides: Partial<TerminalState> = {}) =>
    movedPane(id, { launchAgentId, worktreeId: "/repo", agentLaunchFlags: [], ...overrides });

  it("reopens each lone pane's latest conversation in its own folder", async () => {
    const byId = await restore([pane("k", "kimi"), pane("c", "cursor")]);

    expect(byId.get("k")?.command).toBe("kimi --continue");
    expect(byId.get("c")?.command).toBe("cursor-agent --continue");
    for (const id of ["k", "c"]) {
      expect(byId.get(id)?.sessionLostOnRestore).toBeUndefined();
      expect(byId.get(id)?.restoreRecovery).toBeUndefined();
    }
  });

  it("gives the folder's latest to one pane and starts its sibling fresh", async () => {
    const byId = await restore([
      pane("old", "kimi", { lastActiveAt: 1 }),
      pane("new", "kimi", { lastActiveAt: 2 }),
    ]);

    expect(byId.get("new")?.command).toBe("kimi --continue");
    expect(byId.get("old")?.command).not.toContain("--continue");
    expect(byId.get("old")?.sessionLostOnRestore).toBe("sibling-owns-resume-latest-slot");
  });

  it("reopens Open Interpreter's latest session in its folder when no id was captured", async () => {
    const byId = await restore([pane("i", "interpreter")]);

    expect(byId.get("i")?.command).toBe("interpreter resume --last");
    expect(byId.get("i")?.command).not.toContain("--conversations");
    expect(byId.get("i")?.sessionLostOnRestore).toBeUndefined();
  });

  it("keeps Aider's auto-commits off when a deleted preset voids its captured flags", async () => {
    const byId = await restore([
      pane("a", "aider", {
        agentLaunchFlags: ["--no-auto-commits", "--model", "sonnet"],
        agentPresetId: "deleted-preset",
      }),
    ]);

    expect(byId.get("a")?.command).toMatch(/^aider --no-auto-commits .*--restore-chat-history$/);
  });
});

describe("restore provenance through restore (#14017)", () => {
  const claudePane = (name: string, overrides: Partial<TerminalState> = {}): TerminalState => ({
    id: name,
    title: `Claude ${name}`,
    kind: "terminal",
    launchAgentId: "claude",
    cwd: "/repo",
    worktreeId: "/repo",
    location: "grid",
    ...overrides,
  });

  it("stamps every pane one pass rebuilds with that pass's time and its own route", async () => {
    let now = 50_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now++);
    try {
      const byId = await restore(
        [
          claudePane("a", {
            agentSessionId: "sess-a",
            lastAgentObservation: { agentState: "idle", at: 40_000 },
          }),
          claudePane("b", {
            agentSessionId: "sess-b",
            launchedByPluginId: "acme.orchestrator",
            holdOnRestart: true,
          }),
        ],
        { agentSettings: { agents: { claude: {} } } }
      );

      const a = byId.get("a")?.restoreProvenance;
      const b = byId.get("b")?.restoreProvenance;
      expect(a).toEqual({
        at: a?.at,
        disposition: "resume",
        lastSeen: { agentState: "idle", at: 40_000 },
      });
      expect(b?.disposition).toBe("held");
      expect(b?.at).toBe(a?.at);
      expect(byId.get("b")?.restoreRecovery).toEqual({
        reason: "held-by-plugin",
        sessionId: "sess-b",
      });
      expect(byId.get("b")).toMatchObject({
        launchedByPluginId: "acme.orchestrator",
        holdOnRestart: true,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps a surviving PTY's provenance and invents none for one restore never rebuilt", async () => {
    const provenance = { at: 30_000, disposition: "resume" as const };
    const live = (id: string): BackendTerminalInfo => ({
      id,
      cwd: "/repo",
      kind: "terminal",
      launchAgentId: "claude",
      spawnedAt: 0,
      hasPty: true,
    });

    const byId = await restore(
      [claudePane("rebuilt", { restoreProvenance: provenance }), claudePane("never")],
      {
        agentSettings: { agents: { claude: {} } },
        backendTerminalMap: new Map([
          ["rebuilt", live("rebuilt")],
          ["never", live("never")],
        ]),
      }
    );

    expect(byId.get("rebuilt")?.existingId).toBe("rebuilt");
    expect(byId.get("rebuilt")?.restoreProvenance).toEqual(provenance);
    expect(byId.get("never")?.restoreProvenance).toBeUndefined();
  });
});

describe("held same-folder Codex panes named by their launch prompts (#15269)", () => {
  const AT = 1_800_000_000_000;

  /** Main has a thread in /repo whose first message is `prompt`. */
  function threadFor(prompt: string, sessionId: string): void {
    threadsByPromptHash.set(
      createHash("sha256").update(launchPromptArgText(prompt), "utf8").digest("hex"),
      sessionId
    );
  }

  const codexPane = (name: string, prompt?: string, overrides: Partial<TerminalState> = {}) =>
    ({
      id: name,
      title: `Codex ${name}`,
      kind: "terminal",
      launchAgentId: "codex",
      cwd: "/repo",
      worktreeId: "/repo",
      location: "grid",
      ...(prompt !== undefined && { firstPrompt: { text: prompt, via: "launch", at: AT } }),
      ...overrides,
    }) as TerminalState;

  const coldProbe = (panels: TerminalState[]) => ({
    prefetchedReconnectResults: Object.fromEntries(
      panels.map((saved) => [saved.id, { exists: false }])
    ),
  });

  /** Five panes that kept their ids, plus `extra`, all in one folder. */
  function quitWithLostIds(extra: TerminalState[]): TerminalState[] {
    return [
      ...TASKS.map((t) => codexPane(`kept-${t}`, undefined, { agentSessionId: `sess-kept-${t}` })),
      ...extra,
    ];
  }

  function persist(id: string, args: RestoredArgs | undefined): TerminalState {
    const panel: PtyPanelData = {
      id,
      kind: "terminal",
      title: args?.title ?? id,
      location: "grid",
      cols: 80,
      rows: 24,
      cwd: args?.cwd ?? "",
      worktreeId: args?.worktreeId,
      launchAgentId: "codex",
      command: args?.command,
      agentLaunchFlags: args?.agentLaunchFlags,
      restoreRecovery: args?.restoreRecovery,
      firstPrompt: args?.firstPrompt,
      hasPty: false,
    };
    return {
      id,
      title: panel.title,
      location: "grid",
      kind: "terminal",
      worktreeId: panel.worktreeId,
      ...serializePtyPanel(panel),
    };
  }

  it("resumes each pane whose prompt names its thread, and holds the one that names none", async () => {
    threadFor("Triage the parser", "sess-parser");
    threadFor("Triage the renderer\nwith care", "sess-renderer");
    const panels = quitWithLostIds([
      codexPane("parser", "Triage the parser"),
      codexPane("renderer", "Triage the renderer\nwith care"),
      codexPane("docs", "Triage the docs"),
    ]);

    const byId = await restore(panels, coldProbe(panels));

    for (const [name, sessionId] of [
      ["parser", "sess-parser"],
      ["renderer", "sess-renderer"],
    ] as const) {
      const args = byId.get(name);
      expect(args?.command).toMatch(new RegExp(`^codex .*resume ${sessionId} -C \\S+$`));
      expect(args?.agentSessionId).toBe(sessionId);
      expect(args?.restoreRecovery).toBeUndefined();
      // The run its first prompt belongs to carries on.
      expect(args?.firstPrompt?.text).toBeDefined();
    }
    const docs = byId.get("docs");
    expect(docs?.restoreRecovery).toEqual({ reason: "sibling-owns-resume-latest-slot" });
    expect(docs?.command).not.toContain("resume");
    for (const t of TASKS) {
      expect(byId.get(`kept-${t}`)?.agentSessionId).toBe(`sess-kept-${t}`);
    }
    expect(matchRestoreSessions).toHaveBeenCalledTimes(1);
  });

  it("names a pane a previous restore held, so an upgrade clears the backlog", async () => {
    const first = await restore(
      quitWithLostIds([codexPane("parser", "Triage the parser")]),
      // A build without the match: nothing comes back named.
      { prefetchedReconnectResults: undefined }
    );
    expect(first.get("parser")?.restoreRecovery).toEqual({
      reason: "sibling-owns-resume-latest-slot",
    });

    threadFor("Triage the parser", "sess-parser");
    const again = [persist("parser", first.get("parser"))];
    const second = await restore(again, coldProbe(again));

    expect(second.get("parser")?.command).toMatch(/resume sess-parser -C \S+$/);
    expect(second.get("parser")?.restoreRecovery).toBeUndefined();
  });

  it("keeps a named conversation on the hold when restarts are set not to resume", async () => {
    threadFor("Triage the parser", "sess-parser");
    const panels = quitWithLostIds([codexPane("parser", "Triage the parser")]);

    const byId = await restore(panels, {
      ...coldProbe(panels),
      agentSettings: { agents: { codex: {} }, resumeOnRestart: "never" },
    });

    expect(byId.get("parser")?.restoreRecovery).toEqual({
      reason: "resume-deferred",
      sessionId: "sess-parser",
    });
    expect(byId.get("parser")?.command).not.toContain("resume");
  });
});

describe("restore of a pane saved showing its exit (#15941)", () => {
  it("brings a plain terminal back exited instead of starting it again", async () => {
    const snapshot = serializePtyPanel({
      id: "dev",
      kind: "terminal",
      title: "Dev server",
      cwd: "/repo",
      location: "grid",
      command: "npm run dev",
      runtimeStatus: "exited",
      exitCode: 3,
    } as PtyPanelData);

    const byId = await restore([
      { id: "dev", title: "Dev server", kind: "terminal", location: "grid", ...snapshot },
    ]);

    expect(byId.get("dev")).toMatchObject({ requestedId: "dev", restoredExitCode: 3 });
  });

  it.each([
    ["dock", "dock", undefined],
    ["background", "background", "dock"],
  ] as const)(
    "brings one saved in the %s back exited where it was",
    async (_label, location, backgroundRestoreLocation) => {
      const snapshot = serializePtyPanel({
        id: "dev",
        kind: "terminal",
        title: "Dev server",
        cwd: "/repo",
        location,
        runtimeStatus: "exited",
        exitCode: 1,
      } as PtyPanelData);

      const byId = await restore([
        {
          id: "dev",
          title: "Dev server",
          kind: "terminal",
          location,
          ...(backgroundRestoreLocation && { backgroundRestoreLocation }),
          ...snapshot,
        },
      ]);

      expect(byId.get("dev")).toMatchObject({ location, restoredExitCode: 1 });
    }
  );

  it("keeps a shell that once ran an agent a plain exited shell", async () => {
    const snapshot = serializePtyPanel({
      id: "dev",
      kind: "terminal",
      title: "zsh",
      cwd: "/repo",
      location: "grid",
      everDetectedAgent: true,
      runtimeStatus: "exited",
      exitCode: 0,
    } as PtyPanelData);

    const byId = await restore([
      { id: "dev", title: "zsh", kind: "terminal", location: "grid", ...snapshot },
    ]);

    expect(byId.get("dev")?.launchAgentId).toBeUndefined();
    expect(byId.get("dev")?.restoredExitCode).toBe(0);
  });

  it("reattaches to a host record with no process left, showing the saved exit", async () => {
    const snapshot = serializePtyPanel({
      id: "dev",
      kind: "terminal",
      title: "zsh",
      cwd: "/repo",
      location: "grid",
      everDetectedAgent: true,
      runtimeStatus: "exited",
      exitCode: 0,
    } as PtyPanelData);
    const record: BackendTerminalInfo = {
      id: "dev",
      kind: "terminal",
      cwd: "/repo",
      spawnedAt: 1,
      hasPty: false,
      everDetectedAgent: true,
    };

    const byId = await restore(
      [{ id: "dev", title: "zsh", kind: "terminal", location: "grid", ...snapshot }],
      { backendTerminalMap: new Map([["dev", record]]) }
    );

    expect(byId.get("dev")).toMatchObject({ existingId: "dev", restoredExitCode: 0 });
  });

  it("starts a terminal saved while it ran, as before", async () => {
    const snapshot = serializePtyPanel({
      id: "dev",
      kind: "terminal",
      title: "Dev server",
      cwd: "/repo",
      location: "grid",
      command: "npm run dev",
      runtimeStatus: "running",
    } as PtyPanelData);

    const byId = await restore([
      { id: "dev", title: "Dev server", kind: "terminal", location: "grid", ...snapshot },
    ]);

    expect(byId.get("dev")?.restoredExitCode).toBeUndefined();
    expect(byId.get("dev")?.command).toBe("npm run dev");
  });
});
