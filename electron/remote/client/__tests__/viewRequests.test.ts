import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  dispatchActionForHost: vi.fn(),
  requestManifestForHost: vi.fn(),
  showHostNotification: vi.fn(() => true),
  closeHostNotifications: vi.fn(() => true),
  reconcileHostNotifications: vi.fn(() => true),
  // Hosts this Shell's assistant has a `host.call` out to right now (#13493).
  callsOut: new Set<string>(),
  // This Shell's runtime's verdict on a host's dispatch of one of its calls (#15698).
  skipsRelayedDispatch: vi.fn((_hostId: string, _dispatch: unknown) => false),
  // The project each view of this Shell shows, keyed as the Shell keys it.
  viewProjects: new Map<number, string>(),
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
        ? {
            hasCallInFlight: (hostId: string) => m.callsOut.has(hostId),
            skipsRelayedDispatch: m.skipsRelayedDispatch,
          }
        : undefined,
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getProjectForWebContents: (webContentsId: number) => m.viewProjects.get(webContentsId) ?? null,
}));
vi.mock("../../hybrid/notifications.js", () => ({
  NOTIFICATION_SHOW_METHOD: "notification.show",
  NOTIFICATION_CLOSE_METHOD: "notification.close",
  NOTIFICATION_RECONCILE_METHOD: "notification.reconcile",
  showHostNotification: m.showHostNotification,
  closeHostNotifications: m.closeHostNotifications,
  reconcileHostNotifications: m.reconcileHostNotifications,
}));

import { toHostScopedKey } from "../../../../shared/types/remoteHosts.js";
import {
  _resetReverseRequestMethodsForTesting,
  answerReverseRequest,
  registerReverseRequestMethod,
} from "../reverseRequests.js";
import {
  askHostApprovalInWindow,
  HOST_DISPATCHABLE_ACTION_IDS,
  installViewReverseRequests,
} from "../viewRequests.js";

function ask(method: string, payload: unknown = {}) {
  return answerReverseRequest({ hostId: "studio", webContentsId: 11, method, payload });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.callsOut.clear();
  m.skipsRelayedDispatch.mockReturnValue(false);
  m.viewProjects.clear();
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
      // The host's own pane (#14992): no terminal of this Shell's to name.
      requester: { kind: "pane", terminalId: "host-pane" },
    });

    // Never pre-confirmed, never the host's context, origin or requester: the
    // view's own binding decides the project, and a confirm-gated action raises
    // this Shell's dialog naming the host that asked.
    expect(m.dispatchActionForHost).toHaveBeenCalledWith(
      11,
      "worktree.delete",
      { worktreeId: "/srv/wt", force: true },
      false,
      undefined,
      "external",
      { fixedDeadline: true },
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
      { authorization: "skip-preference", fixedDeadline: true },
      { userAgent: 'Agent on host "Studio Mac"', token4LastChars: "" }
    );
    expect(answer).toEqual({ result: { ok: true, result: 1 } });
  });

  it.each([
    [
      "an agent pane or api-key client",
      { sessionOrigin: "external", authorization: "skip-preference" },
    ],
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
    expect(m.dispatchActionForHost.mock.calls[0]?.[6]).toEqual({ fixedDeadline: true });
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
      expect(m.dispatchActionForHost.mock.calls[0]?.[6]).toEqual({ fixedDeadline: true });
    }
  );

  describe("this Shell's own assistant's relayed call (#15698)", () => {
    const relayedDelete = {
      actionId: "worktree.delete",
      args: { worktreeId: "/srv/wt" },
      confirmed: false,
      sessionOrigin: "external",
      relayed: true,
      relayCall: { callId: "call-1", helpSessionId: "help-a" },
    };

    beforeEach(() => {
      installViewReverseRequests();
      m.callsOut.add("studio");
      m.viewProjects.set(11, toHostScopedKey("studio", "proj-2"));
      m.dispatchActionForHost.mockResolvedValue({ result: { ok: true, result: 1 } });
      m.requestManifestForHost.mockResolvedValue([
        { id: "worktree.delete", danger: "confirm" },
        { id: "agent.launch", danger: "safe" },
      ]);
    });

    it("runs it without a dialog when this Shell matches it to its own call under Never ask", async () => {
      m.skipsRelayedDispatch.mockReturnValue(true);

      const answer = await ask("mcp:dispatch-action", relayedDelete);

      // Matched against this view's own project on that host, never one the host names.
      expect(m.skipsRelayedDispatch).toHaveBeenCalledWith("studio", {
        callId: "call-1",
        helpSessionId: "help-a",
        projectId: "proj-2",
        actionId: "worktree.delete",
        args: { worktreeId: "/srv/wt" },
      });
      expect(m.dispatchActionForHost).toHaveBeenCalledWith(
        11,
        "worktree.delete",
        { worktreeId: "/srv/wt" },
        true,
        undefined,
        "external",
        { authorization: "skip-preference", fixedDeadline: true },
        { userAgent: 'Your assistant, through host "Studio Mac"', token4LastChars: "" }
      );
      // Said back, so the host's audit reads it as run under the skip.
      expect(answer).toEqual({ result: { ok: true, result: 1 }, authorization: "skip-preference" });
    });

    it("asks when this Shell won't skip it: Always ask, or not a call of its own", async () => {
      const answer = await ask("mcp:dispatch-action", relayedDelete);

      expect(m.skipsRelayedDispatch).toHaveBeenCalledTimes(1);
      expect(m.dispatchActionForHost.mock.calls[0]?.[3]).toBe(false);
      expect(m.dispatchActionForHost.mock.calls[0]?.[6]).toEqual({ fixedDeadline: true });
      expect(answer).toEqual({ result: { ok: true, result: 1 } });
    });

    it("lets a decision from the view speak over the skip it was sent with", async () => {
      m.skipsRelayedDispatch.mockReturnValue(true);
      m.dispatchActionForHost.mockResolvedValue({
        result: { ok: true, result: 1 },
        confirmationDecision: "approved",
      });

      const answer = await ask("mcp:dispatch-action", relayedDelete);

      expect(m.dispatchActionForHost.mock.calls[0]?.[3]).toBe(true);
      expect(m.dispatchActionForHost.mock.calls[0]?.[6]).toEqual({
        authorization: "skip-preference",
        fixedDeadline: true,
      });
      expect(answer).toEqual({ result: { ok: true, result: 1 }, confirmationDecision: "approved" });
    });

    it("goes by the danger the view resolves for these arguments, as its dialog does", async () => {
      m.skipsRelayedDispatch.mockReturnValue(true);
      m.requestManifestForHost.mockResolvedValue([
        { id: "worktree.createWithRecipe", danger: "safe" },
      ]);
      const create = (args: Record<string, unknown>) => ({
        ...relayedDelete,
        actionId: "worktree.createWithRecipe",
        args,
      });

      // A recipe makes the agent's call confirm-gated.
      await ask("mcp:dispatch-action", create({ recipeId: "inrepo-work" }));
      await ask("mcp:dispatch-action", create({}));

      expect(m.skipsRelayedDispatch).toHaveBeenCalledTimes(1);
      expect(m.dispatchActionForHost.mock.calls.map((call) => call[3])).toEqual([true, false]);
    });

    it("takes a call named within the link's own bounds, and refuses one past them", async () => {
      await ask("mcp:dispatch-action", {
        ...relayedDelete,
        relayCall: { callId: "c".repeat(256), helpSessionId: "h".repeat(256) },
      });
      for (const relayCall of [
        { callId: "c".repeat(257), helpSessionId: "help-a" },
        { callId: "call-1", helpSessionId: "h".repeat(257) },
      ]) {
        await expect(
          ask("mcp:dispatch-action", { ...relayedDelete, relayCall })
        ).rejects.toMatchObject({ code: "VALIDATION" });
      }
      expect(m.dispatchActionForHost).toHaveBeenCalledTimes(1);
    });

    it("leaves a call this view wouldn't ask about as it is, and its record unmarked", async () => {
      m.skipsRelayedDispatch.mockReturnValue(true);

      const answer = await ask("mcp:dispatch-action", {
        ...relayedDelete,
        actionId: "agent.launch",
        args: { agentId: "claude" },
      });

      expect(m.skipsRelayedDispatch).not.toHaveBeenCalled();
      expect(m.dispatchActionForHost.mock.calls[0]?.[3]).toBe(false);
      expect(answer).toEqual({ result: { ok: true, result: 1 } });
    });

    it("asks when the view's actions can't be read", async () => {
      m.skipsRelayedDispatch.mockReturnValue(true);
      m.requestManifestForHost.mockRejectedValue(new Error("view gone"));

      await ask("mcp:dispatch-action", relayedDelete);

      expect(m.skipsRelayedDispatch).not.toHaveBeenCalled();
      expect(m.dispatchActionForHost.mock.calls[0]?.[3]).toBe(false);
    });

    it.each([
      ["no call named", { relayCall: undefined }],
      ["an approval-only request", { approvalOnly: true }],
    ])("asks without consulting the runtime for %s", async (_label, fields) => {
      m.skipsRelayedDispatch.mockReturnValue(true);

      await ask("mcp:dispatch-action", { ...relayedDelete, ...fields });

      expect(m.skipsRelayedDispatch).not.toHaveBeenCalled();
      expect(m.dispatchActionForHost.mock.calls[0]?.[3]).toBe(false);
    });

    it.each([
      ["another host's project", toHostScopedKey("elsewhere", "proj-2")],
      ["one of this machine's own projects", "a".repeat(64)],
    ])("asks in a view showing %s", async (_label, viewProject) => {
      m.skipsRelayedDispatch.mockReturnValue(true);
      m.viewProjects.set(11, viewProject);

      await ask("mcp:dispatch-action", relayedDelete);

      expect(m.skipsRelayedDispatch).not.toHaveBeenCalled();
      expect(m.dispatchActionForHost.mock.calls[0]?.[3]).toBe(false);
    });

    it("refuses a malformed call name", async () => {
      await expect(
        ask("mcp:dispatch-action", { ...relayedDelete, relayCall: { callId: "call-1" } })
      ).rejects.toMatchObject({ code: "VALIDATION" });
      expect(m.dispatchActionForHost).not.toHaveBeenCalled();
    });
  });

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
    expect(m.dispatchActionForHost.mock.calls[0]?.[6]).toEqual({
      approvalOnly: true,
      fixedDeadline: true,
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
    expect(m.dispatchActionForHost.mock.calls[0]?.[6]).toEqual({
      approvalOnly: true,
      fixedDeadline: true,
    });
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
      fixedDeadline: true,
    });
    // A reason without approval-only changes nothing about the dispatch.
    expect(m.dispatchActionForHost.mock.calls[1]?.[6]).toEqual({ fixedDeadline: true });
  });

  // Only the retired assistant CLI's pane ever authenticated this way, so a
  // host from before its removal can still send it. Refused like any other bad
  // request: the reverse request rejects, nothing dispatches, the link stays.
  it("refuses an origin this Shell no longer knows", async () => {
    installViewReverseRequests();
    await expect(
      ask("mcp:dispatch-action", {
        actionId: "terminal.new",
        args: {},
        confirmed: false,
        sessionOrigin: "assistant-pane",
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(m.dispatchActionForHost).not.toHaveBeenCalled();
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
        { fixedDeadline: true },
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

  it("takes down a host's banners by the ids it names, scoped to that host", async () => {
    installViewReverseRequests();
    await expect(ask("notification.close", { ids: ["n1"] })).resolves.toBeNull();
    await expect(
      answerReverseRequest({
        hostId: "other",
        webContentsId: 11,
        method: "notification.close",
        payload: { ids: ["n1"] },
      })
    ).resolves.toBeNull();
    expect(m.closeHostNotifications.mock.calls).toEqual([
      [{ ids: ["n1"] }, "studio"],
      [{ ids: ["n1"] }, "other"],
    ]);

    m.closeHostNotifications.mockReturnValueOnce(false);
    await expect(ask("notification.close", { ids: "n1" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("reconciles a host's banners on the view it addressed", async () => {
    installViewReverseRequests();
    await expect(ask("notification.reconcile", { live: ["n1"] })).resolves.toBeNull();
    expect(m.reconcileHostNotifications).toHaveBeenCalledWith(11, { live: ["n1"] }, "studio");

    m.reconcileHostNotifications.mockReturnValueOnce(false);
    await expect(ask("notification.reconcile", { live: "n1" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("stops answering once uninstalled", async () => {
    const uninstall = installViewReverseRequests();
    uninstall();
    await expect(ask("mcp:get-manifest")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(ask("notification.close", { ids: ["n1"] })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});

describe("askHostApprovalInWindow (#13501)", () => {
  const QUESTION = {
    hostId: "studio",
    helpSessionId: "help-1",
    actionId: "worktree.delete",
    args: { worktreeId: "/wt/feature" },
    subject: "feature/thing",
    lines: ["No uncommitted changes."],
  };

  it("raises the action's own dialog approval-only, with the host's preview and the host named", async () => {
    m.dispatchActionForHost.mockResolvedValue({
      result: { ok: true, result: null },
      confirmationDecision: "approved",
    });

    await expect(askHostApprovalInWindow(7, QUESTION)).resolves.toBe("approved");

    expect(m.dispatchActionForHost).toHaveBeenCalledWith(
      7,
      "worktree.delete",
      { worktreeId: "/wt/feature" },
      false,
      undefined,
      "external",
      {
        approvalOnly: true,
        hostPreview: { lines: ["No uncommitted changes."], subject: "feature/thing" },
        // The host's own approval window governs a call it runs itself (#14989).
        fixedDeadline: true,
      },
      { userAgent: 'Your assistant, through host "Studio Mac"', token4LastChars: "" }
    );
  });

  it("names this machine's own assistant working in another of its projects, not a host (#14024)", async () => {
    m.dispatchActionForHost.mockResolvedValue({
      result: { ok: true, result: null },
      confirmationDecision: "rejected",
    });

    await expect(askHostApprovalInWindow(7, { ...QUESTION, hostId: "local" })).resolves.toBe(
      "rejected"
    );

    expect(m.dispatchActionForHost.mock.calls.at(-1)?.at(-1)).toEqual({
      userAgent: "Your assistant, in another project here",
      token4LastChars: "",
    });
  });

  it("reads a window that couldn't ask as no decision at all", async () => {
    m.dispatchActionForHost.mockResolvedValueOnce({
      result: { ok: false, error: { code: "NOT_FOUND", message: "not in this view" } },
    });
    await expect(askHostApprovalInWindow(7, QUESTION)).resolves.toBeNull();

    m.dispatchActionForHost.mockRejectedValueOnce(new Error("window gone"));
    await expect(askHostApprovalInWindow(7, QUESTION)).resolves.toBeNull();
  });
});
