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
vi.mock("../../runtime.js", () => ({
  getRemoteService: (key: string) =>
    key === "remoteHostsClient"
      ? { list: () => [{ descriptor: { id: "studio", name: "Studio Mac" } }] }
      : undefined,
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
import { HOST_DISPATCHABLE_ACTION_IDS, installViewReverseRequests } from "../viewRequests.js";

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
  it("runs a host's MCP dispatch in the addressed view under this Shell's own approval", async () => {
    installViewReverseRequests();
    m.dispatchActionForHost.mockResolvedValue({
      result: { ok: true, result: 1 },
      confirmationDecision: "approved",
      approvalScope: "session",
      dispatchedWorkspace: { workspaceId: "local-secret" },
    });

    const answer = await ask("mcp:dispatch-action", {
      actionId: "worktree.delete",
      args: { worktreeId: "/srv/wt", force: true },
      confirmed: true,
      context: { projectId: "someone-elses-project" },
      callerInfo: { name: "ignored" },
      sessionOrigin: "help",
      offerSessionApproval: true,
    });

    // Never pre-confirmed, never the host's context or origin: the view's own
    // binding decides the project, and a confirm-gated action raises this
    // Shell's dialog naming the host that asked.
    expect(m.dispatchActionForHost).toHaveBeenCalledWith(
      11,
      "worktree.delete",
      { worktreeId: "/srv/wt", force: true },
      false,
      undefined,
      "external",
      undefined,
      { userAgent: 'Agent on host "Studio Mac"', token4LastChars: "udio" }
    );
    // No reusable approval goes back to the host.
    expect(answer).toEqual({
      result: { ok: true, result: 1 },
      confirmationDecision: "approved",
    });
  });

  it("passes an approval-only request through, still unconfirmed", async () => {
    installViewReverseRequests();
    m.dispatchActionForHost.mockResolvedValue({ result: { ok: true, result: null } });
    await ask("mcp:dispatch-action", {
      actionId: "terminal.new",
      args: {},
      confirmed: true,
      sessionOrigin: "external",
      approvalOnly: true,
    });
    expect(m.dispatchActionForHost.mock.calls[0]?.[3]).toBe(false);
    expect(m.dispatchActionForHost.mock.calls[0]?.[6]).toEqual({ approvalOnly: true });
  });

  it.each([
    "terminal.paste",
    "terminal.copy",
    "worktree.copyContext",
    "copyTree.generateAndCopyFile",
    "system.openExternal",
    "worktree.openEditor",
    "worktree.openPR",
    "app.settings.open",
    "plugin.install",
    "acme.plugin.doThing",
    "workspace.list",
  ])("refuses %s from a host without touching the view", async (actionId) => {
    installViewReverseRequests();
    const answer = await ask("mcp:dispatch-action", {
      actionId,
      args: {},
      confirmed: true,
      sessionOrigin: "external",
    });
    expect(answer).toMatchObject({ result: { ok: false, error: { code: "NOT_FOUND" } } });
    expect(m.dispatchActionForHost).not.toHaveBeenCalled();
  });

  it("allows no clipboard, external-URL, settings or plugin action", () => {
    for (const id of HOST_DISPATCHABLE_ACTION_IDS) {
      expect(id).not.toMatch(
        /paste|copy|clipboard|openExternal|openEditor|openPR|openIssue|settings|plugin/i
      );
    }
  });

  it("refuses a malformed dispatch without touching the view", async () => {
    installViewReverseRequests();
    await expect(
      ask("mcp:dispatch-action", { actionId: "", confirmed: "yes", sessionOrigin: "root" })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(m.dispatchActionForHost).not.toHaveBeenCalled();
  });

  it("describes only what a host may run from the addressed view's manifest", async () => {
    installViewReverseRequests();
    m.requestManifestForHost.mockResolvedValue([
      { id: "terminal.new" },
      { id: "terminal.paste" },
      { id: "acme.plugin.doThing" },
    ]);
    await expect(ask("mcp:get-manifest")).resolves.toEqual([{ id: "terminal.new" }]);
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
