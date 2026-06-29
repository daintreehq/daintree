import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stable mock boundaries so importing the handler stays cheap and free of the
// real electron / electron-store / IPC-registration chains. The consent service,
// rate limiter, and audit are injected through `instances.js` so the pipeline
// wiring (rate-limit → consent → dispatch → audit) runs for real.
const h = vi.hoisted(() => {
  const supervisor = {
    start: vi.fn(),
    getFullSchema: vi.fn(),
    callTool: vi.fn(),
  };
  const pluginService = {
    findMcpServerContribution: vi.fn(),
    getMcpConsentMeta: vi.fn(),
    resolveSettingTemplate: vi.fn(),
  };
  const fakeWc = {
    id: 7,
    isDestroyed: () => false,
    send: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  };
  return {
    supervisor,
    pluginService,
    fakeWc,
    consent: null as unknown,
    consentStore: null as unknown,
    rate: null as unknown,
    audit: null as unknown,
  };
});

vi.mock("electron", () => ({
  webContents: { fromId: (id: number) => (id === h.fakeWc.id ? h.fakeWc : null) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: class {},
}));

vi.mock("../../define.js", () => ({
  defineIpcNamespace: () => ({ register: () => () => {} }),
  op: (channel: string, handler: unknown) => ({ channel, handler }),
}));

vi.mock("../../../store.js", () => ({ store: { get: () => ({}), set: () => {} } }));

vi.mock("../../../services/plugin-mcp/instances.js", () => ({
  getPluginMcpConsentService: () => h.consent,
  getPluginMcpRateLimiter: () => h.rate,
  getPluginMcpAuditService: () => h.audit,
}));

vi.mock("../../../services/PluginMcpSupervisor.js", () => ({
  getPluginMcpSupervisor: () => h.supervisor,
}));

vi.mock("../../../services/PluginService.js", () => ({
  get pluginService() {
    return h.pluginService;
  },
}));

import { _resetConsentBridgeForTest, handleCallTool, handleResolveConsent } from "../pluginMcp.js";
import {
  fingerprintTool,
  PluginMcpConsentService,
} from "../../../services/plugin-mcp/PluginMcpConsentService.js";
import { PluginMcpConsentStore } from "../../../services/plugin-mcp/PluginMcpConsentStore.js";
import { PluginMcpRateLimiter } from "../../../services/plugin-mcp/PluginMcpRateLimiter.js";
import {
  PLUGIN_MCP_CAPABILITY_CAP_EXCEEDED_CODE,
  PLUGIN_MCP_CONSENT_TIMEOUT_CODE,
  PLUGIN_MCP_RATE_LIMITED_CODE,
  PLUGIN_MCP_USER_REJECTED_CODE,
} from "../../../../shared/types/ipc/pluginMcpAudit.js";
import { PLUGIN_MCP_CONSENT_TIMEOUT_MS } from "../../../../shared/types/pluginMcpConsent.js";
import type { IpcContext } from "../../types.js";
import type { PluginMcpCallToolInput } from "../../../../shared/types/ipc/pluginMcp.js";

/** Flush the awaited resolution chain (dynamic imports + mocked async) so the
 * consent-request push fires under fake timers without relying on wall-clock. */
async function flushMicrotasks(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function makeConsentStore(): PluginMcpConsentStore {
  let cfg: Record<string, unknown> = {};
  return new PluginMcpConsentStore(
    (patch) => {
      cfg = { ...cfg, ...patch };
    },
    () => cfg
  );
}

const ctx: IpcContext = {
  event: {} as IpcContext["event"],
  webContentsId: 7,
  senderWindow: null,
  projectId: null,
};

const input: PluginMcpCallToolInput = {
  pluginId: "acme",
  serverId: "main",
  toolName: "do_thing",
  args: { x: 1 },
};

const READONLY_TOOL = {
  found: true as const,
  tool: {
    name: "do_thing",
    description: "Do a thing.",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
};

function setSchema(tool: unknown): void {
  h.supervisor.getFullSchema.mockResolvedValue(tool);
}

/** Pin a TOFU approval so `authorizeToolCall` resolves without a prompt. */
function pinApproval(tool: {
  description?: string;
  inputSchema: unknown;
  annotations?: ToolAnnotations;
}): void {
  (h.consentStore as PluginMcpConsentStore).pin(
    { pluginId: input.pluginId, serverId: input.serverId, toolName: input.toolName },
    fingerprintTool(tool.description ?? "", tool.inputSchema, tool.annotations)
  );
}

beforeEach(() => {
  const store = makeConsentStore();
  h.consentStore = store;
  h.consent = new PluginMcpConsentService(store);
  h.rate = new PluginMcpRateLimiter(20, 1);
  h.audit = { append: vi.fn() };

  h.supervisor.start.mockReset().mockResolvedValue(undefined);
  h.supervisor.getFullSchema.mockReset().mockResolvedValue(READONLY_TOOL);
  h.supervisor.callTool.mockReset().mockResolvedValue({ content: [] });

  h.pluginService.findMcpServerContribution
    .mockReset()
    .mockReturnValue({ contribution: { id: "main" }, pluginDir: "/plugins/acme" });
  h.pluginService.getMcpConsentMeta
    .mockReset()
    .mockReturnValue({ pluginDisplayName: "Acme", manifestCapabilities: [] });
  h.pluginService.resolveSettingTemplate.mockReset().mockResolvedValue("");

  h.fakeWc.send.mockReset();
  h.fakeWc.once.mockReset();
  _resetConsentBridgeForTest();
});

describe("handleCallTool pipeline", () => {
  it("dispatches and audits a pre-approved call", async () => {
    pinApproval(READONLY_TOOL.tool);
    h.supervisor.callTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const result = await handleCallTool(ctx, input);

    expect(result).toEqual({
      kind: "success",
      result: { content: [{ type: "text", text: "ok" }] },
    });
    expect(h.supervisor.callTool).toHaveBeenCalledWith({
      pluginId: "acme",
      serverId: "main",
      tool: "do_thing",
      args: { x: 1 },
    });
    const audit = h.audit as { append: ReturnType<typeof vi.fn> };
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append.mock.calls[0][0]).toMatchObject({
      result: "success",
      dangerTier: "D0",
      toolName: "do_thing",
    });
  });

  it("returns an error result and audits when dispatch throws", async () => {
    pinApproval(READONLY_TOOL.tool);
    h.supervisor.callTool.mockRejectedValue(
      Object.assign(new Error("boom"), { code: "NOT_READY" })
    );

    const result = await handleCallTool(ctx, input);

    expect(result).toEqual({ kind: "error", errorCode: "NOT_READY", message: "boom" });
    const audit = h.audit as { append: ReturnType<typeof vi.fn> };
    expect(audit.append.mock.calls[0][0]).toMatchObject({
      result: "error",
      errorCode: "NOT_READY",
    });
  });

  it("denies before dispatch when the capability cap is exceeded", async () => {
    setSchema({
      found: true,
      tool: {
        name: "do_thing",
        description: "Mutate things.",
        inputSchema: { type: "object" },
        annotations: { destructiveHint: true },
      },
    });
    // No high-risk capability → D1 cap, but the destructive tool floors at D2.

    const result = await handleCallTool(ctx, input);

    expect(result).toEqual({
      kind: "denied",
      errorCode: PLUGIN_MCP_CAPABILITY_CAP_EXCEEDED_CODE,
    });
    expect(h.supervisor.callTool).not.toHaveBeenCalled();
    const audit = h.audit as { append: ReturnType<typeof vi.fn> };
    expect(audit.append.mock.calls[0][0]).toMatchObject({ result: "denied" });
  });

  it("throttles before consent and never prompts or dispatches", async () => {
    // Capacity 1 — pre-consume the only token so the handler's check denies.
    h.rate = new PluginMcpRateLimiter(1, 1);
    (h.rate as PluginMcpRateLimiter).check("acme", "main");
    pinApproval(READONLY_TOOL.tool);

    const result = await handleCallTool(ctx, input);

    expect(result.kind).toBe("denied");
    if (result.kind === "denied") {
      expect(result.errorCode).toBe(PLUGIN_MCP_RATE_LIMITED_CODE);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    }
    expect(h.supervisor.callTool).not.toHaveBeenCalled();
    expect(h.fakeWc.send).not.toHaveBeenCalled();
    const audit = h.audit as { append: ReturnType<typeof vi.fn> };
    expect(audit.append.mock.calls[0][0]).toMatchObject({
      result: "denied",
      errorCode: PLUGIN_MCP_RATE_LIMITED_CODE,
    });
  });

  it("prompts the initiating renderer and resolves on the renderer's reply", async () => {
    setSchema({
      found: true,
      tool: {
        name: "do_thing",
        description: "Maybe mutate.",
        inputSchema: { type: "object" },
        annotations: { destructiveHint: false },
      },
    });

    const pending = handleCallTool(ctx, input);
    await vi.waitFor(() => expect(h.fakeWc.send).toHaveBeenCalledTimes(1));

    const [, envelope] = h.fakeWc.send.mock.calls[0] as [
      string,
      {
        name: string;
        payload: { requestId: string; dangerTier: string; pluginDisplayName: string };
      },
    ];
    expect(envelope.name).toBe("plugin-mcp:consent-request");
    expect(envelope.payload.dangerTier).toBe("D1");
    expect(envelope.payload.pluginDisplayName).toBe("Acme");
    const { requestId } = envelope.payload;

    // A reply from a different WebContents must be ignored.
    await handleResolveConsent(
      { ...ctx, webContentsId: 999 },
      { requestId, decision: "approved-once" }
    );
    // The real reply from the pinned WebContents resolves it.
    await handleResolveConsent(ctx, { requestId, decision: "rejected" });

    const result = await pending;
    expect(result).toEqual({ kind: "denied", errorCode: PLUGIN_MCP_USER_REJECTED_CODE });
    expect(h.supervisor.callTool).not.toHaveBeenCalled();
    const audit = h.audit as { append: ReturnType<typeof vi.fn> };
    expect(audit.append.mock.calls[0][0]).toMatchObject({ result: "rejected" });
  });

  it("settles consent as a timeout denial when the prompt is abandoned (#10841)", async () => {
    vi.useFakeTimers();
    try {
      setSchema({
        found: true,
        tool: {
          name: "do_thing",
          description: "Maybe mutate.",
          inputSchema: { type: "object" },
          annotations: { destructiveHint: false },
        },
      });

      const pending = handleCallTool(ctx, input);
      // Resolve the await chain so the consent-request is pushed and the bridge
      // timer is armed.
      await flushMicrotasks();
      expect(h.fakeWc.send).toHaveBeenCalledTimes(1);
      expect(h.supervisor.callTool).not.toHaveBeenCalled();

      // No reply ever arrives — the bridge timer fires and settles "timeout".
      await vi.advanceTimersByTimeAsync(PLUGIN_MCP_CONSENT_TIMEOUT_MS);

      const result = await pending;
      expect(result).toEqual({ kind: "denied", errorCode: PLUGIN_MCP_CONSENT_TIMEOUT_CODE });
      expect(h.supervisor.callTool).not.toHaveBeenCalled();
      const audit = h.audit as { append: ReturnType<typeof vi.fn> };
      expect(audit.append.mock.calls[0][0]).toMatchObject({
        result: "timeout",
        consentDecision: "timeout",
        errorCode: PLUGIN_MCP_CONSENT_TIMEOUT_CODE,
      });

      // A late reply for the timed-out request is a no-op.
      const requestId = (h.fakeWc.send.mock.calls[0][1] as { payload: { requestId: string } })
        .payload.requestId;
      await handleResolveConsent(ctx, { requestId, decision: "approved-once" });
      expect(h.supervisor.callTool).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pins on approve-and-pin so the next call skips the prompt", async () => {
    const tool = {
      found: true,
      tool: {
        name: "do_thing",
        description: "Maybe mutate.",
        inputSchema: { type: "object" },
        annotations: { destructiveHint: false },
      },
    };
    setSchema(tool);

    // First call prompts and is approved-with-pin.
    const first = handleCallTool(ctx, input);
    await vi.waitFor(() => expect(h.fakeWc.send).toHaveBeenCalledTimes(1));
    const [, envelope] = h.fakeWc.send.mock.calls[0] as [
      string,
      { payload: { requestId: string } },
    ];
    await handleResolveConsent(ctx, {
      requestId: envelope.payload.requestId,
      decision: "approved-and-pin",
    });
    expect(await first).toMatchObject({ kind: "success" });
    expect(h.supervisor.callTool).toHaveBeenCalledTimes(1);

    // Second call with the same tool surface auto-approves — no new prompt.
    h.fakeWc.send.mockClear();
    const second = await handleCallTool(ctx, input);
    expect(second).toMatchObject({ kind: "success" });
    expect(h.fakeWc.send).not.toHaveBeenCalled();
    expect(h.supervisor.callTool).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the initiating renderer is gone", async () => {
    setSchema({
      found: true,
      tool: {
        name: "do_thing",
        description: "Maybe mutate.",
        inputSchema: { type: "object" },
        annotations: { destructiveHint: false },
      },
    });

    // webContentsId 999 → fromId returns null → bridge resolves "rejected".
    const result = await handleCallTool({ ...ctx, webContentsId: 999 }, input);

    expect(result).toEqual({ kind: "denied", errorCode: PLUGIN_MCP_USER_REJECTED_CODE });
    expect(h.fakeWc.send).not.toHaveBeenCalled();
    expect(h.supervisor.callTool).not.toHaveBeenCalled();
  });

  it("returns an error result when the tool is not found", async () => {
    setSchema({ found: false });

    const result = await handleCallTool(ctx, input);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.errorCode).toBe("TOOL_NOT_FOUND");
    }
    expect(h.supervisor.callTool).not.toHaveBeenCalled();
  });
});
