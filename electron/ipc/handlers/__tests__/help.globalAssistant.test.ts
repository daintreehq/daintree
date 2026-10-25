import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalAssistantService } from "../../../services/GlobalAssistantService.js";

let service: GlobalAssistantService;
vi.mock("../../../services/globalAssistant.js", () => ({
  getGlobalAssistantService: () => service,
}));

const pty = vi.hoisted(() => ({
  generation: 3 as number | null,
  spawnResult: new Set<(id: string) => void>(),
}));
vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: () => ({
    getLiveGeneration: () => pty.generation,
    on: (event: string, listener: (id: string) => void) => {
      if (event === "spawn-result") pty.spawnResult.add(listener);
    },
  }),
}));
const broadcast = vi.hoisted(() => vi.fn());
vi.mock("../../utils.js", () => ({ broadcastToRenderer: broadcast }));

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
});
