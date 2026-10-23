import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalAssistantService } from "../../../services/GlobalAssistantService.js";

let service: GlobalAssistantService;
vi.mock("../../../services/globalAssistant.js", () => ({
  getGlobalAssistantService: () => service,
}));

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
