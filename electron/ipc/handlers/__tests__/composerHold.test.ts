import { beforeEach, describe, expect, it, vi } from "vitest";

const pty = vi.hoisted(() => ({
  generation: 4 as number | null,
  read: undefined as undefined | (() => Promise<unknown>),
  client: {
    getTerminalProjectId: () => "project-1",
    getLiveGeneration: () => pty.generation,
    getTerminalAsync: () => pty.read!(),
  },
}));
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: () => pty.client }));

const queue = vi.hoisted(() => ({ hold: vi.fn(), sendNow: vi.fn() }));
vi.mock("../../../services/composerHold/composerSendHoldLive.js", () => ({
  getComposerSendHold: async () => queue,
  peekComposerSendHold: () => queue,
}));
const lease = vi.hoisted(() => ({
  service: null as null | { isDriving: (projectId: string, endpoint: unknown) => boolean },
}));
vi.mock("../../../services/DriveLeaseService.js", () => ({
  peekDriveLeaseService: () => lease.service,
}));
vi.mock("../../../../shared/config/agentRegistry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../shared/config/agentRegistry.js")>();
  return {
    ...actual,
    getEffectiveAgentConfig: (id: string) =>
      id === "queuer"
        ? { capabilities: { queuesInputWhileWorking: true } }
        : id === "plain"
          ? { capabilities: {} }
          : actual.getEffectiveAgentConfig(id),
  };
});

import { handleHold, handleSendNow, holdsComposerSend } from "../composerHold.js";
import type { IpcContext } from "../../types.js";
import type { NotifyTerminalInfo } from "../../../services/mcp-server/terminalNotify.js";

function info(overrides: Partial<NotifyTerminalInfo> = {}): NotifyTerminalInfo {
  return { agentState: "working", detectedAgentId: "gemini", hasPty: true, ...overrides };
}

describe("holdsComposerSend", () => {
  it("holds for a working agent not declared to queue input", () => {
    expect(holdsComposerSend(info())).toBe(true);
  });

  it("keeps the immediate send for any CLI declared to queue input mid-turn", () => {
    expect(holdsComposerSend(info({ detectedAgentId: "queuer" }))).toBe(false);
    expect(holdsComposerSend(info({ detectedAgentId: "plain" }))).toBe(true);
    expect(holdsComposerSend(info({ detectedAgentId: "claude" }))).toBe(false);
    expect(holdsComposerSend(info({ detectedAgentId: "codex" }))).toBe(false);
  });

  it("keeps the immediate send at any prompt, idle, and in a shell", () => {
    expect(holdsComposerSend(info({ agentState: "waiting", waitingReason: "prompt" }))).toBe(false);
    expect(holdsComposerSend(info({ agentState: "waiting", waitingReason: "question" }))).toBe(
      false
    );
    expect(holdsComposerSend(info({ agentState: "idle" }))).toBe(false);
    expect(holdsComposerSend(info({ detectedAgentId: undefined }))).toBe(false);
  });

  it("never holds for a pane that is gone or going", () => {
    expect(holdsComposerSend(null)).toBe(false);
    expect(holdsComposerSend(info({ hasPty: false }))).toBe(false);
    expect(holdsComposerSend(info({ isExited: true }))).toBe(false);
    expect(holdsComposerSend(info({ isTrashed: true }))).toBe(false);
    expect(holdsComposerSend(info({ isClosing: true }))).toBe(false);
  });
});

describe("handleHold", () => {
  const ctx = { projectId: "project-1", endpoint: undefined } as unknown as IpcContext;

  beforeEach(() => {
    pty.generation = 4;
    queue.hold.mockReset().mockReturnValue({ ok: true, send: { token: "t" } });
  });

  it("holds for this view's busy agent", async () => {
    pty.read = async () => info({ projectId: "project-1" });
    await expect(handleHold(ctx, "term-1", "ship it")).resolves.toMatchObject({ held: true });
    expect(queue.hold).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: "term-1", projectId: "project-1", generation: 4 })
    );
  });

  it("answers unavailable, never send-now, for a run restarted during the read", async () => {
    pty.read = async () => {
      pty.generation = 5;
      return info({ agentState: "waiting", waitingReason: "prompt" });
    };
    await expect(handleHold(ctx, "term-1", "ship it")).resolves.toEqual({
      held: false,
      reason: "unavailable",
    });
    expect(queue.hold).not.toHaveBeenCalled();
  });

  it("answers unavailable for a terminal it couldn't read", async () => {
    pty.read = async () => {
      throw new Error("timed out");
    };
    await expect(handleHold(ctx, "term-1", "ship it")).resolves.toEqual({
      held: false,
      reason: "unavailable",
    });
  });

  it("lets a settled agent's send go as before", async () => {
    pty.read = async () => info({ agentState: "waiting", waitingReason: "prompt" });
    await expect(handleHold(ctx, "term-1", "ship it")).resolves.toEqual({
      held: false,
      reason: "not-busy",
    });
  });

  it("passes on the queue's refusal", async () => {
    pty.read = async () => info();
    queue.hold.mockReturnValue({ ok: false, reason: "already-held" });
    await expect(handleHold(ctx, "term-1", "ship it")).resolves.toEqual({
      held: false,
      reason: "already-held",
    });
  });
});

describe("handleSendNow", () => {
  const ctx = { projectId: "project-1", endpoint: undefined } as unknown as IpcContext;

  beforeEach(() => {
    lease.service = null;
    queue.sendNow.mockReset().mockResolvedValue({ outcome: "sending" });
  });

  it("asks the drive lease, each time, whether the asking screen drives", async () => {
    const driving = { value: true };
    lease.service = { isDriving: (projectId) => projectId === "project-1" && driving.value };
    const local = {
      projectId: "project-1",
      endpoint: { kind: "local", endpointId: "view-1" },
    } as unknown as IpcContext;
    await handleSendNow(local, "term-1", "token-1");
    const [request] = queue.sendNow.mock.calls[0]!;
    expect(request.authorize()).toBe(true);
    driving.value = false;
    expect(request.authorize()).toBe(false);
  });

  it("sends this view's own project's held send, with the view's word on its input", async () => {
    await expect(handleSendNow(ctx, "term-1", "token-1", true)).resolves.toEqual({
      outcome: "sending",
    });
    const [request] = queue.sendNow.mock.calls[0]!;
    expect(request).toMatchObject({
      terminalId: "term-1",
      token: "token-1",
      projectId: "project-1",
      inputBlocked: true,
    });
    // With no drive lease in play, the asking screen drives.
    expect(request.authorize()).toBe(true);

    await handleSendNow(ctx, "term-1", "token-1");
    expect(queue.sendNow.mock.calls[1]![0]).toMatchObject({ inputBlocked: false });
  });

  it("touches nothing for a view with no project or a remote view", async () => {
    const noProject = { projectId: undefined, endpoint: undefined } as unknown as IpcContext;
    const remote = {
      projectId: "project-1",
      endpoint: { kind: "remote-view", projectId: "project-1" },
    } as unknown as IpcContext;
    await expect(handleSendNow(noProject, "term-1", "token-1")).resolves.toEqual({
      outcome: "not-held",
    });
    await expect(handleSendNow(remote, "term-1", "token-1")).resolves.toEqual({
      outcome: "not-held",
    });
    expect(queue.sendNow).not.toHaveBeenCalled();
  });

  it("refuses a malformed request", async () => {
    await expect(handleSendNow(ctx, "", "token-1")).rejects.toThrow();
    await expect(handleSendNow(ctx, "term-1", "")).rejects.toThrow();
    await expect(
      handleSendNow(ctx, "term-1", "token-1", "yes" as unknown as boolean)
    ).rejects.toThrow();
    expect(queue.sendNow).not.toHaveBeenCalled();
  });
});
