/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { PluginDevWorkerMainBridge } from "../PluginDevWorkerMainBridge.js";
import { PluginDevWorkerHostProxy } from "../pluginDevWorkerHostProxy.js";
import {
  AGENT_MCP_MAX_RESULT_BYTES,
  type PluginMcpCaller,
  type PluginMcpToolDefinition,
} from "../../../../shared/types/plugin.js";

const flush = () => new Promise((r) => setImmediate(r));

const CALLER: PluginMcpCaller = {
  credentialId: "cred-1",
  projectId: "a".repeat(64),
  terminalId: "term-1",
  launchAgentIdHint: "claude",
};

const IDENTITY = {
  instanceId: "acme.ledger",
  manifestId: "acme.ledger",
  origin: "global" as const,
  projectId: null,
  projectRoot: null,
};

class FakeWorkerHost extends EventEmitter {
  sent: any[] = [];
  ready = true;
  /** When set, every message main sends is delivered to this worker-side proxy. */
  proxy: PluginDevWorkerHostProxy | null = null;
  send = vi.fn((msg: any) => {
    this.sent.push(msg);
    this.proxy?.handleMessage(msg);
    return this.ready;
  });
  isReady = () => this.ready;
  off = this.removeListener;
  dispose = vi.fn(() => {
    this.ready = false;
    this.removeAllListeners();
  });
}

interface CapturedRoster {
  endpointId: string;
  tools: Record<string, PluginMcpToolDefinition>;
  dispose: ReturnType<typeof vi.fn>;
}

/** The slice of the real host the bridge's MCP relay reaches. */
function makeHost() {
  const rosters: CapturedRoster[] = [];
  return {
    rosters,
    pluginId: "acme.ledger",
    mcp: {
      registerTools: vi.fn((endpointId: string, tools: Record<string, PluginMcpToolDefinition>) => {
        const dispose = vi.fn();
        rosters.push({ endpointId, tools, dispose });
        return Promise.resolve(dispose);
      }),
    },
  };
}

function makeBridge() {
  const host = makeHost();
  const workerHost = new FakeWorkerHost();
  const onActivationResult = vi.fn();
  const bridge = new PluginDevWorkerMainBridge({
    pluginId: "acme.ledger",
    host: host as any,
    workerHost: workerHost as any,
    getCapabilities: () => ["mcp:expose"],
    clearPriorRegistrations: vi.fn(),
    onActivationResult,
  });
  bridge.waitForActivation().catch(() => {});
  return { host, workerHost, bridge, onActivationResult };
}

/** A bridge and a worker-side proxy wired back to back, as the port wires them. */
function makeConnectedPair() {
  const pair = makeBridge();
  const proxy = new PluginDevWorkerHostProxy(
    "acme.ledger",
    (msg) => pair.workerHost.emit("worker-message", msg),
    IDENTITY
  );
  pair.workerHost.proxy = proxy;
  return { ...pair, proxy };
}

function registerNotify(tools: Record<string, unknown>, endpointId = "data") {
  return {
    type: "host-notify",
    method: "mcp.registerTools",
    registrationKey: `agentMcp:${endpointId}`,
    params: { endpointId, tools },
  };
}

const WIRE_TOOL = { description: "Lists rows.", inputSchema: { type: "object" } };

describe("agent MCP over the worker bridge", () => {
  beforeEach(() => vi.clearAllMocks());

  it("round-trips a tool call from main into the worker's execute and back", async () => {
    const { host, proxy } = makeConnectedPair();
    const execute = vi.fn(async (args: Record<string, unknown>, caller: PluginMcpCaller) => ({
      rows: [args.limit, caller.projectId],
    }));
    await proxy.host.mcp.registerTools("data", {
      list_rows: {
        description: "Lists rows.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        execute,
      },
    });
    await flush();

    expect(host.mcp.registerTools).toHaveBeenCalledTimes(1);
    const [{ endpointId, tools }] = host.rosters;
    expect(endpointId).toBe("data");
    // What crossed the port is the descriptor; the host sees an execute that
    // relays, never the plugin's own function.
    expect(tools.list_rows).toMatchObject({
      description: "Lists rows.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
    expect(tools.list_rows.execute).not.toBe(execute);

    const signal = new AbortController().signal;
    await expect(tools.list_rows.execute({ limit: 5 }, CALLER, signal)).resolves.toEqual({
      rows: [5, CALLER.projectId],
    });
    const [args, caller, workerSignal] = execute.mock.calls[0] as unknown as [
      unknown,
      PluginMcpCaller,
      AbortSignal,
    ];
    expect(args).toEqual({ limit: 5 });
    expect(caller).toEqual(CALLER);
    expect(Object.isFrozen(caller)).toBe(true);
    expect(workerSignal.aborted).toBe(false);
  });

  it("carries only the caller descriptor's own fields into the worker", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", registerNotify({ list_rows: WIRE_TOOL }));
    await flush();

    const leaky = { ...CALLER, bearer: "secret-token", grant: { bearerSha256: "abc" } };
    void host.rosters[0].tools.list_rows.execute({}, leaky, new AbortController().signal);

    const invoke = workerHost.sent.find((m) => m.type === "invoke" && m.kind === "mcp-tool");
    expect(invoke).toMatchObject({ endpointId: "data", toolName: "list_rows", args: {} });
    expect(invoke.caller).toEqual(CALLER);
  });

  it("cancels in the worker when main aborts, and drops the late result", async () => {
    const { host, workerHost, bridge, proxy } = makeConnectedPair();
    let workerSignal: AbortSignal | undefined;
    let finish: (value: unknown) => void = () => {};
    await proxy.host.mcp.registerTools("data", {
      slow: {
        description: "Takes a while.",
        inputSchema: { type: "object" },
        execute: (_args, _caller, signal) => {
          workerSignal = signal;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    });
    await flush();

    const controller = new AbortController();
    const call = host.rosters[0].tools.slow.execute({}, CALLER, controller.signal);
    await flush();
    expect(bridge.pendingInvokeCount).toBe(1);

    controller.abort();

    await expect(call).rejects.toMatchObject({ name: "AbortError" });
    const invoke = workerHost.sent.find((m) => m.type === "invoke" && m.kind === "mcp-tool");
    expect(workerHost.sent).toContainEqual({ type: "invoke-cancel", requestId: invoke.requestId });
    expect(workerSignal?.aborted).toBe(true);
    expect(bridge.pendingInvokeCount).toBe(0);

    // The plugin ignored its signal and resolved anyway: nothing is posted for
    // a cancelled call, and a result that did arrive would find no pending entry.
    const posted = vi.spyOn(workerHost, "emit");
    finish({ late: true });
    await flush();
    expect(posted).not.toHaveBeenCalledWith(
      "worker-message",
      expect.objectContaining({ type: "invoke-result" })
    );
    workerHost.emit("worker-message", {
      type: "invoke-result",
      requestId: invoke.requestId,
      ok: true,
      result: { late: true },
    });
    expect(bridge.pendingInvokeCount).toBe(0);
  });

  it("rejects with the caller's own abort reason", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", registerNotify({ list_rows: WIRE_TOOL }));
    await flush();

    const controller = new AbortController();
    const call = host.rosters[0].tools.list_rows.execute({}, CALLER, controller.signal);
    const timeout = new Error("tool call timed out");
    controller.abort(timeout);

    await expect(call).rejects.toBe(timeout);
  });

  it("never sends a call whose signal is already aborted", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", registerNotify({ list_rows: WIRE_TOOL }));
    await flush();

    const controller = new AbortController();
    controller.abort();
    await expect(
      host.rosters[0].tools.list_rows.execute({}, CALLER, controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(workerHost.sent.some((m) => m.type === "invoke")).toBe(false);
  });

  it("rejects an in-flight call when the worker crashes, and ignores its late result", async () => {
    const { host, workerHost, bridge } = makeBridge();
    workerHost.emit("worker-message", registerNotify({ list_rows: WIRE_TOOL }));
    await flush();
    const roster = host.rosters[0];

    const call = roster.tools.list_rows.execute({}, CALLER, new AbortController().signal);
    const invoke = workerHost.sent.find((m) => m.type === "invoke" && m.kind === "mcp-tool");

    workerHost.emit("exit", 139, false);

    await expect(call).rejects.toThrow(/crashed \(code 139\)/);
    // The roster's execute lived in the dead worker, so it goes with it.
    expect(roster.dispose).toHaveBeenCalledTimes(1);
    expect(workerHost.sent.some((m) => m.type === "invoke-cancel")).toBe(false);

    workerHost.emit("worker-message", {
      type: "invoke-result",
      requestId: invoke.requestId,
      ok: true,
      result: "late",
    });
    expect(bridge.pendingInvokeCount).toBe(0);
  });

  it("refuses a call through a retired generation's roster instead of relaying it", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", registerNotify({ list_rows: WIRE_TOOL }));
    await flush();
    const stale = host.rosters[0].tools.list_rows;

    // The crash respawns a child at once; it is "ready" while still booting.
    workerHost.emit("exit", 139, false);
    workerHost.sent.length = 0;

    await expect(stale.execute({}, CALLER, new AbortController().signal)).rejects.toThrow(
      /worker restarted/
    );
    expect(workerHost.sent.some((m) => m.type === "invoke")).toBe(false);
  });

  it("binds a replacement roster before releasing the one it replaces", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", registerNotify({ first: WIRE_TOOL }));
    await flush();
    const first = host.rosters[0];
    first.dispose.mockImplementation(() => {
      // Released only once the replacement is already bound.
      expect(host.rosters).toHaveLength(2);
    });

    workerHost.emit("worker-message", registerNotify({ second: WIRE_TOOL }));
    await flush();

    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(host.rosters[1].dispose).not.toHaveBeenCalled();

    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "mcp.unregisterTools",
      params: { endpointId: "data" },
    });
    expect(host.rosters[1].dispose).toHaveBeenCalledTimes(1);
  });

  it("reports a roster the host rejects and fails activation by name", async () => {
    const { host, workerHost, onActivationResult } = makeBridge();
    host.mcp.registerTools.mockImplementationOnce(() => {
      throw new Error('endpoint "data" is not declared in contributes.agentMcp');
    });

    workerHost.emit("worker-message", registerNotify({ list_rows: WIRE_TOOL }));
    await flush();

    expect(workerHost.sent).toContainEqual({
      type: "register-error",
      registrationKey: "agentMcp:data",
      error: expect.stringContaining("not declared in contributes.agentMcp"),
    });
    expect(onActivationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining('registration "agentMcp:data" was rejected'),
      })
    );
  });

  it("rejects a malformed roster before it reaches the host", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", registerNotify({ list_rows: "not a tool" }));
    await flush();

    expect(host.mcp.registerTools).not.toHaveBeenCalled();
    expect(workerHost.sent).toContainEqual(
      expect.objectContaining({ type: "register-error", registrationKey: "agentMcp:data" })
    );
  });
});

describe("worker tool results arriving in main", () => {
  it("rejects a result that is not serialized JSON, or is over budget, without parsing it", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", registerNotify({ list_rows: WIRE_TOOL }));
    await flush();
    const execute = host.rosters[0].tools.list_rows.execute;

    const answer = async (result: unknown) => {
      const call = execute({}, CALLER, new AbortController().signal);
      await flush();
      const invoke = [...workerHost.sent]
        .reverse()
        .find((m) => m.type === "invoke" && m.kind === "mcp-tool");
      workerHost.emit("worker-message", {
        type: "invoke-result",
        requestId: invoke.requestId,
        ok: true,
        result,
      });
      return call;
    };

    await expect(answer({ rows: [] })).rejects.toThrow(/not serialized JSON/);
    await expect(answer(JSON.stringify("x".repeat(AGENT_MCP_MAX_RESULT_BYTES)))).rejects.toThrow(
      /byte limit/
    );
    await expect(answer(JSON.stringify({ rows: [1] }))).resolves.toEqual({ rows: [1] });
  });
});

describe("worker-side host.mcp", () => {
  function makeProxy() {
    const sent: any[] = [];
    const proxy = new PluginDevWorkerHostProxy("acme.ledger", (msg) => sent.push(msg), IDENTITY);
    return { proxy, sent };
  }

  const tool = (execute: PluginMcpToolDefinition["execute"] = () => null) => ({
    description: "Lists rows.",
    inputSchema: { type: "object" as const },
    execute,
  });

  it("sends descriptors only, keeping execute in the worker", async () => {
    const { proxy, sent } = makeProxy();
    await proxy.host.mcp.registerTools("data", { list_rows: tool() });

    const notify = sent.find((m) => m.type === "host-notify");
    expect(notify).toEqual({
      type: "host-notify",
      method: "mcp.registerTools",
      registrationKey: "agentMcp:data",
      params: {
        endpointId: "data",
        tools: { list_rows: { description: "Lists rows.", inputSchema: { type: "object" } } },
      },
    });
    // Structured clone throws on a function, so this is what makes the
    // registration postable at all.
    expect(() => structuredClone(notify)).not.toThrow();
  });

  it("throws at the call site for a roster the host would reject", () => {
    const { proxy, sent } = makeProxy();
    expect(() =>
      proxy.host.mcp.registerTools("data", { "Bad-Name": tool() } as Record<
        string,
        PluginMcpToolDefinition
      >)
    ).toThrow(/must match/);
    expect(sent).toHaveLength(0);
  });

  it("refuses registration once activation has closed", () => {
    const { proxy } = makeProxy();
    proxy.revoke();
    expect(() => proxy.host.mcp.registerTools("data", { list_rows: tool() })).toThrow(
      /host revoked/
    );
  });

  it("does not let a replaced roster's disposer unbind its replacement", async () => {
    const { proxy, sent } = makeProxy();
    const disposeFirst = await proxy.host.mcp.registerTools("data", { list_rows: tool() });
    const second = vi.fn(() => "from second");
    const disposeSecond = await proxy.host.mcp.registerTools("data", { list_rows: tool(second) });

    disposeFirst();
    expect(sent.some((m) => m.method === "mcp.unregisterTools")).toBe(false);

    proxy.handleMessage({
      type: "invoke",
      requestId: "i1",
      kind: "mcp-tool",
      endpointId: "data",
      toolName: "list_rows",
      args: {},
      caller: CALLER,
    });
    await flush();
    expect(sent).toContainEqual({
      type: "invoke-result",
      requestId: "i1",
      ok: true,
      result: JSON.stringify("from second"),
    });

    disposeSecond();
    expect(sent).toContainEqual({
      type: "host-notify",
      method: "mcp.unregisterTools",
      params: { endpointId: "data" },
      registrationKey: undefined,
    });
  });

  it("answers a call for an unknown tool with an error result", async () => {
    const { proxy, sent } = makeProxy();
    proxy.handleMessage({
      type: "invoke",
      requestId: "i1",
      kind: "mcp-tool",
      endpointId: "data",
      toolName: "missing",
      args: {},
      caller: CALLER,
    });
    await flush();
    expect(sent).toContainEqual({
      type: "invoke-result",
      requestId: "i1",
      ok: false,
      error: expect.stringContaining('No MCP tool "missing"'),
    });
  });

  it("settles main with an error when a result cannot be serialized to JSON", async () => {
    const { proxy, sent } = makeProxy();
    await proxy.host.mcp.registerTools("data", { list_rows: tool(() => ({ n: 1n })) });

    proxy.handleMessage({
      type: "invoke",
      requestId: "i1",
      kind: "mcp-tool",
      endpointId: "data",
      toolName: "list_rows",
      args: {},
      caller: CALLER,
    });
    await flush();

    expect(sent).toContainEqual(
      expect.objectContaining({ type: "invoke-result", requestId: "i1", ok: false })
    );
  });

  it("serializes the result in the worker, honouring the plugin's own toJSON", async () => {
    const { proxy, sent } = makeProxy();
    class Row {
      constructor(readonly secret: string) {}
      toJSON() {
        return { shown: this.secret.length > 0 };
      }
    }
    await proxy.host.mcp.registerTools("data", { list_rows: tool(() => new Row("hidden")) });

    proxy.handleMessage({
      type: "invoke",
      requestId: "i1",
      kind: "mcp-tool",
      endpointId: "data",
      toolName: "list_rows",
      args: {},
      caller: CALLER,
    });
    await flush();

    expect(sent).toContainEqual({
      type: "invoke-result",
      requestId: "i1",
      ok: true,
      result: JSON.stringify({ shown: true }),
    });
  });

  it("refuses an over-budget result in the worker rather than sending it", async () => {
    const { proxy, sent } = makeProxy();
    const huge = "x".repeat(AGENT_MCP_MAX_RESULT_BYTES + 1);
    await proxy.host.mcp.registerTools("data", { list_rows: tool(() => huge) });

    proxy.handleMessage({
      type: "invoke",
      requestId: "i1",
      kind: "mcp-tool",
      endpointId: "data",
      toolName: "list_rows",
      args: {},
      caller: CALLER,
    });
    await flush();

    const result = sent.find((m) => m.type === "invoke-result");
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("byte limit") });
  });

  it("releases a cancelled call even when its execute never settles", async () => {
    const { proxy, sent } = makeProxy();
    let seen: AbortSignal | undefined;
    await proxy.host.mcp.registerTools("data", {
      list_rows: tool((_args, _caller, signal) => {
        seen = signal;
        return new Promise(() => {});
      }),
    });
    proxy.handleMessage({
      type: "invoke",
      requestId: "i1",
      kind: "mcp-tool",
      endpointId: "data",
      toolName: "list_rows",
      args: {},
      caller: CALLER,
    });
    await flush();

    proxy.handleMessage({ type: "invoke-cancel", requestId: "i1" });

    expect(seen?.aborted).toBe(true);
    expect((proxy as any).mcpInvokeAborts.size).toBe(0);
    expect(sent.some((m) => m.type === "invoke-result")).toBe(false);
  });

  it("aborts in-flight tool signals when the worker is disposed", async () => {
    const { proxy } = makeProxy();
    let seen: AbortSignal | undefined;
    await proxy.host.mcp.registerTools("data", {
      list_rows: tool((_args, _caller, signal) => {
        seen = signal;
        return new Promise(() => {});
      }),
    });
    proxy.handleMessage({
      type: "invoke",
      requestId: "i1",
      kind: "mcp-tool",
      endpointId: "data",
      toolName: "list_rows",
      args: {},
      caller: CALLER,
    });
    await flush();

    proxy.dispose();
    expect(seen?.aborted).toBe(true);
  });
});
