import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  dispatchActionForHost: vi.fn(),
  requestManifestForHost: vi.fn(),
  showHostNotification: vi.fn(() => true),
}));

vi.mock("../../../services/McpServerService.js", () => ({
  mcpServerService: {
    dispatchActionForHost: m.dispatchActionForHost,
    requestManifestForHost: m.requestManifestForHost,
  },
}));
vi.mock("../../hybrid/notifications.js", () => ({
  NOTIFICATION_SHOW_METHOD: "notification.show",
  showHostNotification: m.showHostNotification,
}));

import {
  _resetReverseRequestMethodsForTesting,
  answerReverseRequest,
  registerReverseRequestMethod,
} from "../reverseRequests.js";
import { installViewReverseRequests } from "../viewRequests.js";

function ask(method: string, payload: unknown = {}) {
  return answerReverseRequest({ hostId: "studio", webContentsId: 11, method, payload });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetReverseRequestMethodsForTesting();
});

afterEach(() => _resetReverseRequestMethodsForTesting());

describe("reverse request registry", () => {
  it("refuses a method nobody registered", async () => {
    await expect(ask("plugin:prompt")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("routes by method and removes only the handler it registered", async () => {
    const first = vi.fn(() => "first");
    const second = vi.fn(() => "second");
    const removeFirst = registerReverseRequestMethod("x", first);
    const removeSecond = registerReverseRequestMethod("x", second);
    removeFirst();
    await expect(ask("x", 1)).resolves.toBe("second");
    expect(second).toHaveBeenCalledWith({
      hostId: "studio",
      webContentsId: 11,
      method: "x",
      payload: 1,
    });
    removeSecond();
    await expect(ask("x")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});

describe("view reverse requests", () => {
  it("runs a host's MCP dispatch in the addressed view and returns only what the host reads", async () => {
    installViewReverseRequests();
    m.dispatchActionForHost.mockResolvedValue({
      result: { ok: true, result: 1 },
      confirmationDecision: "approved",
      approvalScope: "session",
      dispatchedWorkspace: { workspaceId: "local-secret" },
    });

    const answer = await ask("mcp:dispatch-action", {
      actionId: "terminal.new",
      args: { cwd: "/srv" },
      confirmed: true,
      context: { projectId: "p1" },
      callerInfo: { name: "ignored" },
      sessionOrigin: "external",
      offerSessionApproval: true,
    });

    expect(m.dispatchActionForHost).toHaveBeenCalledWith(
      11,
      "terminal.new",
      { cwd: "/srv" },
      true,
      { projectId: "p1" },
      "external",
      { offerSessionApproval: true }
    );
    expect(answer).toEqual({
      result: { ok: true, result: 1 },
      confirmationDecision: "approved",
      approvalScope: "session",
    });
  });

  it("refuses a malformed dispatch without touching the view", async () => {
    installViewReverseRequests();
    await expect(
      ask("mcp:dispatch-action", { actionId: "", confirmed: "yes", sessionOrigin: "root" })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(m.dispatchActionForHost).not.toHaveBeenCalled();
  });

  it("reads the addressed view's manifest", async () => {
    installViewReverseRequests();
    m.requestManifestForHost.mockResolvedValue([{ id: "a" }]);
    await expect(ask("mcp:get-manifest")).resolves.toEqual([{ id: "a" }]);
    expect(m.requestManifestForHost).toHaveBeenCalledWith(11);
  });

  it("shows a host's notification as the addressed view's", async () => {
    installViewReverseRequests();
    const payload = { title: "Done", body: "claude finished", silent: false };
    await expect(ask("notification.show", payload)).resolves.toBeNull();
    expect(m.showHostNotification).toHaveBeenCalledWith(11, payload);

    m.showHostNotification.mockReturnValueOnce(false);
    await expect(ask("notification.show", { title: 1 })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("stops answering once uninstalled", async () => {
    const uninstall = installViewReverseRequests();
    uninstall();
    await expect(ask("mcp:get-manifest")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});
