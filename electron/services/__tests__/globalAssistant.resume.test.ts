import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HelpPastSessionsListing } from "../../../shared/types/ipc/help.js";

vi.mock("electron", () => ({ app: { getPath: () => "/user-data" } }));
vi.mock("../agentDefaults.js", () => ({ onAgentDefaultsChanged: () => () => {} }));
vi.mock("../../store.js", () => ({ store: { get: () => undefined, set: () => {} } }));

/** The help service as the sessions see it: each slot's pointer, and what a switch wrote. */
const help = vi.hoisted(() => ({
  pointers: new Map<number, { agentId: string; agentSessionId: string }>(),
  provisioned: [] as Array<{ slot: number; agentId: string; switchingTo?: unknown }>,
  revoked: [] as Array<{ sessionId: string; capture: boolean }>,
  confirmed: [] as string[],
  work: new Map<number, string>(),
  spawnOk: true,
  spawnGate: null as Promise<void> | null,
  spawned: [] as Array<Record<string, unknown>>,
  flags: [] as string[],
}));
const lister = vi.hoisted(() => ({
  listHelpPastSessions: vi.fn(),
  defaultClaudeProjectsRoot: () => "/home/.claude/projects",
}));
vi.mock("../helpPastSessions.js", () => lister);
vi.mock("../claude/ClaudeSessionStore.js", () => ({ resolvePaneClaudeProjectsRoot: () => null }));
vi.mock("../codex/CodexSubagentService.js", () => ({ listCodexSessionsForCwd: vi.fn() }));
vi.mock("../HelpSessionService.js", () => ({
  helpSessionService: {
    whenPendingHibernationStoreWired: async () => true,
    pendingHibernationStoreReady: async () => {},
    peekPendingHibernation: (_projectId: string, slot: number) => {
      const pointer = help.pointers.get(slot);
      return pointer ? { ...pointer, cwd: "/g", panelWasOpen: false } : null;
    },
    takePendingHibernation: async (_projectId: string, slot: number) => {
      const pointer = help.pointers.get(slot);
      return pointer ? { ...pointer, cwd: "/g", claimId: `c-${slot}` } : null;
    },
    restorePendingHibernation: async () => true,
    discardConversation: async (_projectId: string, slot: number) => {
      help.pointers.delete(slot);
    },
    provisionSession: async (input: { slot: number; agentId: string; switchingTo?: unknown }) => {
      help.provisioned.push({
        slot: input.slot,
        agentId: input.agentId,
        ...(input.switchingTo ? { switchingTo: input.switchingTo } : {}),
      });
      return {
        sessionId: `s-${input.slot}-${help.provisioned.length}`,
        sessionPath: "/g",
        token: "t",
        mcpUrl: null,
      };
    },
    revokeSession: async (sessionId: string, options?: { captureHibernation?: boolean }) => {
      help.revoked.push({ sessionId, capture: options?.captureHibernation === true });
    },
    confirmLaneSwitch: async (sessionId: string) => {
      help.confirmed.push(sessionId);
    },
    laneWorkOwnershipId: (_projectId: string, slot: number) => help.work.get(slot),
    getLaneCoordinator: () => null,
    setLaneCoordinator: async () => {},
    getSessionPathForProject: (projectPath: string, agentId: string) =>
      agentId === "claude" ? `${projectPath}#h` : `${projectPath}#h.${agentId}`,
    getLegacySessionPathForProject: (projectPath: string) => `${projectPath}#h`,
  },
}));
vi.mock("../assistants/assistantLaunch.js", () => ({
  liveAssistantLaunchDeps: async () => ({
    launchableAgents: async () => [
      { id: "claude", byDefault: true },
      { id: "codex", byDefault: true },
      { id: "antigravity", byDefault: true },
    ],
    launchFlags: async () => help.flags,
  }),
  firstUsableDefault: async () => "claude",
  spawnAndConfirm: async (_pty: unknown, spawn: () => Promise<unknown>) => {
    await spawn();
    await help.spawnGate;
    return help.spawnOk;
  },
}));
vi.mock("../viewless/index.js", () => ({
  spawnHostAssistantLive: async (_project: unknown, spec: Record<string, unknown>) => {
    help.spawned.push(spec);
    return true;
  },
}));
vi.mock("../../window/serviceRefs.js", () => ({
  getPtyClient: () => ({ on: () => {}, kill: () => {}, cancelPendingInput: () => {} }),
}));
vi.mock("../../window/windowRef.js", () => ({ getWindowRegistry: () => null }));

type Registry = typeof import("../globalAssistant.js");
let registry: Registry;

const listing = (...ids: string[]): HelpPastSessionsListing => ({
  sessions: ids.map((sessionId, i) => ({
    agentId: "claude",
    sessionId,
    title: `Talk ${sessionId}`,
    updatedAt: 100 - i,
  })),
  unreadable: [],
  truncated: false,
});

beforeEach(async () => {
  help.pointers.clear();
  help.provisioned = [];
  help.revoked = [];
  help.confirmed = [];
  help.work.clear();
  help.spawnOk = true;
  help.spawnGate = null;
  help.spawned = [];
  help.flags = [];
  lister.listHelpPastSessions.mockReset();
  lister.listHelpPastSessions.mockResolvedValue(listing("conv-a", "conv-c"));
  vi.resetModules();
  registry = await import("../globalAssistant.js");
});

/** Slot 0 running on Claude's `conv-b`, its work held under `work-b`. */
async function seatRunning() {
  help.pointers.set(0, { agentId: "claude", agentSessionId: "conv-b" });
  help.work.set(0, "work-b");
  const service = registry.getGlobalAssistantService(0);
  await service.ensureSession();
  return service;
}

describe("listGlobalAssistantPastSessions (#18169)", () => {
  it("reads the running agent's history under the global folder, less what either session holds", async () => {
    await seatRunning();
    help.pointers.set(1, { agentId: "claude", agentSessionId: "conv-other" });

    const result = await registry.listGlobalAssistantPastSessions(0);

    expect(result).toMatchObject({ slot: 0, agentId: "claude" });
    expect(result.sessions.map((row) => row.sessionId)).toEqual(["conv-a", "conv-c"]);
    const [paths, , options] = lister.listHelpPastSessions.mock.calls[0]!;
    expect(paths).toEqual({
      claude: "/user-data/global-assistant#h",
      codex: ["/user-data/global-assistant#h.codex", "/user-data/global-assistant#h"],
    });
    expect(options.agentId).toBe("claude");
    expect([...options.exclude].sort()).toEqual(["conv-b", "conv-other"]);
  });

  it("leaves out nothing kept on another agent", async () => {
    await seatRunning();
    help.pointers.set(1, { agentId: "codex", agentSessionId: "thread-1" });
    await registry.listGlobalAssistantPastSessions(0);
    expect([...lister.listHelpPastSessions.mock.calls[0]![2].exclude]).toEqual(["conv-b"]);
  });

  it("lists nothing for an agent whose transcripts it can't read", async () => {
    const result = await registry.listGlobalAssistantPastSessions(1);
    // A second session with no agent of its own has nothing to list either.
    expect(result).toEqual({
      slot: 1,
      agentId: null,
      sessions: [],
      unreadable: [],
      truncated: false,
    });
    expect(lister.listHelpPastSessions).not.toHaveBeenCalled();
  });
});

describe("resumeGlobalAssistantConversation (#18169)", () => {
  it("stops the run, keeping its conversation, and reopens the choice with the seat's work", async () => {
    const service = await seatRunning();
    const before = service.getState();

    await registry.resumeGlobalAssistantConversation(0, "conv-a", {
      generation: before.generation,
      phase: "running",
    });
    await vi.waitFor(() => expect(service.getState().phase).toBe("running"));

    expect(help.revoked).toEqual([{ sessionId: "s-0-1", capture: true }]);
    expect(help.pointers.get(0)?.agentSessionId).toBe("conv-b");
    expect(help.provisioned.at(-1)).toEqual({
      slot: 0,
      agentId: "claude",
      switchingTo: { agentSessionId: "conv-a", work: "work-b" },
    });
    expect(help.spawned.at(-1)).toMatchObject({
      resumeAgentSessionId: "conv-a",
      exactResume: true,
    });
    expect(help.confirmed).toEqual(["s-0-2"]);
  });

  it("reopens nothing main doesn't list for the session now, stopping nothing", async () => {
    const service = await seatRunning();
    await expect(
      registry.resumeGlobalAssistantConversation(0, "conv-forged", {
        generation: service.getState().generation,
        phase: "running",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(help.revoked).toEqual([]);
  });

  it("refuses launch flags that would fork the conversation, before stopping anything", async () => {
    const service = await seatRunning();
    help.flags = ["--fork-session"];
    await expect(
      registry.resumeGlobalAssistantConversation(0, "conv-a", {
        generation: service.getState().generation,
        phase: "running",
      })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(help.revoked).toEqual([]);
  });

  it("refuses while the other session runs a conversation on the agent it can't name yet", async () => {
    const service = await seatRunning();
    help.pointers.set(1, { agentId: "claude", agentSessionId: "" });
    // Started fresh on Claude: its pointer names no conversation yet.
    await registry.getGlobalAssistantService(1).ensureSession();

    await expect(
      registry.resumeGlobalAssistantConversation(0, "conv-a", {
        generation: service.getState().generation,
        phase: "running",
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(help.revoked).toEqual([]);
  });

  it("keeps the conversation one session is switching to out of the other's reach", async () => {
    const service = await seatRunning();
    let release!: () => void;
    help.spawnGate = new Promise((resolve) => {
      release = resolve;
    });
    const switching = registry.resumeGlobalAssistantConversation(0, "conv-a", {
      generation: service.getState().generation,
      phase: "running",
    });
    await vi.waitFor(() => expect(help.spawned).toHaveLength(2));

    // The second session keeps a Claude conversation of its own for its next start.
    help.pointers.set(1, { agentId: "claude", agentSessionId: "conv-other" });
    lister.listHelpPastSessions.mockClear();
    await registry.listGlobalAssistantPastSessions(1);
    expect([...lister.listHelpPastSessions.mock.calls[0]![2].exclude]).toContain("conv-a");

    release();
    await switching;
  });
});
