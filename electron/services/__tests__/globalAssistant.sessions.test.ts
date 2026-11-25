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
  /** The session chosen to coordinate, as the pointer file keeps it (#18143). */
  coordinator: null as number | null,
  /** Holds every spawn until released, so a launch can be caught in flight. */
  spawnGate: null as Promise<void> | null,
  /** Why the next handover is refused, as the help service would say it. */
  refuseHandOver: null as "starting" | "unheld" | null,
  /** The sessions kept running across restarts (#18177), and how each was last discarded. */
  keptRunning: new Set<number>(),
  discards: [] as Array<{ slot: number; keepRunningChoice: boolean }>,
}));
/** What each handover gave the MCP server to move, outgoing run first. */
const work = vi.hoisted(() => ({
  moved: [] as Array<{ from: string; to: { sessionId: string; terminalId: string } | null }>,
}));
vi.mock("../McpServerService.js", () => ({
  mcpServerService: {
    handOverGlobalAssistantWork: (
      from: string,
      to: { sessionId: string; terminalId: string } | null
    ) => work.moved.push({ from, to }),
  },
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
    discardConversation: async (
      _projectId: string,
      slot: number,
      options?: { keepRunningChoice?: boolean }
    ) => {
      help.pointer.push(`discard-${slot}`);
      help.kept.delete(slot);
      help.discards.push({ slot, keepRunningChoice: options?.keepRunningChoice === true });
      if (options?.keepRunningChoice !== true) help.keptRunning.delete(slot);
    },
    isLaneKeptRunning: (_projectId: string, slot: number) => help.keptRunning.has(slot),
    setLaneKeepRunning: async (_projectId: string, slot: number, keep: boolean) => {
      if (keep) help.keptRunning.add(slot);
      else help.keptRunning.delete(slot);
      return true;
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
    getLaneCoordinator: () => (help.wired ? help.coordinator : null),
    setLaneCoordinator: async (_projectId: string, slot: number) => {
      if (help.wired) help.coordinator = slot;
    },
    handOverLaneCoordination: (_projectId: string, from: number, to: number) => {
      if (help.refuseHandOver !== null) return { refused: help.refuseHandOver };
      help.pointer.push(`handover-${from}-${to}`);
      help.coordinator = to;
      return { written: Promise.resolve() };
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
  spawnAndConfirm: async () => {
    await help.spawnGate;
    return help.spawnOk;
  },
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
  help.coordinator = null;
  help.spawnGate = null;
  help.refuseHandOver = null;
  help.keptRunning.clear();
  help.discards = [];
  work.moved = [];
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

  it("keeps each session running across restarts on its own, through a clear but not a stop (#18177)", async () => {
    const [first, second] = registry.getGlobalAssistantServices();
    const heard: boolean[] = [];
    first!.onChange((state) => heard.push(state.keepRunning));

    await registry.setGlobalAssistantKeepRunning(0, true);
    expect([first!.getState().keepRunning, second!.getState().keepRunning]).toEqual([true, false]);
    // Every window hears it, the help service's own load aside.
    expect(heard.at(-1)).toBe(true);

    await first!.ensureSession();
    await first!.restart();
    expect(first!.getState().keepRunning).toBe(true);
    await first!.discard();
    expect(help.discards).toEqual([
      { slot: 0, keepRunningChoice: true },
      { slot: 0, keepRunningChoice: false },
    ]);
    expect(first!.getState().keepRunning).toBe(false);
  });

  it("starts no new session before the kept conversations can be read", async () => {
    help.wired = false;
    await expect(registry.startNewGlobalAssistantSession("codex", usable)).rejects.toMatchObject({
      code: "UNSUPPORTED",
      userMessage: expect.stringContaining("still starting"),
    });
    expect(registry.getGlobalAssistantServices().some((s) => s.isOccupied())).toBe(false);
  });

  describe("which session coordinates (#18143)", () => {
    const coordinating = () =>
      registry.getGlobalAssistantServices().map((service) => service.getState().coordinating);

    async function twoRunning() {
      const first = registry.getGlobalAssistantService(0);
      await first.ensureSession();
      const second = await registry.startNewGlobalAssistantSession("codex", usable);
      await registry.joinNewGlobalAssistantLaunch(1, second.getState().generation);
      return [first, second] as const;
    }

    function holdSpawns(): () => void {
      let release = () => {};
      help.spawnGate = new Promise<void>((resolve) => (release = resolve));
      return release;
    }

    it("keeps a lone session coordinating, and one started beside it never takes over", async () => {
      await registry.getGlobalAssistantService(0).ensureSession();
      expect(coordinating()).toEqual([true, false]);
      expect(help.coordinator).toBe(0);

      await twoRunning();

      expect(coordinating()).toEqual([true, false]);
      expect(help.coordinator).toBe(0);
    });

    it("hands coordination over as asked, with the work its run held, and leaves both runs be", async () => {
      const [first, second] = await twoRunning();
      const told: Array<[number, boolean]> = [];
      first.onChange((state) => told.push([0, state.coordinating]));
      second.onChange((state) => told.push([1, state.coordinating]));
      const stoodDown: string[] = [];
      registry.onGlobalAssistantStandDown((sessionId) => stoodDown.push(sessionId));
      const outgoing = first.getRunningSession()!.sessionId;
      const runs = [first.getRunningSession(), second.getRunningSession()];

      await registry.handGlobalAssistantCoordination(1);

      expect(coordinating()).toEqual([false, true]);
      // Both windows' states hear it.
      expect(told).toEqual(
        expect.arrayContaining([
          [0, false],
          [1, true],
        ])
      );
      expect(stoodDown).toEqual([outgoing]);
      expect([first.getRunningSession(), second.getRunningSession()]).toEqual(runs);
      expect(help.pointer).toContain("handover-0-1");
      expect(work.moved).toEqual([{ from: outgoing, to: second.getRunningSession() }]);
      expect(first.getState().phase).toBe("running");
      expect(help.revoked).toEqual([]);

      // Already there: nothing moves again.
      await registry.handGlobalAssistantCoordination(1);
      expect(help.pointer.filter((entry) => entry.startsWith("handover"))).toHaveLength(1);

      await registry.handGlobalAssistantCoordination(0);
      expect(coordinating()).toEqual([true, false]);
      expect(work.moved.at(-1)).toEqual({
        from: second.getRunningSession()!.sessionId,
        to: first.getRunningSession(),
      });
    });

    it("refuses a session that isn't open, or one still starting, moving nothing", async () => {
      await registry.getGlobalAssistantService(0).ensureSession();
      await expect(registry.handGlobalAssistantCoordination(1)).rejects.toMatchObject({
        code: "VALIDATION",
        userMessage: expect.stringContaining("Session 2 isn't open"),
      });

      const release = holdSpawns();
      const second = await registry.startNewGlobalAssistantSession("codex", usable);
      await expect(registry.handGlobalAssistantCoordination(1)).rejects.toMatchObject({
        code: "VALIDATION",
        userMessage: expect.stringContaining("starting or stopping"),
      });
      release();
      await registry.joinNewGlobalAssistantLaunch(1, second.getState().generation);

      expect(coordinating()).toEqual([true, false]);
      expect(help.pointer.some((entry) => entry.startsWith("handover"))).toBe(false);
      expect(work.moved).toEqual([]);
    });

    it("hands the coordinator's work to the session that stays before stopping it", async () => {
      const [first, second] = await twoRunning();
      const outgoing = first.getRunningSession()!.sessionId;

      await registry.stopGlobalAssistantSession(0);

      expect(help.pointer.indexOf("handover-0-1")).toBeGreaterThanOrEqual(0);
      expect(help.pointer.indexOf("handover-0-1")).toBeLessThan(help.pointer.indexOf("discard-0"));
      expect(work.moved).toEqual([{ from: outgoing, to: second.getRunningSession() }]);
      expect(first.isOccupied()).toBe(false);
      expect(coordinating()).toEqual([false, true]);

      // A first session started again later never takes coordination back.
      const reused = await registry.startNewGlobalAssistantSession("claude", usable);
      await registry.joinNewGlobalAssistantLaunch(0, reused.getState().generation);
      expect(coordinating()).toEqual([false, true]);
    });

    it("leaves the coordinator be when the other session stops", async () => {
      const [first] = await twoRunning();
      const run = first.getRunningSession();

      await registry.stopGlobalAssistantSession(1);

      expect(first.getRunningSession()).toEqual(run);

      expect(help.pointer.some((entry) => entry.startsWith("handover"))).toBe(false);
      expect(help.pointer).toContain("discard-1");
      expect(work.moved).toEqual([]);
      expect(coordinating()).toEqual([true, false]);
    });

    it("hands a second session's coordination back to the first when it stops", async () => {
      const [first, second] = await twoRunning();
      await registry.handGlobalAssistantCoordination(1);
      const outgoing = second.getRunningSession()!.sessionId;

      await registry.stopGlobalAssistantSession(1);

      expect(help.pointer).toContain("handover-1-0");
      expect(help.pointer.indexOf("handover-1-0")).toBeLessThan(help.pointer.indexOf("discard-1"));
      expect(work.moved.at(-1)).toEqual({ from: outgoing, to: first.getRunningSession() });
      expect(coordinating()).toEqual([true, false]);
    });

    it("stops nothing when the session staying has no conversation to take the work into", async () => {
      const [first] = await twoRunning();
      help.refuseHandOver = "unheld";
      const stoodDown: string[] = [];
      registry.onGlobalAssistantStandDown((sessionId) => stoodDown.push(sessionId));

      await expect(registry.stopGlobalAssistantSession(0)).rejects.toMatchObject({
        code: "VALIDATION",
        userMessage: expect.stringContaining("Session 2 hasn't started a conversation yet"),
      });
      await expect(registry.handGlobalAssistantCoordination(1)).rejects.toMatchObject({
        userMessage: expect.stringContaining("Start it, then hand coordination to it"),
      });

      expect(first.getState().phase).toBe("running");
      expect(help.pointer).not.toContain("discard-0");
      expect(work.moved).toEqual([]);
      expect(stoodDown).toEqual([]);
      expect(coordinating()).toEqual([true, false]);
    });

    it("stops nothing while the kept conversations still can't be read", async () => {
      const first = registry.getGlobalAssistantService(0);
      await first.ensureSession();
      help.wired = false;

      await expect(registry.stopGlobalAssistantSession(0)).rejects.toMatchObject({
        userMessage: expect.stringContaining("still starting"),
      });
      expect(first.getState().phase).toBe("running");
      expect(help.pointer).not.toContain("discard-0");
    });

    it("stops nothing when the check refuses, or while the session staying is still starting", async () => {
      const first = registry.getGlobalAssistantService(0);
      await first.ensureSession();

      await expect(
        registry.stopGlobalAssistantSession(0, () => {
          throw new Error("changed since asked");
        })
      ).rejects.toThrow("changed since asked");
      expect(first.getState().phase).toBe("running");

      const release = holdSpawns();
      const second = await registry.startNewGlobalAssistantSession("codex", usable);
      await expect(registry.stopGlobalAssistantSession(0)).rejects.toMatchObject({
        code: "VALIDATION",
        userMessage: expect.stringContaining("Session 2 is starting"),
      });
      release();
      await registry.joinNewGlobalAssistantLaunch(1, second.getState().generation);

      expect(first.getState().phase).toBe("running");
      expect(help.pointer.some((entry) => entry.startsWith("handover"))).toBe(false);
      expect(help.pointer).not.toContain("discard-0");
    });

    it("comes back after a restart with the session chosen before it", async () => {
      help.kept.set(0, "claude");
      help.kept.set(1, "codex");
      help.coordinator = 1;
      await registry.whenGlobalAssistantSessionsReadable();

      expect(coordinating()).toEqual([false, true]);
      expect(registry.globalAssistantCoordinatorSlot()).toBe(1);
    });
  });
});
