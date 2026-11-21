import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));
vi.mock("../agentDefaults.js", () => ({ onAgentDefaultsChanged: () => () => {} }));

const disk = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock("../../store.js", () => ({
  store: {
    get: (key: string) => disk.values.get(key),
    set: (key: string, value: unknown) => disk.values.set(key, value),
  },
}));

/** The help service as the sessions see it: one kept pointer per slot, by agent. */
const help = vi.hoisted(() => ({
  kept: new Map<number, string>(),
  wired: true,
  /** Every pointer call, by the slot it named. */
  pointer: [] as string[],
  spawnOk: true,
  provisioned: [] as Array<{ slot: number; agentId: string }>,
  revoked: [] as Array<{ sessionId: string; capture: boolean }>,
}));
vi.mock("../HelpSessionService.js", () => ({
  helpSessionService: {
    whenPendingHibernationStoreWired: async () => help.wired,
    peekPendingHibernation: (_projectId: string, slot: number) => {
      const agentId = help.kept.get(slot);
      return agentId ? { agentId, agentSessionId: "conv", cwd: "/g", panelWasOpen: false } : null;
    },
    takePendingHibernation: async (_projectId: string, slot: number) => {
      help.pointer.push(`take-${slot}`);
      const agentId = help.kept.get(slot);
      return agentId
        ? { agentId, agentSessionId: `conv-${slot}`, cwd: "/g", claimId: `c-${slot}` }
        : null;
    },
    restorePendingHibernation: async (_projectId: string, slot: number) => {
      help.pointer.push(`restore-${slot}`);
      return true;
    },
    discardConversation: async (_projectId: string, slot: number) => {
      help.pointer.push(`discard-${slot}`);
      help.kept.delete(slot);
    },
    provisionSession: async (input: { slot: number; agentId: string }) => {
      help.provisioned.push({ slot: input.slot, agentId: input.agentId });
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
  },
}));
vi.mock("../assistants/assistantLaunch.js", () => ({
  liveAssistantLaunchDeps: async () => ({
    launchableAgents: async () => [
      { id: "claude", byDefault: true },
      { id: "codex", byDefault: true },
      { id: "antigravity", byDefault: true },
      { id: "copilot", byDefault: false },
    ],
    launchFlags: async () => [],
  }),
  firstUsableDefault: async () => "claude",
  spawnAndConfirm: async () => help.spawnOk,
}));
vi.mock("../viewless/index.js", () => ({ spawnHostAssistantLive: async () => ({}) }));
vi.mock("../../window/serviceRefs.js", () => ({
  getPtyClient: () => ({ on: () => {}, kill: () => {}, cancelPendingInput: () => {} }),
}));
vi.mock("../../window/windowRef.js", () => ({ getWindowRegistry: () => null }));

type Registry = typeof import("../globalAssistant.js");
let registry: Registry;
const usable = async () => true;

beforeEach(async () => {
  disk.values.clear();
  help.kept.clear();
  help.wired = true;
  help.pointer = [];
  help.spawnOk = true;
  help.provisioned = [];
  help.revoked = [];
  vi.resetModules();
  registry = await import("../globalAssistant.js");
});

const LIMIT = "This machine already has two global assistant sessions. Stop one to start another.";

describe("global assistant sessions (#18142)", () => {
  it("starts a new session beside a running first one, and refuses a third with the reason", async () => {
    await registry.getGlobalAssistantService(0).ensureSession();

    const second = await registry.startNewGlobalAssistantSession("codex", usable);
    expect(second.slot).toBe(1);
    await registry.joinNewGlobalAssistantLaunch(1, second.getState().generation);
    expect(second.getState()).toMatchObject({ phase: "running", agentId: "codex" });
    expect(help.provisioned).toEqual([
      { slot: 0, agentId: "claude" },
      { slot: 1, agentId: "codex" },
    ]);

    await expect(
      registry.startNewGlobalAssistantSession("antigravity", usable)
    ).rejects.toMatchObject({ code: "VALIDATION", userMessage: LIMIT });
    expect(help.provisioned).toHaveLength(2);
  });

  it("counts a session that keeps a conversation, and uses a first one stopped for good", async () => {
    help.kept.set(0, "claude");
    const first = await registry.startNewGlobalAssistantSession("codex", usable);
    expect(first.slot).toBe(1);

    help.kept.clear();
    await registry.getGlobalAssistantService(1).discard();
    await registry.getGlobalAssistantService(0).discard();
    help.kept.set(1, "codex");
    const reused = await registry.startNewGlobalAssistantSession("antigravity", usable);
    expect(reused.slot).toBe(0);
    expect(reused.getState().pinnedAgentId).toBe("antigravity");
  });

  it("gives two windows asking at once two sessions, and the third the reason", async () => {
    const results = await Promise.allSettled([
      registry.startNewGlobalAssistantSession("codex", usable),
      registry.startNewGlobalAssistantSession("claude", usable),
      registry.startNewGlobalAssistantSession("antigravity", usable),
    ]);
    const slots = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value.slot] : []
    );
    expect(slots.sort()).toEqual([0, 1]);
    const refused = results.filter((result) => result.status === "rejected");
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ userMessage: LIMIT });
  });

  it("refuses an agent it doesn't offer, or one that can't run here, naming it", async () => {
    await expect(registry.startNewGlobalAssistantSession("copilot", usable)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    await expect(
      registry.startNewGlobalAssistantSession("codex", async () => false)
    ).rejects.toMatchObject({ code: "UNSUPPORTED", userMessage: expect.stringContaining("Codex") });
    expect(registry.getGlobalAssistantServices().some((s) => s.isOccupied())).toBe(false);
  });

  it("joins only the launch it began: one that failed is said, never started again", async () => {
    help.spawnOk = false;
    const service = await registry.startNewGlobalAssistantSession("codex", usable);
    const generation = service.getState().generation;
    await expect(
      registry.joinNewGlobalAssistantLaunch(service.slot, generation)
    ).rejects.toMatchObject({ code: "INTERNAL" });

    help.spawnOk = true;
    const provisions = help.provisioned.length;
    // A late join, or one for a launch since replaced, starts nothing.
    await expect(
      registry.joinNewGlobalAssistantLaunch(service.slot, generation)
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(help.provisioned).toHaveLength(provisions);
  });

  it("keeps each session's chosen agent across a restart of the app until it is stopped", async () => {
    const service = await registry.startNewGlobalAssistantSession("codex", usable);
    await registry.joinNewGlobalAssistantLaunch(service.slot, service.getState().generation);
    expect(disk.values.get("globalAssistantPinnedAgents")).toEqual({ "0": "codex" });

    vi.resetModules();
    const restarted = await import("../globalAssistant.js");
    expect(restarted.getGlobalAssistantService(0).getState()).toMatchObject({
      pinnedAgentId: "codex",
      agentId: "codex",
      occupied: true,
    });
    expect(restarted.getGlobalAssistantService(1).getState().pinnedAgentId).toBeNull();

    await restarted.getGlobalAssistantService(0).discard();
    expect(disk.values.get("globalAssistantPinnedAgents")).toEqual({});
  });

  it("brings a second session's conversation back on its agent when its choice was lost", async () => {
    help.kept.set(1, "codex");
    const state = await registry.getGlobalAssistantService(1).ensureSession();
    expect(state).toMatchObject({ phase: "running", agentId: "codex" });
  });

  it("captures every session at quit, and starts none after", async () => {
    await registry.getGlobalAssistantService(0).ensureSession();
    const second = await registry.startNewGlobalAssistantSession("codex", usable);
    await registry.joinNewGlobalAssistantLaunch(second.slot, second.getState().generation);

    await registry.beginGlobalAssistantShutdown();
    expect(
      help.revoked
        .filter((r) => r.capture)
        .map((r) => r.sessionId)
        .sort()
    ).toEqual(["s-0-1", "s-1-2"]);
    await expect(registry.startNewGlobalAssistantSession("claude", usable)).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });

  it("drops a closing window's readers from every session", async () => {
    const [first, second] = registry.getGlobalAssistantServices();
    first!.attach(10, 1);
    second!.attach(10, 1);
    second!.attach(20, 2);
    registry.detachGlobalAssistantWindow(1);
    expect(first!.getState().attachments).toEqual([]);
    expect(second!.getState().attachments.map((a) => a.windowId)).toEqual([2]);
  });

  it("touches only its own session's pointer when started, cleared or stopped", async () => {
    help.kept.set(0, "claude");
    help.kept.set(1, "codex");
    disk.values.set("globalAssistantPinnedAgents", { "1": "codex" });
    vi.resetModules();
    registry = await import("../globalAssistant.js");
    const [first, second] = registry.getGlobalAssistantServices();

    await second!.ensureSession();
    expect(help.pointer).toEqual(["take-1"]);
    await second!.restart();
    await second!.discard();
    expect(help.pointer).toEqual(["take-1", "discard-1", "discard-1"]);
    expect(help.kept.get(0)).toBe("claude");

    await first!.ensureSession();
    expect(help.pointer.at(-1)).toBe("take-0");
    expect(first!.getState().agentId).toBe("claude");
  });

  it("starts no new session before the kept conversations can be read", async () => {
    help.wired = false;
    await expect(registry.startNewGlobalAssistantSession("codex", usable)).rejects.toMatchObject({
      code: "UNSUPPORTED",
      userMessage: expect.stringContaining("still starting"),
    });
    expect(registry.getGlobalAssistantServices().some((s) => s.isOccupied())).toBe(false);
  });
});
