import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalAssistantService } from "../../../services/GlobalAssistantService.js";

let service: GlobalAssistantService;
let secondService: GlobalAssistantService;
const registry = vi.hoisted(() => ({
  startNew: vi.fn(),
  join: vi.fn(),
  hand: vi.fn(async (_slot: number) => {}),
  coordinator: 0 as 0 | 1,
}));
vi.mock("../../../services/globalAssistant.js", () => ({
  getGlobalAssistantService: (slot = 0) => (slot === 1 ? secondService : service),
  whenGlobalAssistantSessionsReadable: async () => {},
  startNewGlobalAssistantSession: registry.startNew,
  joinNewGlobalAssistantLaunch: registry.join,
  globalAssistantCoordinatorSlot: () => registry.coordinator,
  handGlobalAssistantCoordination: registry.hand,
  stopGlobalAssistantSession: async (
    slot: number,
    check: (instance: GlobalAssistantService) => void
  ) => {
    const instance = slot === 1 ? secondService : service;
    check(instance);
    await instance.discard();
  },
}));

const pty = vi.hoisted(() => ({
  generation: 3 as number | null,
  spawnResult: new Set<(id: string) => void>(),
  read: vi.fn(async (_id: string): Promise<{ agentState?: string } | null> => null),
}));
vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: () => ({
    getLiveGeneration: () => pty.generation,
    getTerminalAsync: (id: string) => pty.read(id),
    on: (event: string, listener: (id: string) => void) => {
      if (event === "spawn-result") pty.spawnResult.add(listener);
    },
  }),
}));
const bus = vi.hoisted(() => ({
  stateChanged: new Set<(payload: { terminalId?: string; state: string }) => void>(),
}));
vi.mock("../../../services/events.js", () => ({
  events: {
    on: (event: string, listener: (payload: { terminalId?: string; state: string }) => void) => {
      if (event === "agent:state-changed") bus.stateChanged.add(listener);
      return () => bus.stateChanged.delete(listener);
    },
  },
}));
const broadcast = vi.hoisted(() => vi.fn());
vi.mock("../../utils.js", () => ({ broadcastToRenderer: broadcast }));
const windows = vi.hoisted(() => ({ managers: new Map<number, unknown>() }));
vi.mock("../../../window/windowRef.js", () => ({
  getWindowRegistry: () => ({
    getByWindowId: (id: number) => {
      const manager = windows.managers.get(id);
      return manager ? { services: { projectViewManager: manager } } : undefined;
    },
  }),
}));

function seen(terminalId: string, state: string) {
  for (const listener of bus.stateChanged) listener({ terminalId, state });
}

function lastBroadcast(): { agentState: string | null } | undefined {
  return broadcast.mock.calls.at(-1)?.[1];
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const handlers = await import("../helpGlobalAssistant.js");

function makeService(slot: 0 | 1 = 0, pinnedAgentId: string | null = null) {
  return new GlobalAssistantService(
    {
      agentId: async () => (slot === 0 ? "claude" : null),
      canRun: async () => true,
      provision: async () => ({ sessionId: "s", sessionPath: "/g", token: "secret", mcpUrl: null }),
      takeResume: async () => null,
      releaseResume: async () => {},
      discardResume: async () => {},
      spawn: async () => true,
      revoke: async () => {},
      kill: () => {},
      focusedWindows: () => [],
    },
    { slot, pinnedAgentId }
  );
}

const ctx = (webContentsId: number, windowId: number | null) =>
  ({
    webContentsId,
    senderWindow: windowId === null ? null : { id: windowId },
  }) as never;

describe("global assistant IPC handlers", () => {
  beforeEach(() => {
    service = makeService();
    secondService = makeService(1);
    registry.startNew.mockReset();
    registry.join.mockReset();
    registry.hand.mockClear();
    registry.coordinator = 0;
    pty.generation = 3;
    pty.spawnResult.clear();
    pty.read.mockReset();
    pty.read.mockResolvedValue(null);
    bus.stateChanged.clear();
    broadcast.mockClear();
  });

  it("names the running session by its exact terminal and PTY launch generation", async () => {
    expect((await handlers.handleGetGlobalAssistantState()).subject).toBeNull();
    const state = await handlers.handleEnsureGlobalAssistant(ctx(10, 1));
    expect(state.subject).toEqual({
      hostId: "local",
      scope: { kind: "global" },
      terminalId: state.terminalId,
      incarnation: 3,
    });
    // A terminal the PTY host no longer knows names no subject to watch.
    pty.generation = null;
    expect((await handlers.handleGetGlobalAssistantState()).subject).toBeNull();
  });

  it("tells every window of each change, ownership included", async () => {
    await handlers.handleEnsureGlobalAssistant(ctx(10, 1));
    const a = await handlers.handleAttachGlobalAssistant(ctx(10, 1));
    const b = await handlers.handleAttachGlobalAssistant(ctx(20, 2));
    broadcast.mockClear();
    await handlers.handleClaimGlobalAssistantInput(ctx(20, 2), b.attachmentId);
    expect(broadcast).toHaveBeenCalledWith(
      "help:global-assistant-changed",
      expect.objectContaining({
        inputOwner: b.attachmentId,
        subject: expect.objectContaining({ terminalId: expect.any(String) }),
      })
    );
    expect(a.attachmentId).not.toBe(b.attachmentId);
    // One publisher per service, however many calls reach it.
    broadcast.mockClear();
    await handlers.handleReleaseGlobalAssistantInput(ctx(20, 2), b.attachmentId);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("moves input between a view's attachments only while the one named still holds it (#16214)", async () => {
    await handlers.handleEnsureGlobalAssistant(ctx(10, 1));
    const panel = await handlers.handleAttachGlobalAssistant(ctx(10, 1));
    const canopy = await handlers.handleAttachGlobalAssistant(ctx(10, 1));
    const other = await handlers.handleAttachGlobalAssistant(ctx(20, 2));
    const taken = await handlers.handleClaimGlobalAssistantInput(
      ctx(10, 1),
      canopy.attachmentId,
      panel.attachmentId
    );
    expect(taken.inputOwner).toBe(canopy.attachmentId);
    // Another window asks for it, and the hand-back that was on its way moves nothing.
    const asked = await handlers.handleClaimGlobalAssistantInput(ctx(20, 2), other.attachmentId);
    const handedBack = await handlers.handleClaimGlobalAssistantInput(
      ctx(10, 1),
      panel.attachmentId,
      canopy.attachmentId
    );
    expect(handedBack.inputOwner).toBe(other.attachmentId);
    expect(handedBack.inputEpoch).toBe(asked.inputEpoch);
    await expect(
      handlers.handleClaimGlobalAssistantInput(ctx(10, 1), panel.attachmentId, 5 as never)
    ).rejects.toThrow(/attachment id/);
  });

  it("tells the windows the run's new subject when its PTY is respawned under it", async () => {
    const state = await handlers.handleEnsureGlobalAssistant(ctx(10, 1));
    broadcast.mockClear();
    pty.generation = 4;
    for (const listener of pty.spawnResult) listener("some-other-terminal");
    expect(broadcast).not.toHaveBeenCalled();
    for (const listener of pty.spawnResult) listener(state.terminalId!);
    expect(broadcast).toHaveBeenCalledWith(
      "help:global-assistant-changed",
      expect.objectContaining({ subject: expect.objectContaining({ incarnation: 4 }) })
    );
  });

  it("refuses a restart confirmed against a run already replaced", async () => {
    const first = await handlers.handleEnsureGlobalAssistant(ctx(10, 1));
    await handlers.handleRestartGlobalAssistant(ctx(10, 1), first.generation);
    await expect(
      handlers.handleRestartGlobalAssistant(ctx(20, 2), first.generation)
    ).rejects.toMatchObject({ code: "STALE_GENERATION" });
  });

  it("refuses a restart or discard confirmed against a run already replaced", async () => {
    const first = await handlers.handleEnsureGlobalAssistant(ctx(10, 1));
    const restarted = await handlers.handleRestartGlobalAssistant(ctx(10, 1), first.generation);
    expect(restarted.terminalId).not.toBe(first.terminalId);
    await expect(
      handlers.handleDiscardGlobalAssistant(ctx(20, 2), first.generation)
    ).rejects.toMatchObject({ code: "STALE_GENERATION" });
    expect((await handlers.handleGetGlobalAssistantState()).phase).toBe("running");
    const discarded = await handlers.handleDiscardGlobalAssistant(ctx(20, 2), restarted.generation);
    expect(discarded.phase).toBe("absent");
  });

  describe("which session coordinates (#18143)", () => {
    it("hands coordination over from a window, answering with both sessions", async () => {
      const views = await handlers.handleSetGlobalAssistantCoordinator(ctx(10, 1), 1);

      expect(registry.hand).toHaveBeenCalledWith(1);
      expect(views.map((view) => view.slot)).toEqual([0, 1]);
    });

    it("refuses a call from no window, or naming no session", async () => {
      await expect(
        handlers.handleSetGlobalAssistantCoordinator(ctx(10, null), 1)
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
      await expect(
        handlers.handleSetGlobalAssistantCoordinator(ctx(10, 1), 2)
      ).rejects.toMatchObject({
        code: "VALIDATION",
      });
      expect(registry.hand).not.toHaveBeenCalled();
    });
  });

  describe("replacing the run from a hand-off (#18140)", () => {
    const replacement = (generation: number, phase: "absent" | "launching" | "running") => ({
      agentId: "codex",
      prompt: "Continue from the hand-off",
      expected: { generation, phase },
    });

    it("replaces the run the person approved with one on the chosen agent, from its hand-off", async () => {
      const spawn = vi.fn(async () => true);
      service = new GlobalAssistantService({
        agentId: async () => "claude",
        canRun: async () => true,
        provision: async () => ({ sessionId: "s", sessionPath: "/g", token: "t", mcpUrl: null }),
        takeResume: async () => null,
        releaseResume: async () => {},
        discardResume: async () => {},
        spawn,
        revoke: async () => {},
        kill: () => {},
        focusedWindows: () => [],
      });
      const first = await handlers.handleEnsureGlobalAssistant(ctx(10, 1));
      const replaced = await handlers.handleReplaceGlobalAssistant(
        ctx(10, 1),
        replacement(first.generation, "running")
      );
      expect(replaced).toMatchObject({ phase: "running", agentId: "codex" });
      expect(replaced.terminalId).not.toBe(first.terminalId);
      expect(spawn).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentId: "codex", prompt: "Continue from the hand-off" })
      );
    });

    it("replaces the session that coordinated when asked, and nothing once it handed over (#18143)", async () => {
      registry.coordinator = 1;
      secondService = makeService(1, "codex");
      const second = await handlers.handleEnsureGlobalAssistant(ctx(10, 1), 1);
      const replaced = await handlers.handleReplaceGlobalAssistant(ctx(10, 1), {
        ...replacement(second.generation, "running"),
        slot: 1,
      });
      expect(replaced).toMatchObject({ slot: 1, phase: "running" });
      expect(service.getState().phase).toBe("absent");

      registry.coordinator = 0;
      const shown = secondService.getState();
      await expect(
        handlers.handleReplaceGlobalAssistant(ctx(10, 1), {
          ...replacement(shown.generation, "running"),
          slot: 1,
        })
      ).rejects.toMatchObject({ code: "STALE_GENERATION" });
      expect(secondService.getState().generation).toBe(shown.generation);
    });

    it("tells the person how to recover when the new agent doesn't start", async () => {
      service = new GlobalAssistantService({
        agentId: async () => "claude",
        canRun: async () => true,
        provision: async () => ({ sessionId: "s", sessionPath: "/g", token: "t", mcpUrl: null }),
        takeResume: async () => null,
        releaseResume: async () => {},
        discardResume: async () => {},
        spawn: async () => false,
        revoke: async () => {},
        kill: () => {},
        focusedWindows: () => [],
      });
      await expect(
        handlers.handleReplaceGlobalAssistant(ctx(10, 1), replacement(0, "absent"))
      ).rejects.toMatchObject({
        code: "INTERNAL",
        userMessage:
          "Its new agent didn't start. Start the global assistant again from the Assistant panel.",
      });
    });

    it("answers whether an agent could replace the run, for a window only", async () => {
      expect(await handlers.handleCanRunGlobalAssistant(ctx(10, 1), "codex")).toBe(true);
      expect(await handlers.handleCanRunGlobalAssistant(ctx(10, 1), "")).toBe(false);
      await expect(
        handlers.handleCanRunGlobalAssistant(ctx(10, null), "codex")
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    });

    it("says nothing was replaced when the run changed since the person was asked", async () => {
      const first = await handlers.handleEnsureGlobalAssistant(ctx(10, 1));
      await handlers.handleRestartGlobalAssistant(ctx(10, 1), first.generation);
      await expect(
        handlers.handleReplaceGlobalAssistant(ctx(20, 2), replacement(first.generation, "running"))
      ).rejects.toMatchObject({
        code: "STALE_GENERATION",
        userMessage: "The global assistant changed since you were asked. Nothing was replaced.",
      });
      expect((await handlers.handleGetGlobalAssistantState()).agentId).toBe("claude");
    });

    it.each([
      ["a blank hand-off", { prompt: "   " }],
      ["a hand-off of tabs and line breaks", { prompt: "\t\n" }],
      ["a hand-off the CLI would read as an option", { prompt: " --dangerously-skip-permissions" }],
      ["a hand-off that reads as a short option", { prompt: "-p go" }],
      ["a hand-off with a control character", { prompt: "go\u001b[2J" }],
      ["a missing run to compare", { expected: undefined }],
      ["an unknown phase", { expected: { generation: 0, phase: "stopped" } }],
    ])("refuses %s before anything stops", async (_name, override) => {
      const first = await handlers.handleEnsureGlobalAssistant(ctx(10, 1));
      await expect(
        handlers.handleReplaceGlobalAssistant(ctx(10, 1), {
          ...replacement(first.generation, "running"),
          ...override,
        } as never)
      ).rejects.toMatchObject({ code: "VALIDATION" });
      expect((await handlers.handleGetGlobalAssistantState()).terminalId).toBe(first.terminalId);
    });

    it("refuses a caller with no window", async () => {
      await expect(
        handlers.handleReplaceGlobalAssistant(ctx(10, null), replacement(0, "absent"))
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
      expect((await handlers.handleGetGlobalAssistantState()).phase).toBe("absent");
    });
  });

  it("stops a launch from any window, only the launch it was asked about, and never a run (#16603)", async () => {
    let spawned: ((started: boolean) => void) | null = null;
    const discardResume = vi.fn(async () => {});
    service = new GlobalAssistantService({
      agentId: async () => "claude",
      canRun: async () => true,
      provision: async () => ({ sessionId: "s", sessionPath: "/g", token: "secret", mcpUrl: null }),
      takeResume: async () => null,
      releaseResume: async () => {},
      discardResume,
      spawn: vi
        .fn<() => Promise<boolean>>()
        .mockImplementationOnce(() => new Promise((resolve) => (spawned = resolve)))
        .mockResolvedValue(true),
      revoke: async () => {},
      kill: () => {},
      focusedWindows: () => [],
    });
    const launch = handlers.handleEnsureGlobalAssistant(ctx(10, 1));
    await vi.waitFor(() => expect(spawned).not.toBeNull());
    const { generation } = await handlers.handleGetGlobalAssistantState();

    await expect(handlers.handleCancelGlobalAssistantLaunch(ctx(20, null))).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    await expect(
      handlers.handleCancelGlobalAssistantLaunch(ctx(20, 2), generation - 1)
    ).rejects.toMatchObject({ code: "STALE_GENERATION" });
    expect((await handlers.handleGetGlobalAssistantState()).phase).toBe("launching");

    const cancelled = await handlers.handleCancelGlobalAssistantLaunch(ctx(20, 2), generation);
    expect(cancelled.phase).toBe("absent");
    expect(broadcast.mock.calls.at(-1)?.[1]).toMatchObject({ phase: "absent" });
    spawned!(true);
    await expect(launch).rejects.toMatchObject({ code: "CANCELLED" });
    expect(discardResume).not.toHaveBeenCalled();

    const running = await handlers.handleEnsureGlobalAssistant(ctx(10, 1));
    const after = await handlers.handleCancelGlobalAssistantLaunch(ctx(20, 2), running.generation);
    expect(after).toMatchObject({ phase: "running", terminalId: running.terminalId });
  });

  it("refuses a Cancel meant for a launch that failed, leaving the next one going (#16603)", async () => {
    let spawned: ((started: boolean) => void) | null = null;
    service = new GlobalAssistantService({
      agentId: async () => "claude",
      canRun: async () => true,
      provision: async () => ({ sessionId: "s", sessionPath: "/g", token: "secret", mcpUrl: null }),
      takeResume: async () => null,
      releaseResume: async () => {},
      discardResume: async () => {},
      spawn: vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockImplementationOnce(() => new Promise((resolve) => (spawned = resolve))),
      revoke: async () => {},
      kill: () => {},
      focusedWindows: () => [],
    });
    const failing = handlers.handleEnsureGlobalAssistant(ctx(10, 1));
    const { generation } = await handlers.handleGetGlobalAssistantState();
    await expect(failing).rejects.toMatchObject({ code: "INTERNAL" });

    const next = handlers.handleEnsureGlobalAssistant(ctx(20, 2));
    await vi.waitFor(() => expect(spawned).not.toBeNull());
    await expect(
      handlers.handleCancelGlobalAssistantLaunch(ctx(30, 3), generation)
    ).rejects.toMatchObject({ code: "STALE_GENERATION" });
    expect((await handlers.handleGetGlobalAssistantState()).phase).toBe("launching");
    spawned!(true);
    expect((await next).phase).toBe("running");
  });

  it("returns state without the session's credentials", async () => {
    const state = await handlers.handleEnsureGlobalAssistant(ctx(10, 1));
    expect(state.phase).toBe("running");
    expect(JSON.stringify(state)).not.toContain("secret");
    const attached = await handlers.handleAttachGlobalAssistant(ctx(10, 1));
    expect(JSON.stringify(attached)).not.toContain("secret");
  });

  it("refuses a caller with no window, with an AppError", async () => {
    await expect(handlers.handleEnsureGlobalAssistant(ctx(10, null))).rejects.toMatchObject({
      name: "AppError",
      code: "UNSUPPORTED",
    });
  });

  it("derives the attachment owner from the sender, never from the payload", async () => {
    const { attachmentId } = await handlers.handleAttachGlobalAssistant(ctx(10, 1));
    await expect(
      handlers.handleClaimGlobalAssistantInput(ctx(20, 2), attachmentId)
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(handlers.handleClaimGlobalAssistantInput(ctx(10, 1), "")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      handlers.handleClaimGlobalAssistantInput(ctx(10, 1), "nope")
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("hands nobody's input only to a view that can type, and fills it once one can (#16098)", async () => {
    const behindCanopy = await handlers.handleAttachGlobalAssistant(ctx(10, 1), false);
    expect(behindCanopy.state.inputOwner).toBeNull();
    await expect(
      handlers.handleSetGlobalAssistantInputEligible(ctx(20, 2), behindCanopy.attachmentId, true)
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      handlers.handleSetGlobalAssistantInputEligible(
        ctx(10, 1),
        behindCanopy.attachmentId,
        "yes" as never
      )
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      handlers.handleAttachGlobalAssistant(ctx(10, 1), 1 as never)
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await handlers.handleGetGlobalAssistantState()).inputOwner).toBeNull();

    broadcast.mockClear();
    await handlers.handleSetGlobalAssistantInputEligible(
      ctx(10, 1),
      behindCanopy.attachmentId,
      true
    );
    expect((await handlers.handleGetGlobalAssistantState()).inputOwner).toBe(
      behindCanopy.attachmentId
    );
    expect(broadcast.mock.calls.at(-1)?.[1]).toMatchObject({
      inputOwner: behindCanopy.attachmentId,
    });
  });

  it("passes over a view that said it can no longer type", async () => {
    const a = await handlers.handleAttachGlobalAssistant(ctx(10, 1));
    const b = await handlers.handleAttachGlobalAssistant(ctx(20, 2));
    const c = await handlers.handleAttachGlobalAssistant(ctx(30, 3));
    await handlers.handleSetGlobalAssistantInputEligible(ctx(30, 3), c.attachmentId, false);
    await handlers.handleDetachGlobalAssistant(ctx(10, 1), a.attachmentId);
    expect((await handlers.handleGetGlobalAssistantState()).inputOwner).toBe(b.attachmentId);
  });

  it("tells every window when a departing owner's input moves to another", async () => {
    const a = await handlers.handleAttachGlobalAssistant(ctx(10, 1));
    const b = await handlers.handleAttachGlobalAssistant(ctx(20, 2));
    broadcast.mockClear();
    await handlers.handleDetachGlobalAssistant(ctx(10, 1), a.attachmentId);
    expect(broadcast.mock.calls.at(-1)?.[1]).toMatchObject({ inputOwner: b.attachmentId });
  });

  it("moves input between holders only on an explicit claim and frees it on release", async () => {
    const a = await handlers.handleAttachGlobalAssistant(ctx(10, 1));
    const b = await handlers.handleAttachGlobalAssistant(ctx(20, 2));
    expect(b.state.inputOwner).toBe(a.attachmentId);
    const claimed = await handlers.handleClaimGlobalAssistantInput(ctx(20, 2), b.attachmentId);
    expect(claimed.inputOwner).toBe(b.attachmentId);
    const released = await handlers.handleReleaseGlobalAssistantInput(ctx(20, 2), b.attachmentId);
    expect(released.inputOwner).toBeNull();
  });

  it("detach leaves the session running; discard stops it", async () => {
    await handlers.handleEnsureGlobalAssistant(ctx(10, 1));
    const { attachmentId } = await handlers.handleAttachGlobalAssistant(ctx(10, 1));
    await handlers.handleDetachGlobalAssistant(ctx(10, 1), attachmentId);
    expect((await handlers.handleGetGlobalAssistantState()).phase).toBe("running");
    const discarded = await handlers.handleDiscardGlobalAssistant(ctx(10, 1));
    expect(discarded.phase).toBe("absent");
  });
  describe("two sessions (#18142)", () => {
    it("routes every call to the session it names, and to the first when it names none", async () => {
      await handlers.handleEnsureGlobalAssistant(ctx(10, 1));
      await secondService.startOn("codex");
      const { attachmentId } = await handlers.handleAttachGlobalAssistant(ctx(10, 1), true, 1);
      expect(secondService.getState().inputOwner).toBe(attachmentId);
      expect(service.getState().attachments).toEqual([]);
      // Its attachment is the second session's alone.
      await expect(
        handlers.handleClaimGlobalAssistantInput(ctx(10, 1), attachmentId)
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      const firstRun = service.getState().terminalId;
      const secondRun = secondService.getState().terminalId;
      const before = secondService.getState().generation;
      await handlers.handleRestartGlobalAssistant(ctx(10, 1), before, 1);
      expect(service.getState().terminalId).toBe(firstRun);
      expect(secondService.getState()).toMatchObject({ phase: "running", agentId: "codex" });
      expect(secondService.getState().terminalId).not.toBe(secondRun);

      // A stop for the second session leaves the first running.
      await handlers.handleDiscardGlobalAssistant(
        ctx(10, 1),
        secondService.getState().generation,
        1,
        true
      );
      expect(secondService.getState().phase).toBe("absent");
      expect(service.getState()).toMatchObject({ phase: "running", terminalId: firstRun });

      await handlers.handleDetachGlobalAssistant(ctx(10, 1), attachmentId, 1);
      expect(secondService.getState().attachments).toEqual([]);
    });

    it("stops nothing for a confirm asked of an idle session that has started since", async () => {
      secondService = makeService(1, "codex");
      // Idle but kept when the person was asked to stop it.
      const asked = secondService.getState().generation;
      expect(secondService.getState()).toMatchObject({ phase: "absent", occupied: true });
      // Another window starts it meanwhile, at the same generation.
      await secondService.ensureSession();
      expect(secondService.getState().generation).toBe(asked);

      await expect(
        handlers.handleDiscardGlobalAssistant(ctx(10, 1), asked, 1, false)
      ).rejects.toMatchObject({ code: "STALE_GENERATION" });
      expect(secondService.getState().phase).toBe("running");
      await expect(
        handlers.handleDiscardGlobalAssistant(ctx(10, 1), asked, 1, "yes" as never)
      ).rejects.toMatchObject({ code: "VALIDATION" });
    });

    it("stops nothing for a confirm asked of an idle session that is starting now", async () => {
      let spawned!: (ok: boolean) => void;
      secondService = new GlobalAssistantService(
        {
          agentId: async () => null,
          canRun: async () => true,
          provision: async () => ({ sessionId: "s", sessionPath: "/g", token: "t", mcpUrl: null }),
          takeResume: async () => null,
          releaseResume: async () => {},
          discardResume: async () => {},
          spawn: () =>
            new Promise<boolean>((resolve) => {
              spawned = resolve;
            }),
          revoke: async () => {},
          kill: () => {},
          focusedWindows: () => [],
        },
        { slot: 1, pinnedAgentId: "codex" }
      );
      const asked = secondService.getState().generation;
      const starting = secondService.ensureSession();
      expect(secondService.getState().phase).toBe("launching");
      await expect(
        handlers.handleDiscardGlobalAssistant(ctx(10, 1), asked, 1, false)
      ).rejects.toMatchObject({ code: "STALE_GENERATION" });
      await vi.waitFor(() => expect(spawned).toBeTypeOf("function"));
      spawned(true);
      await expect(starting).resolves.toMatchObject({ phase: "running" });
    });

    it("refuses a session that doesn't exist", async () => {
      await expect(handlers.handleGetGlobalAssistantState(2)).rejects.toMatchObject({
        code: "VALIDATION",
      });
      await expect(
        handlers.handleAttachGlobalAssistant(ctx(10, 1), true, -1)
      ).rejects.toMatchObject({ code: "VALIDATION" });
    });

    it("lists both sessions, running or not, and tags each change with its session", async () => {
      await secondService.startOn("codex");
      const listed = await handlers.handleListGlobalAssistantSessions();
      expect(listed.map((view) => [view.slot, view.phase, view.occupied])).toEqual([
        [0, "absent", false],
        [1, "running", true],
      ]);
      broadcast.mockClear();
      await secondService.discard();
      expect(broadcast.mock.calls.at(-1)?.[1]).toMatchObject({ slot: 1, occupied: false });
    });

    it("answers a new session as soon as it is claimed, and joins only its launch", async () => {
      registry.startNew.mockImplementation(async (agentId: string) => {
        secondService.startOn(agentId).catch(() => {});
        return secondService;
      });
      const claimed = await handlers.handleStartNewGlobalAssistant(ctx(10, 1), "codex");
      expect(claimed).toMatchObject({ slot: 1, phase: "launching", pinnedAgentId: "codex" });
      expect(registry.startNew).toHaveBeenCalledWith("codex");

      registry.join.mockResolvedValue(undefined);
      await handlers.handleEnsureGlobalAssistant(ctx(10, 1), 1, claimed.generation);
      expect(registry.join).toHaveBeenCalledWith(1, claimed.generation);
      // Joined after a clear moved the session on: not the run that was asked about.
      await secondService.restart();
      await expect(
        handlers.handleEnsureGlobalAssistant(ctx(10, 1), 1, claimed.generation)
      ).rejects.toMatchObject({ code: "CANCELLED" });
      await expect(handlers.handleEnsureGlobalAssistant(ctx(10, 1), 1, 1.5)).rejects.toMatchObject({
        code: "VALIDATION",
      });
      await expect(
        handlers.handleStartNewGlobalAssistant(ctx(10, null), "codex")
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    });

    it("hands a project switch the session the window showed", async () => {
      const record = vi.fn();
      windows.managers.set(1, { ownsView: () => true, recordGlobalAssistantPanel: record });
      await handlers.handleReportWindowGlobalAssistantPanel(ctx(10, 1), {
        showing: true,
        target: null,
        slot: 1,
      });
      expect(record).toHaveBeenCalledWith(10, { showing: true, target: null, slot: 1 });
      await expect(
        handlers.handleReportWindowGlobalAssistantPanel(ctx(10, 1), {
          showing: true,
          target: null,
          slot: 2 as never,
        })
      ).rejects.toMatchObject({ code: "VALIDATION" });
      windows.managers.delete(1);
    });
  });

  describe("what the run's terminal is seen doing (#14986)", () => {
    it("tells every window each transition of the run's terminal, and only of that one", async () => {
      const state = await handlers.handleEnsureGlobalAssistant(ctx(10, 1));
      expect(state.agentState).toBeNull();
      broadcast.mockClear();
      seen("some-other-terminal", "waiting");
      expect(broadcast).not.toHaveBeenCalled();
      seen(state.terminalId!, "waiting");
      expect(lastBroadcast()?.agentState).toBe("waiting");
      expect((await handlers.handleGetGlobalAssistantState()).agentState).toBe("waiting");
      const discarded = await handlers.handleDiscardGlobalAssistant(ctx(10, 1));
      expect(discarded.agentState).toBeNull();
    });

    it("reads a run already going when it is first looked at, attaching nothing", async () => {
      // Started by a path no window called, as an MCP call can.
      const started = await service.ensureSession();
      const untouched = (
        ["attach", "detach", "claimInput", "releaseInput", "ensureSession"] as const
      ).map((method) => vi.spyOn(service, method));
      pty.read.mockResolvedValue({ agentState: "waiting" });
      await handlers.handleGetGlobalAssistantState();
      expect(pty.read).toHaveBeenCalledWith(started.terminalId);
      await flush();
      expect(lastBroadcast()?.agentState).toBe("waiting");
      seen(started.terminalId!, "working");
      const state = await handlers.handleGetGlobalAssistantState();
      expect(state.agentState).toBe("working");
      expect(state.attachments).toEqual(started.attachments);
      expect(state.inputOwner).toBe(started.inputOwner);
      expect(state.inputEpoch).toBe(started.inputEpoch);
      for (const spy of untouched) expect(spy).not.toHaveBeenCalled();
    });

    it("never lets a read that left before a transition undo it", async () => {
      let answer!: (info: { agentState: string }) => void;
      pty.read.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      const state = await handlers.handleEnsureGlobalAssistant(ctx(10, 1));
      seen(state.terminalId!, "working");
      answer({ agentState: "waiting" });
      await flush();
      expect((await handlers.handleGetGlobalAssistantState()).agentState).toBe("working");
    });

    it.each([
      [
        "a respawn of the same terminal",
        (terminalId: string) => {
          pty.generation = 4;
          for (const listener of pty.spawnResult) listener(terminalId);
        },
      ],
      [
        "a restart onto a new terminal",
        async () => {
          await handlers.handleRestartGlobalAssistant(ctx(10, 1));
        },
      ],
    ])("drops a read of the run it replaced, landing after %s", async (_, replace) => {
      const answers: Array<(info: { agentState: string }) => void> = [];
      pty.read.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
      const state = await handlers.handleEnsureGlobalAssistant(ctx(10, 1));
      expect(answers).toHaveLength(1);
      await replace(state.terminalId!);
      expect(answers).toHaveLength(2);
      answers[1]!({ agentState: "working" });
      await flush();
      answers[0]!({ agentState: "waiting" });
      await flush();
      expect((await handlers.handleGetGlobalAssistantState()).agentState).toBe("working");
    });

    it("forgets what was seen on the PTY its terminal was respawned from", async () => {
      const state = await handlers.handleEnsureGlobalAssistant(ctx(10, 1));
      seen(state.terminalId!, "waiting");
      pty.generation = 4;
      pty.read.mockResolvedValue({ agentState: "idle" });
      for (const listener of pty.spawnResult) listener(state.terminalId!);
      expect(lastBroadcast()?.agentState).toBeNull();
      await flush();
      expect(lastBroadcast()?.agentState).toBe("idle");
    });
  });
});

describe("window global assistant panel IPC handlers (#16099)", () => {
  const shown = {
    showing: true,
    target: {
      hostId: "local",
      scope: { kind: "global" as const },
      terminalId: "g",
      incarnation: 1,
    },
  };

  function fakeManager(viewIds: number[], record: unknown = shown) {
    return {
      ownsView: (id: number) => viewIds.includes(id),
      getGlobalAssistantPanel: vi.fn(() => record),
      recordGlobalAssistantPanel: vi.fn(() => true),
    };
  }

  beforeEach(() => {
    windows.managers.clear();
  });

  it("answers a view with its own window's record, and nothing else", async () => {
    const otherRecord = { showing: false, target: null };
    windows.managers.set(1, fakeManager([10]));
    windows.managers.set(2, fakeManager([20], otherRecord));

    expect(await handlers.handleGetWindowGlobalAssistantPanel(ctx(10, 1))).toEqual(shown);
    expect(await handlers.handleGetWindowGlobalAssistantPanel(ctx(20, 2))).toEqual(otherRecord);
    // A webContents that isn't one of the window's views, or no window at all.
    expect(await handlers.handleGetWindowGlobalAssistantPanel(ctx(20, 1))).toBeNull();
    expect(await handlers.handleGetWindowGlobalAssistantPanel(ctx(10, null))).toBeNull();
    expect(await handlers.handleGetWindowGlobalAssistantPanel(ctx(10, 3))).toBeNull();
  });

  it("hands a view's report to its window's manager under the sender's id", async () => {
    const first = fakeManager([10]);
    const second = fakeManager([20]);
    windows.managers.set(1, first);
    windows.managers.set(2, second);

    await handlers.handleReportWindowGlobalAssistantPanel(ctx(10, 1), shown);
    expect(first.recordGlobalAssistantPanel).toHaveBeenCalledWith(10, shown);
    expect(second.recordGlobalAssistantPanel).not.toHaveBeenCalled();

    await handlers.handleReportWindowGlobalAssistantPanel(ctx(20, 1), {
      showing: false,
      target: null,
    });
    expect(first.recordGlobalAssistantPanel).toHaveBeenCalledTimes(1);

    await handlers.handleReportWindowGlobalAssistantPanel(ctx(20, 2), {
      showing: true,
      target: null,
    });
    expect(second.recordGlobalAssistantPanel).toHaveBeenCalledWith(20, {
      showing: true,
      target: null,
    });
  });

  it("refuses a panel that isn't this machine's global assistant", async () => {
    const manager = fakeManager([10]);
    windows.managers.set(1, manager);
    const refused = [
      null,
      { showing: "yes", target: null },
      { showing: true, target: { ...shown.target, scope: { kind: "project", projectId: "p" } } },
      { showing: true, target: { ...shown.target, hostId: "studio-01" } },
    ];
    for (const panel of refused) {
      await expect(
        handlers.handleReportWindowGlobalAssistantPanel(ctx(10, 1), panel as never)
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(manager.recordGlobalAssistantPanel).not.toHaveBeenCalled();
  });
});
