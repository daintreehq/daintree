import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fingerprintTool,
  PluginMcpConsentService,
  PLUGIN_MCP_NO_CONSENT_BRIDGE_CODE,
  type PluginMcpAuthorizeInput,
  type PluginMcpConsentBridge,
} from "../PluginMcpConsentService.js";
import { PluginMcpConsentStore } from "../PluginMcpConsentStore.js";
import {
  PLUGIN_MCP_CAPABILITY_CAP_EXCEEDED_CODE,
  PLUGIN_MCP_CONSENT_TIMEOUT_CODE,
  PLUGIN_MCP_USER_REJECTED_CODE,
} from "../../../../shared/types/ipc/pluginMcpAudit.js";

function makeConsentStore() {
  let config: Record<string, unknown> = {};
  return new PluginMcpConsentStore(
    (patch) => {
      config = { ...config, ...patch };
    },
    () => config
  );
}

const baseInput: PluginMcpAuthorizeInput = {
  identity: { pluginId: "acme", serverId: "main", toolName: "do_thing" },
  pluginDisplayName: "Acme Plugin",
  descriptionRaw: "Do a thing.",
  inputSchema: { type: "object", properties: { x: { type: "string" } } },
  annotations: { destructiveHint: false },
  manifestCapabilities: ["fs:project-write"],
  rawArgs: { x: "hello" },
};

describe("PluginMcpConsentService", () => {
  let consentStore: PluginMcpConsentStore;
  let service: PluginMcpConsentService;

  beforeEach(() => {
    consentStore = makeConsentStore();
    service = new PluginMcpConsentService(consentStore);
  });

  afterEach(() => {
    consentStore._resetForTest();
  });

  it("denies a call whose tier floor exceeds the capability cap", async () => {
    const result = await service.authorizeToolCall({
      ...baseInput,
      annotations: { destructiveHint: true },
      manifestCapabilities: ["fs:project-read"],
    });
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") {
      expect(result.errorCode).toBe(PLUGIN_MCP_CAPABILITY_CAP_EXCEEDED_CODE);
      expect(result.dangerTier).toBe("D2");
    }
  });

  it("denies a prompt-requiring call when the consent bridge is missing", async () => {
    const result = await service.authorizeToolCall(baseInput);
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") {
      expect(result.errorCode).toBe(PLUGIN_MCP_NO_CONSENT_BRIDGE_CODE);
    }
  });

  it("approves and writes a TOFU pin on approved-and-pin", async () => {
    const bridge = vi.fn().mockResolvedValue("approved-and-pin");
    service.setConsentBridge(bridge as any as PluginMcpConsentBridge);

    const result = await service.authorizeToolCall(baseInput);
    expect(result.kind).toBe("approved");
    expect(bridge).toHaveBeenCalledTimes(1);

    const fp = fingerprintTool(
      baseInput.descriptionRaw,
      baseInput.inputSchema,
      baseInput.annotations
    );
    expect(consentStore.lookup(baseInput.identity, fp).kind).toBe("approved");
  });

  it("approves without pinning on approved-once", async () => {
    const bridge = vi.fn().mockResolvedValue("approved-once");
    service.setConsentBridge(bridge as any as PluginMcpConsentBridge);

    const result = await service.authorizeToolCall(baseInput);
    expect(result.kind).toBe("approved");

    const fp = fingerprintTool(
      baseInput.descriptionRaw,
      baseInput.inputSchema,
      baseInput.annotations
    );
    expect(consentStore.lookup(baseInput.identity, fp).kind).toBe("first-use");
  });

  it("denies on user rejection with the rejected error code", async () => {
    service.setConsentBridge(vi.fn().mockResolvedValue("rejected"));
    const result = await service.authorizeToolCall(baseInput);
    expect(result).toMatchObject({
      kind: "denied",
      errorCode: PLUGIN_MCP_USER_REJECTED_CODE,
      consentDecision: "rejected",
    });
  });

  it("denies on consent timeout with the timeout error code", async () => {
    service.setConsentBridge(vi.fn().mockResolvedValue("timeout"));
    const result = await service.authorizeToolCall(baseInput);
    expect(result).toMatchObject({
      kind: "denied",
      errorCode: PLUGIN_MCP_CONSENT_TIMEOUT_CODE,
      consentDecision: "timeout",
    });
  });

  it("treats a thrown bridge as rejection (never approves)", async () => {
    service.setConsentBridge(vi.fn().mockRejectedValue(new Error("ui crashed")));
    const result = await service.authorizeToolCall(baseInput);
    expect(result.kind).toBe("denied");
  });

  it("re-prompts when the raw description bytes change — invisible Unicode rug-pull", async () => {
    const bridge = vi
      .fn()
      .mockResolvedValueOnce("approved-and-pin") // first-use
      .mockResolvedValueOnce("approved-and-pin"); // raw-changed re-prompt
    service.setConsentBridge(bridge as any as PluginMcpConsentBridge);

    await service.authorizeToolCall(baseInput);
    expect(bridge).toHaveBeenCalledTimes(1);
    expect((bridge as any).mock.calls[0]![0].reason).toBe("first-use");

    // Identical-looking description, with an appended zero-width space — must re-prompt.
    await service.authorizeToolCall({
      ...baseInput,
      // eslint-disable-next-line no-irregular-whitespace
      descriptionRaw: `${baseInput.descriptionRaw}​`,
    });
    expect(bridge).toHaveBeenCalledTimes(2);
    expect((bridge as any).mock.calls[1]![0].reason).toBe("raw-changed");
  });

  it("re-prompts when the inputSchema changes", async () => {
    const bridge = vi
      .fn()
      .mockResolvedValueOnce("approved-and-pin")
      .mockResolvedValueOnce("approved-and-pin");
    service.setConsentBridge(bridge as any as PluginMcpConsentBridge);

    await service.authorizeToolCall(baseInput);
    await service.authorizeToolCall({
      ...baseInput,
      inputSchema: { type: "object", properties: { x: { type: "string" }, y: { type: "number" } } },
    });
    expect((bridge as any).mock.calls[1]![0].reason).toBe("schema-changed");
  });

  it("re-prompts when only the tier-relevant annotations flip — benign→destructive rug-pull", async () => {
    const bridge = vi
      .fn()
      .mockResolvedValueOnce("approved-and-pin") // first-use, pinned as read-only
      .mockResolvedValueOnce("approved-once"); // annotation-changed re-prompt
    service.setConsentBridge(bridge as any as PluginMcpConsentBridge);

    // Pin a benign read-only tool.
    await service.authorizeToolCall({ ...baseInput, annotations: { readOnlyHint: true } });
    expect(bridge).toHaveBeenCalledTimes(1);
    expect((bridge as any).mock.calls[0]![0].reason).toBe("first-use");

    // Same description + schema, but the server now advertises a destructive
    // tool — the tier rose without touching the bytes the old fingerprint
    // covered, so the pin must NOT auto-approve.
    const second = await service.authorizeToolCall({
      ...baseInput,
      annotations: { destructiveHint: true },
    });
    expect(second.kind).toBe("approved");
    expect(bridge).toHaveBeenCalledTimes(2);
    expect((bridge as any).mock.calls[1]![0].reason).toBe("annotation-changed");
  });

  it("does not re-prompt when a non-tier annotation field changes", async () => {
    const bridge = vi.fn().mockResolvedValue("approved-and-pin");
    service.setConsentBridge(bridge as any as PluginMcpConsentBridge);

    await service.authorizeToolCall({ ...baseInput, annotations: { readOnlyHint: true } });
    (bridge as any).mockClear();

    // `title` is advisory metadata, not a tier input — the fingerprint must
    // stay stable so the SDK adding non-tier fields can't trigger spurious
    // re-consent.
    const second = await service.authorizeToolCall({
      ...baseInput,
      annotations: { readOnlyHint: true, title: "Renamed Tool" },
    });
    expect(second.kind).toBe("approved");
    expect(bridge).not.toHaveBeenCalled();
  });

  it("does not prompt when a matching pin already exists", async () => {
    const bridge = vi.fn().mockResolvedValue("approved-and-pin");
    service.setConsentBridge(bridge as any as PluginMcpConsentBridge);

    await service.authorizeToolCall(baseInput);
    (bridge as any).mockClear();

    const second = await service.authorizeToolCall(baseInput);
    expect(second.kind).toBe("approved");
    expect(bridge).not.toHaveBeenCalled();
  });

  it("does not pass raw args to the bridge — only the redacted argsSummary", async () => {
    const bridge = vi.fn().mockResolvedValue("approved-once");
    service.setConsentBridge(bridge as any as PluginMcpConsentBridge);

    await service.authorizeToolCall({
      ...baseInput,
      rawArgs: { secretToken: "VERY_SECRET_VALUE" },
    });

    const request = (bridge as any).mock.calls[0]![0];
    const requestJson = JSON.stringify(request);
    expect(requestJson).not.toContain("VERY_SECRET_VALUE");
    // Sensitive key with token-like content collapses to <redacted> via summarizeMcpArgs.
    expect(request.argsSummary).toContain("redacted");
  });

  it("fingerprints a null inputSchema with the same sentinel the audit service uses", async () => {
    // The audit service stores `input_schema_sha = sha256Hex("")` for null
    // schemas; the consent fingerprint must match so cross-referencing a
    // pinned tool against its audit row works.
    const fp = fingerprintTool("desc", null, undefined);
    const fpUndef = fingerprintTool("desc", undefined, undefined);
    expect(fp.schemaHash).toEqual(fpUndef.schemaHash);
    // The non-empty sentinel makes the consistency check observable —
    // an accidental return-to-"" would fail this assertion.
    expect(fp.schemaHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("strips ANSI/OSC escapes from the descriptionDisplay handed to the bridge", async () => {
    const bridge = vi.fn().mockResolvedValue("approved-once");
    service.setConsentBridge(bridge as any as PluginMcpConsentBridge);

    const rawWithAnsi = "\x1b[31mDanger:\x1b[0m do the thing";
    await service.authorizeToolCall({ ...baseInput, descriptionRaw: rawWithAnsi });

    const request = (bridge as any).mock.calls[0]![0];
    expect(request.descriptionDisplay).toBe("Danger: do the thing");
  });

  it("revokeAllForPlugin delegates to the store so a reinstall re-prompts", async () => {
    const bridge = vi.fn().mockResolvedValue("approved-and-pin");
    service.setConsentBridge(bridge as any as PluginMcpConsentBridge);

    // First call pins; the second auto-approves from the pin.
    expect((await service.authorizeToolCall(baseInput)).consentDecision).toBe("approved-and-pin");
    const second = await service.authorizeToolCall(baseInput);
    expect(second.kind).toBe("approved");
    expect(second.consentDecision).toBeUndefined();

    // Uninstall purges consent; a reinstall's first call must prompt again. The
    // service surfaces whether the purge durably persisted so the uninstall
    // caller can retry/escalate on failure.
    expect(service.revokeAllForPlugin(baseInput.identity.pluginId)).toBe(true);
    bridge.mockClear();
    const reinstall = await service.authorizeToolCall(baseInput);
    expect(reinstall.kind).toBe("approved");
    expect(reinstall.consentDecision).toBe("approved-and-pin");
    expect(bridge).toHaveBeenCalledTimes(1);
  });
});
