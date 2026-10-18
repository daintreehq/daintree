import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  dispatchActionForHost: vi.fn(),
  requestManifestForHost: vi.fn(),
  showHostNotification: vi.fn(() => true),
  // Hosts this Shell's assistant has a `host.call` out to right now (#13493).
  callsOut: new Set<string>(),
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
      : key === "hostCallRelayClient"
        ? { hasCallInFlight: (hostId: string) => m.callsOut.has(hostId) }
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
  m.callsOut.clear();
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
      { userAgent: 'Agent on host "Studio Mac"', token4LastChars: "" }
    );
    // No reusable approval goes back to the host.
    expect(answer).toEqual({
      result: { ok: true, result: 1 },
      confirmationDecision: "approved",
    });
  });

  it("names this Shell's own assistant as asking only while it has a call out to that host (#13493)", async () => {
    installViewReverseRequests();
    m.dispatchActionForHost.mockResolvedValue({ result: { ok: true, result: 1 } });
    const relayed = {
      actionId: "worktree.delete",
      args: { worktreeId: "/srv/wt" },
      confirmed: false,
      sessionOrigin: "external",
      relayed: true,
    };
    const askedBy = () => m.dispatchActionForHost.mock.calls.at(-1)?.[7];

    // A host can say anything; with no call out, it is just an agent there.
    await ask("mcp:dispatch-action", relayed);
    expect(askedBy()).toEqual({ userAgent: 'Agent on host "Studio Mac"', token4LastChars: "" });

    m.callsOut.add("studio");
    await ask("mcp:dispatch-action", relayed);
    expect(askedBy()).toEqual({
      userAgent: 'Your assistant, through host "Studio Mac"',
      token4LastChars: "",
    });
    // Still never pre-confirmed: the person answers this Shell's own dialog.
    expect(m.dispatchActionForHost.mock.calls.at(-1)?.[3]).toBe(false);

    m.callsOut.clear();
    await ask("mcp:dispatch-action", relayed);
    expect(askedBy()).toEqual({ userAgent: 'Agent on host "Studio Mac"', token4LastChars: "" });
  });

  it("runs the host assistant's call under its Never ask without this Shell's dialog", async () => {
    installViewReverseRequests();
    m.dispatchActionForHost.mockResolvedValue({ result: { ok: true, result: 1 } });

    const answer = await ask("mcp:dispatch-action", {
      actionId: "worktree.createWithRecipe",
      args: { source: { kind: "newBranch", branchName: "work" }, recipeId: "inrepo-work" },
      confirmed: true,
      sessionOrigin: "help",
      authorization: "skip-preference",
    });

    expect(m.dispatchActionForHost).toHaveBeenCalledWith(
      11,
      "worktree.createWithRecipe",
      { source: { kind: "newBranch", branchName: "work" }, recipeId: "inrepo-work" },
      true,
      undefined,
      "external",
      { authorization: "skip-preference" },
      { userAgent: 'Agent on host "Studio Mac"', token4LastChars: "" }
    );
    expect(answer).toEqual({ result: { ok: true, result: 1 } });
  });

  it.each([
    ["an agent pane", { sessionOrigin: "assistant-pane", authorization: "skip-preference" }],
    ["an api-key client", { sessionOrigin: "external", authorization: "skip-preference" }],
    ["another authorization", { sessionOrigin: "help", authorization: "native-grant" }],
    ["no authorization", { sessionOrigin: "help" }],
    [
      "an unconfirmed call",
      { sessionOrigin: "help", authorization: "skip-preference", confirmed: false },
    ],
  ])("asks this Shell for %s even when the host claims a skip", async (_label, fields) => {
    installViewReverseRequests();
    m.dispatchActionForHost.mockResolvedValue({ result: { ok: true, result: null } });
    await ask("mcp:dispatch-action", {
      actionId: "worktree.delete",
      args: { worktreeId: "/srv/wt" },
      confirmed: true,
      ...fields,
    });
    expect(m.dispatchActionForHost.mock.calls[0]?.[3]).toBe(false);
    expect(m.dispatchActionForHost.mock.calls[0]?.[6]).toBeUndefined();
  });

  it.each(["host.switch", "project.openOnHost"])(
    "always asks before %s moves this window, Never ask or not",
    async (actionId) => {
      installViewReverseRequests();
      m.dispatchActionForHost.mockResolvedValue({ result: { ok: true, result: null } });
      await ask("mcp:dispatch-action", {
        actionId,
        args: { hostId: "local" },
        confirmed: true,
        sessionOrigin: "help",
        authorization: "skip-preference",
      });
      expect(m.dispatchActionForHost.mock.calls[0]?.[3]).toBe(false);
      expect(m.dispatchActionForHost.mock.calls[0]?.[6]).toBeUndefined();
    }
  );

  it("still raises an approval-only request's dialog under Never ask", async () => {
    installViewReverseRequests();
    m.dispatchActionForHost.mockResolvedValue({ result: { ok: true, result: null } });
    await ask("mcp:dispatch-action", {
      actionId: "terminal.new",
      args: {},
      confirmed: true,
      sessionOrigin: "help",
      authorization: "skip-preference",
      approvalOnly: true,
    });
    expect(m.dispatchActionForHost.mock.calls[0]?.[3]).toBe(false);
    expect(m.dispatchActionForHost.mock.calls[0]?.[6]).toEqual({ approvalOnly: true });
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

  it("carries an approval-only request's reason, so a protected close lists its panels", async () => {
    installViewReverseRequests();
    m.dispatchActionForHost.mockResolvedValue({ result: { ok: true, result: null } });
    await ask("mcp:dispatch-action", {
      actionId: "terminal.new",
      args: {},
      confirmed: false,
      sessionOrigin: "external",
      approvalOnly: true,
      approvalReason: "protected-close",
    });
    await ask("mcp:dispatch-action", {
      actionId: "terminal.new",
      args: {},
      confirmed: false,
      sessionOrigin: "external",
      approvalReason: "protected-close",
    });
    expect(m.dispatchActionForHost.mock.calls[0]?.[6]).toEqual({
      approvalOnly: true,
      approvalReason: "protected-close",
    });
    // A reason without approval-only changes nothing about the dispatch.
    expect(m.dispatchActionForHost.mock.calls[1]?.[6]).toBeUndefined();
  });

  it("refuses an approval reason this Shell does not know", async () => {
    installViewReverseRequests();
    await expect(
      ask("mcp:dispatch-action", {
        actionId: "terminal.new",
        args: {},
        confirmed: false,
        sessionOrigin: "external",
        approvalOnly: true,
        approvalReason: "skip-everything",
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
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
    "diagnostics.openReview",
    "file.openPanel",
    "file.read",
    "file.openDiff",
    "file.openInEditor",
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

  it.each(["browser.captureScreenshot", "file.view", "host.switch", "project.openOnHost"])(
    "runs %s for a host, unconfirmed, so the view decides",
    async (actionId) => {
      installViewReverseRequests();
      m.dispatchActionForHost.mockResolvedValue({ result: { ok: true, result: null } });
      await ask("mcp:dispatch-action", {
        actionId,
        args: {},
        confirmed: true,
        sessionOrigin: "external",
      });
      expect(m.dispatchActionForHost).toHaveBeenCalledWith(
        11,
        actionId,
        {},
        false,
        undefined,
        "external",
        undefined,
        { userAgent: 'Agent on host "Studio Mac"', token4LastChars: "" }
      );
    }
  );

  it.each([
    "terminal.moveToWorktree",
    "terminal.sendKeys",
    "terminal.closeMany",
    "workspace.list",
    "slashCommands.list",
  ])("runs %s, a project-bound action a host's orchestrator drives", async (actionId) => {
    installViewReverseRequests();
    m.dispatchActionForHost.mockResolvedValue({ result: { ok: true, result: null } });
    await ask("mcp:dispatch-action", {
      actionId,
      args: {},
      confirmed: false,
      sessionOrigin: "external",
    });
    expect(m.dispatchActionForHost.mock.calls[0]?.[1]).toBe(actionId);
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

  it("shows a host the tools its own MCP server answers, though they never run here", async () => {
    installViewReverseRequests();
    m.requestManifestForHost.mockResolvedValue([
      { id: "mcp.surface" },
      { id: "agent.launchMany" },
      { id: "terminal.notifyWhenIdle" },
      { id: "terminal.moveToWorktree" },
      { id: "diagnostics.openReview" },
    ]);
    await expect(ask("mcp:get-manifest")).resolves.toEqual([
      { id: "mcp.surface" },
      { id: "agent.launchMany" },
      { id: "terminal.notifyWhenIdle" },
      { id: "terminal.moveToWorktree" },
    ]);
  });

  it("narrows a registry search to what a host may run", async () => {
    installViewReverseRequests();
    m.dispatchActionForHost.mockResolvedValue({
      result: {
        ok: true,
        result: {
          totalMatches: 3,
          results: [{ id: "terminal.paste" }, { id: "terminal.moveToWorktree" }, { id: 7 }],
        },
      },
    });
    const answer = await ask("mcp:dispatch-action", {
      actionId: "actions.search",
      args: { query: "terminal" },
      confirmed: false,
      sessionOrigin: "external",
    });
    expect(answer).toEqual({
      result: {
        ok: true,
        result: { totalMatches: 1, results: [{ id: "terminal.moveToWorktree" }] },
      },
    });
  });

  it("narrows a registry page but keeps the view's paging, so the host walks on", async () => {
    installViewReverseRequests();
    m.dispatchActionForHost.mockResolvedValue({
      result: {
        ok: true,
        result: {
          actions: [{ id: "app.settings.open" }, { id: "terminal.paste" }],
          total: 250,
          limit: 100,
          offset: 0,
          hasMore: true,
        },
      },
    });
    const answer = await ask("mcp:dispatch-action", {
      actionId: "actions.list",
      args: { offset: 0, limit: 100 },
      confirmed: false,
      sessionOrigin: "external",
    });
    expect(answer).toEqual({
      result: {
        ok: true,
        result: { actions: [], total: 250, limit: 100, offset: 0, hasMore: true },
      },
    });
  });

  it("answers a schema read for an action a host may not run as not found", async () => {
    installViewReverseRequests();
    m.dispatchActionForHost
      .mockResolvedValueOnce({
        result: {
          ok: true,
          result: { ok: true, entry: { id: "terminal.paste" }, policy: null, error: null },
        },
      })
      .mockResolvedValueOnce({
        result: {
          ok: true,
          result: { ok: true, entry: { id: "terminal.sendKeys" }, policy: null, error: null },
        },
      });
    const read = (actionId: string) =>
      ask("mcp:dispatch-action", {
        actionId: "actions.getSchema",
        args: { actionId },
        confirmed: false,
        sessionOrigin: "external",
      });

    await expect(read("terminal.paste")).resolves.toMatchObject({
      result: { ok: true, result: { ok: false, entry: null, error: { code: "NOT_FOUND" } } },
    });
    await expect(read("terminal.sendKeys")).resolves.toMatchObject({
      result: { ok: true, result: { ok: true, entry: { id: "terminal.sendKeys" } } },
    });
  });

  it("passes a failed registry read back untouched", async () => {
    installViewReverseRequests();
    const failure = { ok: false, error: { code: "EXECUTION_ERROR", message: "renderer gone" } };
    m.dispatchActionForHost.mockResolvedValue({ result: failure });
    await expect(
      ask("mcp:dispatch-action", {
        actionId: "actions.search",
        args: { query: "x" },
        confirmed: false,
        sessionOrigin: "external",
      })
    ).resolves.toEqual({ result: failure });
  });

  it("lists file.view to a host but none of the file actions that persist or read back", async () => {
    installViewReverseRequests();
    m.requestManifestForHost.mockResolvedValue([
      { id: "file.view" },
      { id: "file.openPanel" },
      { id: "file.read" },
      { id: "file.openDiff" },
      { id: "file.openInEditor" },
    ]);
    await expect(ask("mcp:get-manifest")).resolves.toEqual([{ id: "file.view" }]);
  });

  it("shows a host's notification as the addressed view's", async () => {
    installViewReverseRequests();
    const payload = { title: "Done", body: "claude finished", silent: false };
    await expect(ask("notification.show", payload)).resolves.toBeNull();
    expect(m.showHostNotification).toHaveBeenCalledWith(11, payload, {
      id: "studio",
      name: "Studio Mac",
    });

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
