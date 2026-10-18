import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ActionId, ActionManifestEntry } from "../../../../shared/types/actions.js";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test" },
}));

import { createSessionServer, type SessionServerDeps } from "../sessionServer.js";
import { SessionStore } from "../sessionStore.js";
import { RelayDrivenElsewhereError } from "../rendererBridge.js";
import { RELAY_CALL_ID_META_KEY } from "../shared.js";
import { relayNoticePane, type OwnPane, type TerminalNotifyHandlers } from "../terminalNotify.js";

function entry(
  id: string,
  kind: "query" | "command" = "query",
  danger: "safe" | "confirm" = "safe"
): ActionManifestEntry {
  return {
    id: id as ActionId,
    name: id,
    title: id,
    description: `description for ${id}`,
    category: "test",
    kind,
    danger,
    enabled: true,
    requiresArgs: false,
    inputSchema: { type: "object", properties: {} },
  };
}

const MANIFEST = [
  entry("terminal.list"),
  entry("agent.launch", "command"),
  entry("project.runCheck", "command"),
  entry("project.runCommand", "command"),
  entry("host.switch", "command", "confirm"),
  entry("host.call", "command"),
  entry("help.displayImage", "command"),
  entry("terminal.notifyWhenIdle", "command"),
];

interface Harness {
  client: Client;
  store: SessionStore;
  deps: SessionServerDeps;
  close(): Promise<void>;
}

const open: Harness[] = [];

afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close();
  vi.restoreAllMocks();
});

/** A relayed session as `openRelaySession` admits one: external origin, bound, at the caller's tier. */
async function relayed(
  tier: "core" | "full",
  overrides: Partial<SessionServerDeps> = {},
  relay: boolean = true
): Promise<Harness> {
  const store = new SessionStore(() => {});
  const sessionId = "relay-session";
  store.sessionTierMap.set(sessionId, tier);
  store.sessionOriginMap.set(sessionId, "external");
  store.sessionWorkspaceMap.set(sessionId, "project-1");
  const deps: SessionServerDeps = {
    sessionStore: store,
    workspaceBinding: { workspaceId: "project-1" },
    requestManifest: vi.fn().mockResolvedValue(MANIFEST),
    dispatchAction: vi.fn().mockResolvedValue({ result: { ok: true, result: { ran: true } } }),
    handleWaitUntilIdle: vi.fn(),
    handleWaitUntilIdleBatch: vi.fn(),
    handleSkillsSearch: vi.fn(() => ({ skills: [] })),
    handleSkillsLoad: vi.fn(),
    handleProjectRunCheck: vi.fn().mockResolvedValue({ passed: true }),
    handleProjectRunCommand: vi.fn(),
    handleTerminalGetStatusViewless: vi
      .fn()
      .mockResolvedValue({ terminals: [], source: "pty", unavailableFields: [] }),
    handleTerminalReadLastMessageOwned: vi
      .fn()
      .mockResolvedValue({ status: "unavailable", reason: "no-message" }),
    isTerminalIdInUse: vi.fn(() => false),
    appendAuditRecord: vi.fn(),
    getCachedManifest: vi.fn(() => MANIFEST),
    resolveOwnPane: () => null,
    ...(relay
      ? {
          relay: {
            shellName: "greg-mbp",
            refuseWrite: vi.fn(() => null),
          },
        }
      : {}),
    ...overrides,
  };
  const server = createSessionServer(sessionId, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  store.relaySessions.set(sessionId, { transport: serverTransport, server });
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const harness = {
    client,
    store,
    deps,
    close: async () => {
      await client.close();
      store.drain();
      store.grantCache.dispose();
    },
  };
  open.push(harness);
  return harness;
}

function errorCode(result: { content: unknown }): string {
  const [first] = result.content as Array<{ text: string }>;
  return (JSON.parse(first!.text) as { code: string }).code;
}

describe("a relayed session (#13493)", () => {
  it("is live for its tier only while the relay holds its transport", async () => {
    const { store } = await relayed("full");
    expect(store.getTier("relay-session")).toBe("full");
    store.revokeSession("relay-session");
    expect(store.getTier("relay-session")).toBeNull();
    expect(store.sessionWorkspaceMap.has("relay-session")).toBe(false);
  });

  it("is never offered a host tool or this machine's panel tools, whatever its tier", async () => {
    const relay = await relayed("full");
    const listed = (await relay.client.listTools()).tools.map((tool) => tool.name);

    expect(listed).toContain("terminal.list");
    expect(listed).toContain("agent.launch");
    expect(listed).not.toContain("host.switch");
    expect(listed).not.toContain("host.call");
    expect(listed).not.toContain("help.displayImage");

    // The same session without the relay is offered the host switch its tier allows.
    const plain = await relayed("full", {}, false);
    expect((await plain.client.listTools()).tools.map((tool) => tool.name)).toContain(
      "host.switch"
    );
  });

  it("refuses a host tool at the call too, before anything is dispatched", async () => {
    const relay = await relayed("full");
    const result = await relay.client.callTool({ name: "host.switch", arguments: {} });

    expect(result.isError).toBe(true);
    expect(errorCode(result as { content: unknown })).toBe("TIER_NOT_PERMITTED");
    expect(relay.deps.dispatchAction).not.toHaveBeenCalled();
  });

  it("refuses a notice before anything is sent when its relay has no way back to the Shell", async () => {
    const relay = await relayed("core");
    const result = await relay.client.callTool({
      name: "agent.launch",
      arguments: { agentId: "claude", prompt: "fix it", notify: true },
    });

    expect(result.isError).toBe(true);
    expect(errorCode(result as { content: unknown })).toBe("NOTIFY_NOT_ELIGIBLE");
    expect(relay.deps.dispatchAction).not.toHaveBeenCalled();
  });

  describe("notices, typed on the Shell into the run that asked (#13500)", () => {
    const routePane = (): OwnPane =>
      relayNoticePane("relay-principal", {
        projectId: "project-1",
        linkSessionId: "link-1",
        helpSessionId: "help-1",
        deliver: vi.fn(),
      });

    function notifyHandlers() {
      const pending = { complete: vi.fn(), cancel: vi.fn() };
      const handlers = {
        whenIdle: vi.fn().mockResolvedValue({ armed: true, terminalId: "t-1" }),
        prepareSend: vi.fn().mockResolvedValue(pending),
        prepareLaunch: vi.fn().mockResolvedValue(pending),
        prepareKeys: vi.fn().mockResolvedValue(pending),
        forgetTarget: vi.fn(),
        supersede: vi.fn(),
        releaseHold: vi.fn(),
      } satisfies TerminalNotifyHandlers;
      return { handlers, pending };
    }

    it("arms a relayed launch's notice on the relay principal's pane, pinned to its callId", async () => {
      const { handlers, pending } = notifyHandlers();
      const relay = await relayed("core", {
        terminalNotify: handlers,
        resolveOwnPane: routePane,
      });
      const result = await relay.client.callTool({
        name: "agent.launch",
        arguments: { agentId: "claude", prompt: "fix it", notify: true },
        _meta: { [RELAY_CALL_ID_META_KEY]: "call-9" },
      });

      expect(result.isError).not.toBe(true);
      const [pane] = handlers.prepareLaunch.mock.calls[0]!;
      expect(pane.relay).toMatchObject({ linkSessionId: "link-1", callId: "call-9" });
      expect(relay.deps.dispatchAction).toHaveBeenCalledTimes(1);
      expect(pending.complete).toHaveBeenCalledWith({ ran: true });
    });

    it("arms terminal.notifyWhenIdle the same way", async () => {
      const { handlers } = notifyHandlers();
      const relay = await relayed("core", {
        terminalNotify: handlers,
        resolveOwnPane: routePane,
      });
      const result = await relay.client.callTool({
        name: "terminal.notifyWhenIdle",
        arguments: { terminalId: "t-1" },
        _meta: { [RELAY_CALL_ID_META_KEY]: "call-10" },
      });

      expect(result.isError).not.toBe(true);
      const [pane, args] = handlers.whenIdle.mock.calls[0]!;
      expect(pane.relay?.callId).toBe("call-10");
      expect(args).toMatchObject({ terminalId: "t-1" });
    });
  });

  it("reports a change refused where its Shell doesn't drive as DRIVEN_ELSEWHERE", async () => {
    const relay = await relayed("core", {
      dispatchAction: vi
        .fn()
        .mockRejectedValue(new RelayDrivenElsewhereError("project-1", "studio-02")),
    });
    const result = await relay.client.callTool({
      name: "agent.launch",
      arguments: { agentId: "claude" },
    });

    expect(result.isError).toBe(true);
    expect(errorCode(result as { content: unknown })).toBe("DRIVEN_ELSEWHERE");
    expect(JSON.stringify(result.content)).toContain("studio-02");
  });

  it("runs a check only where it is bound, and only while its Shell drives there", async () => {
    const refuseWrite = vi.fn((projectId: string | undefined) =>
      projectId === "elsewhere"
        ? { code: "VALIDATION_ERROR", message: "This call can only act in project project-1." }
        : { code: "DRIVEN_ELSEWHERE", message: "studio-02 has control of this project." }
    );
    const relay = await relayed("full", {
      relay: { shellName: "greg-mbp", refuseWrite },
    });

    const elsewhere = await relay.client.callTool({
      name: "project.runCheck",
      arguments: { projectId: "elsewhere", runnerId: "test" },
    });
    expect(errorCode(elsewhere as { content: unknown })).toBe("VALIDATION_ERROR");
    const driven = await relay.client.callTool({
      name: "project.runCheck",
      arguments: { projectId: "project-1", runnerId: "test" },
    });
    expect(errorCode(driven as { content: unknown })).toBe("DRIVEN_ELSEWHERE");
    expect(relay.deps.handleProjectRunCheck).not.toHaveBeenCalled();

    refuseWrite.mockReturnValue(null as never);
    const ran = await relay.client.callTool({
      name: "project.runCheck",
      arguments: { projectId: "project-1", runnerId: "test" },
    });
    expect(ran.isError).not.toBe(true);
    expect(relay.deps.handleProjectRunCheck).toHaveBeenCalledTimes(1);
  });

  it("asks once more right before a check spawns, refusing if its Shell lost control meanwhile", async () => {
    const refuseWrite = vi.fn(() => null as { code: string; message: string } | null);
    const handleProjectRunCheck = vi.fn(
      async (_args: unknown, _signal: AbortSignal, authorize?: () => void) => {
        // A takeover lands while the check resolves its runner.
        refuseWrite.mockReturnValue({
          code: "DRIVEN_ELSEWHERE",
          message: "studio-02 has control of this project.",
        });
        authorize?.();
        return { passed: true };
      }
    );
    const relay = await relayed("full", {
      relay: { shellName: "greg-mbp", refuseWrite },
      handleProjectRunCheck: handleProjectRunCheck as never,
    });

    const result = await relay.client.callTool({
      name: "project.runCheck",
      arguments: { projectId: "project-1", runnerId: "test" },
    });
    expect(errorCode(result as { content: unknown })).toBe("DRIVEN_ELSEWHERE");
    expect(refuseWrite).toHaveBeenCalledTimes(2);
  });

  it("lists and runs the command runner for a Shell's assistant at the full tier (#13501)", async () => {
    const handleProjectRunCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    const relay = await relayed("full", { handleProjectRunCommand });

    const listed = (await relay.client.listTools()).tools.map((tool) => tool.name);
    expect(listed).toContain("project.runCommand");

    const result = await relay.client.callTool({
      name: "project.runCommand",
      arguments: { projectId: "project-1", command: "git status" },
    });
    expect(result.isError).not.toBe(true);
    expect(handleProjectRunCommand).toHaveBeenCalledTimes(1);
    // Still the session's own: its origin stays `external`.
    expect(relay.store.getOrigin("relay-session")).toBe("external");
  });

  it("never lists or runs the command runner for a core-tier relay", async () => {
    const relay = await relayed("core");

    const listed = (await relay.client.listTools()).tools.map((tool) => tool.name);
    expect(listed).not.toContain("project.runCommand");

    const result = await relay.client.callTool({
      name: "project.runCommand",
      arguments: { projectId: "project-1", command: "git status" },
    });
    expect(errorCode(result as { content: unknown })).toBe("TIER_NOT_PERMITTED");
    expect(relay.deps.handleProjectRunCommand).not.toHaveBeenCalled();
  });

  // A full-tier relay is admitted to the runner (#13501); these hold it to the drive rule.
  describe("the command runner, past its own caller gate", () => {
    const admitted = (overrides: Partial<SessionServerDeps>) => relayed("full", overrides);

    it("runs only where it is bound, and only while its Shell drives there", async () => {
      const refuseWrite = vi.fn((projectId: string | undefined) =>
        projectId === "elsewhere"
          ? { code: "VALIDATION_ERROR", message: "This call can only act in project project-1." }
          : { code: "DRIVEN_ELSEWHERE", message: "studio-02 has control of this project." }
      );
      const handleProjectRunCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
      const relay = await admitted({
        relay: { shellName: "greg-mbp", refuseWrite },
        handleProjectRunCommand,
      });

      const elsewhere = await relay.client.callTool({
        name: "project.runCommand",
        arguments: { projectId: "elsewhere", command: "git status" },
      });
      expect(errorCode(elsewhere as { content: unknown })).toBe("VALIDATION_ERROR");
      const driven = await relay.client.callTool({
        name: "project.runCommand",
        arguments: { projectId: "project-1", command: "git status" },
      });
      expect(errorCode(driven as { content: unknown })).toBe("DRIVEN_ELSEWHERE");
      expect(handleProjectRunCommand).not.toHaveBeenCalled();

      refuseWrite.mockReturnValue(null as never);
      const ran = await relay.client.callTool({
        name: "project.runCommand",
        arguments: { projectId: "project-1", command: "git status" },
      });
      expect(ran.isError).not.toBe(true);
      expect(handleProjectRunCommand).toHaveBeenCalledTimes(1);
      expect(typeof handleProjectRunCommand.mock.calls[0]?.[2]).toBe("function");
    });

    it("asks once more right before the spawn, refusing if its Shell lost control meanwhile", async () => {
      const refuseWrite = vi.fn(() => null as { code: string; message: string } | null);
      const handleProjectRunCommand = vi.fn(
        async (_args: unknown, _signal: AbortSignal, authorize?: () => void) => {
          // A takeover lands while the command resolves its project.
          refuseWrite.mockReturnValue({
            code: "DRIVEN_ELSEWHERE",
            message: "studio-02 has control of this project.",
          });
          authorize?.();
          return { exitCode: 0 };
        }
      );
      const relay = await admitted({
        relay: { shellName: "greg-mbp", refuseWrite },
        handleProjectRunCommand: handleProjectRunCommand as never,
      });

      const result = await relay.client.callTool({
        name: "project.runCommand",
        arguments: { projectId: "project-1", command: "git status" },
      });
      expect(errorCode(result as { content: unknown })).toBe("DRIVEN_ELSEWHERE");
      expect(refuseWrite).toHaveBeenCalledTimes(2);
    });
  });

  it("stamps the Shell's callId on this host's audit record of the call", async () => {
    const relay = await relayed("core");
    await relay.client.callTool({
      name: "terminal.list",
      arguments: {},
      _meta: { [RELAY_CALL_ID_META_KEY]: "call-123" },
    });

    expect(relay.deps.appendAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: "terminal.list", relayCallId: "call-123" })
    );
  });

  it("ignores a callId on a session that isn't relayed", async () => {
    const plain = await relayed("core", {}, false);
    await plain.client.callTool({
      name: "terminal.list",
      arguments: {},
      _meta: { [RELAY_CALL_ID_META_KEY]: "call-123" },
    });

    const [input] = (plain.deps.appendAuditRecord as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(input).not.toHaveProperty("relayCallId");
  });
});

describe("host.call on this machine's own assistant session (#13493)", () => {
  it("is listed from the session's start, hosts or not, and carries the session's tier", async () => {
    const store = new SessionStore(() => {});
    const sessionId = "help-transport";
    store.sessionTierMap.set(sessionId, "full");
    store.sessionOriginMap.set(sessionId, "help");
    store.sessionHelpIdMap.set(sessionId, "help-1");
    const run = vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: "ok" as const,
        detail: null,
        retryAfterMs: null,
        callId: "c1",
        result: { isError: false, structured: { terminals: [] }, text: null },
      },
    }));
    const server = createSessionServer(sessionId, {
      sessionStore: store,
      requestManifest: vi.fn().mockResolvedValue(MANIFEST),
      dispatchAction: vi.fn(),
      handleWaitUntilIdle: vi.fn(),
      handleWaitUntilIdleBatch: vi.fn(),
      handleSkillsSearch: vi.fn(() => ({ skills: [] })),
      handleSkillsLoad: vi.fn(),
      handleProjectRunCheck: vi.fn(),
      handleProjectRunCommand: vi.fn(),
      handleTerminalGetStatusViewless: vi.fn(),
      handleTerminalReadLastMessageOwned: vi.fn(),
      isTerminalIdInUse: vi.fn(() => false),
      appendAuditRecord: vi.fn(),
      getCachedManifest: vi.fn(() => MANIFEST),
      hostMessaging: {
        isAvailable: () => false,
        isReachable: () => false,
        isCallReachable: () => true,
        run,
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    store.relaySessions.set(sessionId, { transport: serverTransport, server });
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    open.push({
      client,
      store,
      deps: {} as SessionServerDeps,
      close: async () => {
        await client.close();
        store.drain();
        store.grantCache.dispose();
      },
    });

    // The messaging tools need a host to exist; this one is listed without.
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("host.call");

    const args = { hostId: "studio", projectId: "p", tool: "terminal.list", args: {} };
    const result = await client.callTool({ name: "host.call", arguments: args });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ outcome: "ok", callId: "c1" });
    expect(run).toHaveBeenCalledWith("host.call", args, { tier: "full" });
  });
});
