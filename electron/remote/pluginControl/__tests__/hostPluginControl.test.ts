import { describe, expect, it, vi } from "vitest";
import type { ActionDispatchResult } from "../../../../shared/types/actions.js";
import type { ViewlessActionRequest } from "../../../services/viewless/ViewlessActionExecutor.js";
import { executeViewlessAction } from "../../../services/viewless/ViewlessActionExecutor.js";
import { PluginFrontendMethod } from "../../../services/plugin/pluginFrontendRequests.js";
import { senderIdForCredential } from "../../assistant/hostSenders.js";
import {
  makeDeps,
  makeHosts,
  PROJECT,
} from "../../../services/viewless/__tests__/viewlessTestDeps.js";
import {
  createHostPluginControl,
  leaseStanding,
  type HostPluginAuditEntry,
  type HostPluginControlDeps,
  type HostPluginStanding,
} from "../hostPluginControl.js";
import { pluginCredentialFor, pluginSenderIdFor } from "../linkMethods.js";

const SHELL_SECRET = "s".repeat(43);
const OTHER_SHELL_SECRET = "t".repeat(43);
const CREDENTIAL = pluginCredentialFor(SHELL_SECRET);
const OTHER_SHELL_CREDENTIAL = pluginCredentialFor(OTHER_SHELL_SECRET);
const PLUGIN_ID = "acme.beads";
const LINK = "link-1";
const CALLER = { linkSessionId: LINK, shellName: "Greg's MacBook" };

interface FakeTerminal {
  projectId: string;
  agentState: string;
}

function harness(
  options: {
    standing?: HostPluginStanding;
    acceptsRemoteControl?: boolean;
    viewless?: (request: ViewlessActionRequest) => Promise<ActionDispatchResult | null>;
    viewlessForms?: string[];
  } = {}
) {
  let standing: HostPluginStanding = options.standing ?? { kind: "vacant" };
  let accepts = options.acceptsRemoteControl ?? true;
  const audits: HostPluginAuditEntry[] = [];
  const terminals = new Map<string, FakeTerminal>();
  const pty = {
    write: vi.fn(),
    submit: vi.fn(),
    batchDoubleEscape: vi.fn(),
    getTerminalAsync: vi.fn(async (id: string) => {
      const t = terminals.get(id);
      return t
        ? {
            id,
            cwd: "/repo",
            spawnedAt: 1,
            kind: "terminal",
            hasPty: true,
            detectedAgentId: "claude",
            ...t,
          }
        : null;
    }),
    getSerializedStateAsync: vi.fn(async () => ({ data: "" })),
    getTerminalProjectId: (id: string) => terminals.get(id)?.projectId ?? null,
  };
  const runWithoutView = vi.fn(
    options.viewless ??
      (async (request: ViewlessActionRequest): Promise<ActionDispatchResult | null> => {
        const stop = request.checkWrite?.(false);
        if (stop) throw stop;
        if (request.actionId === "agent.launch") {
          terminals.set("remote-1", { projectId: PROJECT.id, agentState: "working" });
          return { ok: true, result: { launched: true, terminalId: "remote-1" } };
        }
        return { ok: true, result: { ran: request.actionId } };
      })
  );
  const deps: HostPluginControlDeps = {
    acceptsRemoteControl: () => accepts,
    hasProject: async (projectId) => projectId === PROJECT.id,
    standing: vi.fn(() => standing),
    hasViewlessForm: (actionId) =>
      (options.viewlessForms ?? ["agent.launch", "worktree.list", "worktree.delete"]).includes(
        actionId
      ),
    runWithoutView,
    audit: (entry) => audits.push(entry),
    pty: () => pty as unknown as ReturnType<HostPluginControlDeps["pty"]>,
  };
  const control = createHostPluginControl(deps);
  return {
    control,
    deps,
    audits,
    pty,
    terminals,
    runWithoutView,
    setStanding: (next: HostPluginStanding) => {
      standing = next;
    },
    setAccepts: (next: boolean) => {
      accepts = next;
    },
  };
}

function dispatch(actionId: string, args: unknown = {}, overrides: Record<string, unknown> = {}) {
  return {
    credential: CREDENTIAL,
    pluginId: PLUGIN_ID,
    projectId: PROJECT.id,
    actionId,
    args,
    ...overrides,
  };
}

describe("a Shell plugin's identity on a host (#16767)", () => {
  it("is never the Shell assistant's sender, from the same per-host secret", () => {
    expect(CREDENTIAL).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(CREDENTIAL).not.toBe(SHELL_SECRET);
    expect(pluginSenderIdFor(CREDENTIAL)).not.toBe(senderIdForCredential(SHELL_SECRET));
    // Presented as an assistant credential, it proves a different sender again.
    expect(senderIdForCredential(CREDENTIAL)).not.toBe(pluginSenderIdFor(CREDENTIAL));
    expect(pluginCredentialFor(OTHER_SHELL_SECRET)).not.toBe(CREDENTIAL);
  });
});

describe("host admission of a Shell plugin's dispatch (#16767)", () => {
  it("refuses everything while the host takes no calls from other machines", async () => {
    const h = harness({ acceptsRemoteControl: false });
    const result = await h.control.dispatch(CALLER, dispatch("worktree.list"));
    expect(result).toMatchObject({ ok: false, error: { code: "HOST_REFUSED" } });
    expect(h.runWithoutView).not.toHaveBeenCalled();
  });

  it("refuses an action closed to plugin dispatch before anything runs", async () => {
    const h = harness({ viewlessForms: ["terminal.sendKeys"] });
    const result = await h.control.dispatch(
      CALLER,
      dispatch("terminal.sendKeys", { terminalId: "t", keys: ["Enter"] })
    );
    expect(result).toMatchObject({ ok: false, error: { code: "RESTRICTED" } });
    expect(h.runWithoutView).not.toHaveBeenCalled();
    expect(h.deps.standing).not.toHaveBeenCalled();
  });

  it("never reaches an action a plugin installed on the host contributes", async () => {
    const endpoint = { request: vi.fn() };
    const h = harness({ standing: { kind: "own-view", endpoint } });
    const result = await h.control.dispatch(CALLER, dispatch("acme.host-plugin.deploy"));
    expect(result).toMatchObject({ ok: false, error: { code: "RESTRICTED" } });
    expect(endpoint.request).not.toHaveBeenCalled();
    expect(h.runWithoutView).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND for a project the host doesn't have", async () => {
    const h = harness();
    const result = await h.control.dispatch(
      CALLER,
      dispatch("worktree.list", {}, { projectId: "nope" })
    );
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(h.runWithoutView).not.toHaveBeenCalled();
  });

  it("runs in the calling Shell's own driving view as a plugin dispatch", async () => {
    const endpoint = {
      request: vi.fn(async () => ({ ok: true, result: { worktrees: [] } })),
    };
    const h = harness({ standing: { kind: "own-view", endpoint } });

    const result = await h.control.dispatch(CALLER, dispatch("worktree.list", { all: true }));

    expect(result).toEqual({ ok: true, result: { worktrees: [] } });
    expect(endpoint.request).toHaveBeenCalledWith(
      PluginFrontendMethod.DISPATCH,
      { pluginId: PLUGIN_ID, actionId: "worktree.list", args: { all: true } },
      expect.anything()
    );
    expect(h.runWithoutView).not.toHaveBeenCalled();
  });

  it("runs in the host itself as a plugin, never confirmed, while nobody drives the project", async () => {
    const h = harness();
    await h.control.dispatch(CALLER, dispatch("worktree.list"));
    const request = h.runWithoutView.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      workspaceId: PROJECT.id,
      actionId: "worktree.list",
      source: "plugin",
      confirmed: false,
    });
    expect(request).not.toHaveProperty("requestApproval");
    expect(request).not.toHaveProperty("authorization");
    expect(request).not.toHaveProperty("sessionOrigin");
  });

  it("refuses a change another screen drives, but still answers a read", async () => {
    const h = harness({ standing: { kind: "elsewhere", holderName: "Laptop" } });

    const change = await h.control.dispatch(CALLER, dispatch("agent.launch", { agentId: "claude" }));
    expect(change).toMatchObject({ ok: false, error: { code: "DRIVEN_ELSEWHERE" } });
    expect(change.ok ? "" : change.error.message).toContain("Laptop");

    h.runWithoutView.mockImplementationOnce(async () => ({ ok: true, result: { worktrees: [] } }));
    expect(await h.control.dispatch(CALLER, dispatch("worktree.list"))).toMatchObject({ ok: true });
  });

  it("refuses an action only a view can run while another screen drives, rather than routing it there", async () => {
    const h = harness({ standing: { kind: "elsewhere", holderName: null } });
    const result = await h.control.dispatch(CALLER, dispatch("terminal.moveToDock", { terminalId: "t" }));
    expect(result).toMatchObject({ ok: false, error: { code: "DRIVEN_ELSEWHERE" } });
  });

  it("refuses a confirm-gated action on the host, asking nobody", async () => {
    const hosts = makeHosts();
    const { deps: viewlessDeps, invoke } = makeDeps({ getWorkspaceHosts: () => hosts });
    const h = harness({ viewless: (request) => executeViewlessAction(request, viewlessDeps) });

    const result = await h.control.dispatch(
      CALLER,
      dispatch("worktree.delete", { worktreeId: "/repo-wt/feature" })
    );

    expect(result).toMatchObject({ ok: false, error: { code: "CONFIRMATION_REQUIRED" } });
    expect(hosts.getDeletePreview).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("records each call in the host's audit under the plugin and the Shell it came from", async () => {
    const h = harness();
    await h.control.dispatch(CALLER, dispatch("worktree.list"));
    await h.control.dispatch(CALLER, dispatch("terminal.sendCommand", { terminalId: "t" }));

    expect(h.audits).toEqual([
      expect.objectContaining({
        pluginId: PLUGIN_ID,
        shellName: CALLER.shellName,
        actionId: `dispatch:${PROJECT.id}:worktree.list`,
        result: "success",
      }),
      expect.objectContaining({
        pluginId: PLUGIN_ID,
        shellName: CALLER.shellName,
        actionId: `dispatch:${PROJECT.id}:terminal.sendCommand`,
        result: "restricted",
      }),
    ]);
  });
});

describe("agents a Shell plugin launched on a host (#16767)", () => {
  async function launched(h: ReturnType<typeof harness>, overrides: Record<string, unknown> = {}) {
    const result = await h.control.dispatch(
      CALLER,
      dispatch("agent.launch", { agentId: "claude" }, overrides)
    );
    expect(result.ok).toBe(true);
  }

  function input(overrides: Record<string, unknown> = {}) {
    return {
      credential: CREDENTIAL,
      pluginId: PLUGIN_ID,
      terminalId: "remote-1",
      input: { op: "interrupt" as const },
      ...overrides,
    };
  }

  it("records the launch as that plugin's, and interrupt reaches it", async () => {
    const h = harness();
    await launched(h);
    expect(h.control.launchedBy("remote-1")).toEqual({ pluginId: PLUGIN_ID, projectId: PROJECT.id });

    const answer = await h.control.agentInput(CALLER, input());
    expect(answer.status).toBe("sent");
    expect(h.pty.batchDoubleEscape).toHaveBeenCalledWith(["remote-1"]);
  });

  it("refuses another plugin, another Shell's same plugin, and an agent nobody launched through here", async () => {
    const h = harness();
    await launched(h);
    h.terminals.set("user-1", { projectId: PROJECT.id, agentState: "working" });

    expect(await h.control.agentInput(CALLER, input({ pluginId: "acme.other" }))).toEqual({
      status: "not-found",
    });
    expect(
      await h.control.agentInput(CALLER, input({ credential: OTHER_SHELL_CREDENTIAL }))
    ).toEqual({ status: "not-found" });
    expect(await h.control.agentInput(CALLER, input({ terminalId: "user-1" }))).toEqual({
      status: "not-found",
    });
    expect(h.pty.batchDoubleEscape).not.toHaveBeenCalled();
  });

  it("records nothing for a launch that chose its own id", async () => {
    const h = harness({
      viewless: async () => ({ ok: true, result: { launched: true, terminalId: "chosen" } }),
    });
    await h.control.dispatch(
      CALLER,
      dispatch("agent.launch", { agentId: "claude", requestedId: "chosen" })
    );
    expect(h.control.launchedBy("chosen")).toBeNull();
  });

  it("stops at the drive lease: another screen driving the project gets driven-elsewhere", async () => {
    const h = harness();
    await launched(h);
    h.setStanding({ kind: "elsewhere", holderName: "Laptop" });

    expect(
      await h.control.agentInput(CALLER, input({ input: { op: "submit", text: "continue" } }))
    ).toEqual({ status: "driven-elsewhere", holderName: "Laptop" });
    expect(h.pty.submit).not.toHaveBeenCalled();
  });

  it("refuses input once the host stops taking calls from other machines", async () => {
    const h = harness();
    await launched(h);
    h.setAccepts(false);
    expect((await h.control.agentInput(CALLER, input())).status).toBe("refused");
    expect(h.pty.batchDoubleEscape).not.toHaveBeenCalled();
  });

  it("presses keys and submits through the same ownership check", async () => {
    const h = harness();
    await launched(h);
    expect(
      await h.control.agentInput(CALLER, input({ input: { op: "sendKeys", keys: ["Escape"] } }))
    ).toEqual({ status: "sent", keys: ["Escape"] });
    expect(
      await h.control.agentInput(CALLER, input({ input: { op: "submit", text: "/compact" } }))
    ).toEqual({ status: "sent" });
    expect(h.pty.write).toHaveBeenCalledTimes(1);
    expect(h.pty.submit).toHaveBeenCalledWith("remote-1", "/compact");
  });
});

describe("leaseStanding (#16767)", () => {
  const endpoint = (kind: "local-view" | "remote-view", linkSessionId?: string) =>
    ({ kind, linkSessionId }) as never;

  it("is the calling Shell's own view only for a remote view on its own link", () => {
    expect(
      leaseStanding(
        () => ({ state: "live", endpoint: endpoint("remote-view", LINK) }),
        PROJECT.id,
        LINK,
        false
      ).kind
    ).toBe("own-view");
    expect(
      leaseStanding(
        () => ({ state: "live", endpoint: endpoint("remote-view", "link-2"), holderName: "Laptop" }),
        PROJECT.id,
        LINK,
        false
      )
    ).toEqual({ kind: "elsewhere", holderName: "Laptop" });
    expect(
      leaseStanding(
        () => ({ state: "live", endpoint: endpoint("local-view") }),
        PROJECT.id,
        LINK,
        false
      ).kind
    ).toBe("elsewhere");
  });

  it("tells the lease of a change only when asked for one, and fails closed with no lease", () => {
    const resolve = vi.fn((_projectId: string, _change?: { linkSessionId: string | null }) => ({
      state: "vacant" as const,
    }));
    leaseStanding(resolve, PROJECT.id, LINK, false);
    leaseStanding(resolve, PROJECT.id, LINK, true);
    expect(resolve.mock.calls.map(([, change]) => change)).toEqual([
      undefined,
      { linkSessionId: LINK },
    ]);
    expect(leaseStanding(() => null, PROJECT.id, LINK, true).kind).toBe("elsewhere");
  });
});
