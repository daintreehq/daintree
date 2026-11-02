import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalAssistantService } from "../../../services/GlobalAssistantService.js";

let service: GlobalAssistantService;
vi.mock("../../../services/globalAssistant.js", () => ({
  getGlobalAssistantService: () => service,
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

function makeService() {
  return new GlobalAssistantService({
    agentId: async () => "claude",
    provision: async () => ({ sessionId: "s", sessionPath: "/g", token: "secret", mcpUrl: null }),
    takeResume: async () => null,
    releaseResume: async () => {},
    discardResume: async () => {},
    spawn: async () => true,
    revoke: async () => {},
    kill: () => {},
  });
}

const ctx = (webContentsId: number, windowId: number | null) =>
  ({
    webContentsId,
    senderWindow: windowId === null ? null : { id: windowId },
  }) as never;

describe("global assistant IPC handlers", () => {
  beforeEach(() => {
    service = makeService();
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

  it("moves input only on an explicit claim and frees it on release", async () => {
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

  function fakeManager(viewIds: number[]) {
    return {
      getProjectIdForWebContents: (id: number) => (viewIds.includes(id) ? `proj-${id}` : null),
      getGlobalAssistantPanel: vi.fn(() => shown),
      recordGlobalAssistantPanel: vi.fn(() => true),
    };
  }

  beforeEach(() => {
    windows.managers.clear();
  });

  it("answers a view with its own window's record, and nothing else", async () => {
    const first = fakeManager([10]);
    windows.managers.set(1, first);
    windows.managers.set(2, fakeManager([20]));

    expect(await handlers.handleGetWindowGlobalAssistantPanel(ctx(10, 1))).toEqual(shown);
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
