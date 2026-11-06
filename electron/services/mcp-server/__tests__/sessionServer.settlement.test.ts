import { describe, expect, it, onTestFinished, vi } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { createSessionServer } from "../sessionServer.js";
import type { SessionServerDeps } from "../sessionServer.js";
import {
  buildToolError,
  buildMcpErrorPayload,
  RETRIABLE_ERROR_CODES,
  TIER_NOT_PERMITTED_CODE,
  EXECUTION_ERROR_CODE,
  SESSION_BINDING_GONE,
  SESSION_GONE,
  NO_FRONTEND_ATTACHED_CODE,
  CONFIRMATION_TIMEOUT_CODE,
  USER_REJECTED_CODE,
  unwrapDispatchResult,
  RESOLVED_WORKSPACE_META_KEY,
  withResolvedWorkspace,
} from "../shared.js";
import { TOOL_RESULT_TEXT_MAX_BYTES } from "../toolCallResult.js";
import {
  SessionBindingError,
  RendererBridgeUnavailableError,
  NoFrontendAttachedError,
} from "../rendererBridge.js";
import { setMcpDriveTargetResolver } from "../driveTarget.js";
import { MCP_EXTERNAL_BASE_MANIFEST } from "../generated/mcpExternalBaseManifest.js";
import {
  fakeSessionStore,
  fakeDeps,
  makeMockTransport,
  callTool,
  makeManifestEntry,
} from "./helpers/sessionServerFixture.js";

describe("buildToolError envelope", () => {
  function getErrorText(result: ReturnType<typeof buildToolError>): string {
    const block = result.content[0];
    if (block.type !== "text") throw new Error("Expected text block");
    return block.text;
  }

  it("produces a parseable JSON payload with code, message, and retriable", () => {
    const result = buildToolError({
      code: TIER_NOT_PERMITTED_CODE,
      message: "action 'foo' is not permitted for the 'core' tier.",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const parsed = JSON.parse(getErrorText(result));
    expect(parsed).toEqual({
      code: TIER_NOT_PERMITTED_CODE,
      message: "action 'foo' is not permitted for the 'core' tier.",
      retriable: false,
    });
  });

  it("marks EXECUTION_ERROR as retriable", () => {
    const result = buildToolError({ code: EXECUTION_ERROR_CODE, message: "boom" });
    const parsed = JSON.parse(getErrorText(result));
    expect(parsed.retriable).toBe(true);
  });

  it("marks CONFIRMATION_TIMEOUT as retriable", () => {
    const result = buildToolError({ code: CONFIRMATION_TIMEOUT_CODE, message: "timed out" });
    const parsed = JSON.parse(getErrorText(result));
    expect(parsed.retriable).toBe(true);
  });

  it("marks USER_REJECTED as non-retriable", () => {
    const rejected = JSON.parse(
      getErrorText(buildToolError({ code: USER_REJECTED_CODE, message: "no" }))
    );
    expect(rejected.retriable).toBe(false);
  });

  it("preserves structured details from ActionError", () => {
    const result = buildToolError({
      code: "VALIDATION_ERROR",
      message: "Invalid input",
      details: { unknownArguments: ["foo"], missingVariables: ["bar"] },
    });
    const parsed = JSON.parse(getErrorText(result));
    expect(parsed.details).toEqual({
      unknownArguments: ["foo"],
      missingVariables: ["bar"],
    });
  });

  it("omits details key when undefined", () => {
    const result = buildToolError({ code: "NOT_FOUND", message: "missing" });
    const parsed = JSON.parse(getErrorText(result));
    expect("details" in parsed).toBe(false);
  });

  it("preserves null details when caller explicitly passes null", () => {
    const result = buildToolError({ code: "NOT_FOUND", message: "missing", details: null });
    const parsed = JSON.parse(getErrorText(result));
    expect("details" in parsed).toBe(true);
    expect(parsed.details).toBeNull();
  });

  it("falls back to a serializationError marker when details has a circular reference", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const result = buildToolError({
      code: "EXECUTION_ERROR",
      message: "boom",
      details: circular,
    });
    expect(() => JSON.parse(getErrorText(result))).not.toThrow();
    const parsed = JSON.parse(getErrorText(result));
    expect(parsed.details).toEqual({ serializationError: true });
  });
});

describe("buildMcpErrorPayload", () => {
  it("classifies SESSION_GONE as a non-retriable business failure (#11799)", () => {
    // Retrying is pointless — the session is what went away, so recovery is a
    // new session rather than the same call again.
    const payload = buildMcpErrorPayload({ code: SESSION_GONE, message: "gone" });
    expect(payload).toEqual({
      code: SESSION_GONE,
      message: "gone",
      retriable: false,
      errorCategory: "business",
    });
    expect(RETRIABLE_ERROR_CODES.has(SESSION_GONE)).toBe(false);
  });
});

describe("unwrapDispatchResult error path", () => {
  it("throws McpError carrying the structured payload as data", () => {
    try {
      unwrapDispatchResult({
        result: {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid args",
            details: { argument: "name" },
          },
        },
      });
      expect.fail("Expected McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const mcpErr = err as McpError;
      expect(mcpErr.code).toBe(ErrorCode.InternalError);
      expect(mcpErr.message).toContain("VALIDATION_ERROR");
      expect(mcpErr.message).toContain("Invalid args");
      expect(mcpErr.data).toEqual({
        code: "VALIDATION_ERROR",
        message: "Invalid args",
        details: { argument: "name" },
        retriable: false,
      });
    }
  });
});

describe("CallTool live activity notifications (#9759)", () => {
  it("emits started then settled for a permitted dispatch", async () => {
    const started = vi.fn();
    const settled = vi.fn();
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({
      notifyToolCallStarted: started,
      notifyToolCallSettled: settled,
      dispatchAction,
    });
    const server = createSessionServer("session-A", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.list", arguments: {} });

    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-A", toolId: "worktree.list", danger: false })
    );
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-A",
        toolId: "worktree.list",
        outcome: expect.objectContaining({ kind: "result" }),
      })
    );
    // Started must precede settled.
    expect(started.mock.invocationCallOrder[0]).toBeLessThan(settled.mock.invocationCallOrder[0]);
  });

  it("threads one captured turn id into started, settled, and the audit record (#10067)", async () => {
    const started = vi.fn();
    const settled = vi.fn();
    const appendAuditRecord = vi.fn();
    // getCurrentTurnId is read once at dispatch start. Returning a fresh value
    // on a second call would prove a leak; this asserts a single snapshot.
    const getCurrentTurnId = vi.fn().mockReturnValue("turn-xyz");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const deps = fakeDeps({
      getCurrentTurnId,
      notifyToolCallStarted: started,
      notifyToolCallSettled: settled,
      appendAuditRecord,
      dispatchAction,
    });
    const server = createSessionServer("session-T", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.list", arguments: {} });

    // One read, threaded to all three consumers end-to-end — none re-reads the
    // register, so the strip's started/settled rows and the audit record can
    // never disagree on which turn the call belongs to.
    expect(getCurrentTurnId).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ capturedTurnId: "turn-xyz" }));
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ capturedTurnId: "turn-xyz" }));
    expect(appendAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ capturedTurnId: "turn-xyz" })
    );

    // Same single-snapshot discipline for the dispatch start (#12122): the
    // audit record must carry the exact value the live started event carries,
    // not a second Date.now() read that would put the persisted row and the
    // strip on slightly different starts.
    const startedAt = (started.mock.calls[0]?.[0] as { startedAt: number }).startedAt;
    expect(typeof startedAt).toBe("number");
    expect(appendAuditRecord).toHaveBeenCalledWith(expect.objectContaining({ startedAt }));
  });

  it("does not emit started/settled for a pre-dispatch tier rejection", async () => {
    const started = vi.fn();
    const settled = vi.fn();
    const deps = fakeDeps({ notifyToolCallStarted: started, notifyToolCallSettled: settled });
    const server = createSessionServer("session-B", deps);
    await server.connect(makeMockTransport());

    // worktree.delete is outside the default core session's surface, which is
    // all this test needs.
    await callTool(server, { name: "worktree.delete", arguments: {} });

    expect(started).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it("stamps startedAt on a tier-rejected record that has no live started event (#12122)", async () => {
    const started = vi.fn();
    const appendAuditRecord = vi.fn();
    const deps = fakeDeps({ notifyToolCallStarted: started, appendAuditRecord });
    const server = createSessionServer("session-U", deps);
    await server.connect(makeMockTransport());

    const before = Date.now();
    // worktree.delete is outside the default core session's surface, which is
    // all this test needs.
    await callTool(server, { name: "worktree.delete", arguments: {} });
    const after = Date.now();

    // The gate refuses before anything announces, so the audit row is the only
    // record of this attempt existing. Without its own start it could never be
    // ordered against the calls around it.
    expect(started).not.toHaveBeenCalled();
    expect(appendAuditRecord).toHaveBeenCalledTimes(1);
    const input = appendAuditRecord.mock.calls[0]?.[0] as {
      outcome: { kind: string };
      startedAt: number;
    };
    expect(input.outcome.kind).toBe("unauthorized");
    expect(input.startedAt).toBeGreaterThanOrEqual(before);
    expect(input.startedAt).toBeLessThanOrEqual(after);
  });

  it('flags danger:"confirm" tools on the started event', async () => {
    const started = vi.fn();
    const requestManifest = vi
      .fn()
      .mockResolvedValue([
        { id: "worktree.list", title: "List", description: "d", danger: "confirm" },
      ]);
    const deps = fakeDeps({
      notifyToolCallStarted: started,
      requestManifest,
      dispatchAction: vi.fn().mockResolvedValue({ result: { ok: true, result: null } }),
    });
    const server = createSessionServer("session-D", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.list", arguments: {} });

    expect(started).toHaveBeenCalledWith(expect.objectContaining({ danger: true, asks: true }));
  });

  it("settles a call with its started event's own startedAt, so the two pair exactly (#14165)", async () => {
    const started = vi.fn();
    const settled = vi.fn();
    const requestManifest = vi
      .fn()
      .mockResolvedValue([
        { id: "worktree.list", title: "List", description: "d", danger: "confirm" },
      ]);
    // The clock moves on while the dispatch is out, so a settle that read the
    // clock again could not land on the start's own time.
    let clock = 1_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    onTestFinished(() => now.mockRestore());
    const deps = fakeDeps({
      notifyToolCallStarted: started,
      notifyToolCallSettled: settled,
      requestManifest,
      dispatchAction: vi.fn(async () => {
        clock += 5_000;
        return { result: { ok: true as const, result: null } };
      }),
    });
    const server = createSessionServer("session-P", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.list", arguments: {} });

    const startedAt = (started.mock.calls[0]?.[0] as { startedAt: number }).startedAt;
    expect(clock).not.toBe(startedAt);
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-P",
        toolId: "worktree.list",
        startedAt,
        danger: true,
        asks: true,
      })
    );
  });

  it("emits started (danger:false) + settled for the waitUntilIdle short-circuit", async () => {
    const started = vi.fn();
    const settled = vi.fn();
    const handleWaitUntilIdle = vi.fn().mockResolvedValue({
      idleReason: "idle" as const,
      durationMs: 10,
      finalState: "idle",
    });
    const deps = fakeDeps({
      // waitUntilIdle is in CORE_TIER_TOOLS, so the call clears the tier floor
      // and reaches the dispatch path.
      sessionStore: fakeSessionStore("core"),
      notifyToolCallStarted: started,
      notifyToolCallSettled: settled,
      handleWaitUntilIdle,
    });
    const server = createSessionServer("session-W", deps);
    await server.connect(makeMockTransport());

    await callTool(server, {
      name: "terminal.waitUntilIdle",
      arguments: { terminalId: "t1", timeoutMs: 10 },
    });

    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: "terminal.waitUntilIdle", danger: false })
    );
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "terminal.waitUntilIdle",
        outcome: expect.objectContaining({ kind: "result" }),
      })
    );
  });

  it("survives a notifyToolCallStarted throw without failing the dispatch", async () => {
    const started = vi.fn(() => {
      throw new Error("boom");
    });
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const deps = fakeDeps({ notifyToolCallStarted: started, dispatchAction });
    const server = createSessionServer("session-E", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, { name: "worktree.list", arguments: {} })) as {
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(dispatchAction).toHaveBeenCalled();
  });
});

describe("CallTool error envelope (integration through sessionServer)", () => {
  async function callTool(
    server: ReturnType<typeof createSessionServer>,
    params: { name: string; arguments?: Record<string, unknown> }
  ) {
    const handlers = (
      server as unknown as {
        _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
      }
    )._requestHandlers;
    const handler = handlers.get("tools/call");
    if (!handler) throw new Error("tools/call handler not found");
    return handler(
      {
        method: "tools/call",
        params,
        jsonrpc: "2.0",
        id: 1,
      },
      {
        signal: new AbortController().signal,
        _meta: {},
        sendNotification: vi.fn(),
        requestId: 1,
      }
    );
  }

  it("tier denial returns a parseable JSON envelope", async () => {
    const deps = fakeDeps();
    const server = createSessionServer("s-tier", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "project.runCheck",
      arguments: {},
    })) as { isError: boolean; content: { type: string; text: string }[] };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe(TIER_NOT_PERMITTED_CODE);
    expect(parsed.retriable).toBe(false);
    expect(parsed.message).toContain("core");
  });

  it("propagates ActionError.details through the envelope", async () => {
    const manifest = [
      {
        id: "worktree.list",
        title: "Worktree: list",
        description: "List worktrees",
        category: "worktree",
        danger: "safe" as const,
        source: ["agent"] as const,
      },
    ] as unknown as import("../../../../shared/types/actions.js").ActionManifestEntry[];
    const deps = fakeDeps({
      requestManifest: vi.fn().mockResolvedValue(manifest),
      getCachedManifest: vi.fn(() => manifest),
      dispatchAction: vi.fn().mockResolvedValue({
        result: {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid arguments",
            details: { unknownArguments: ["badKey"] },
          },
        },
      }),
    });
    const server = createSessionServer("s-details", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.list",
      arguments: { badKey: 1 },
    })) as { isError: boolean; content: { type: string; text: string }[] };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe("VALIDATION_ERROR");
    expect(parsed.details).toEqual({ unknownArguments: ["badKey"] });
    expect(parsed.retriable).toBe(false);
  });

  it("synthesises EXECUTION_ERROR with retriable=true when dispatch throws", async () => {
    const manifest = [
      {
        id: "worktree.list",
        title: "Worktree: list",
        description: "List",
        category: "worktree",
        danger: "safe" as const,
        source: ["agent"] as const,
      },
    ] as unknown as import("../../../../shared/types/actions.js").ActionManifestEntry[];
    const deps = fakeDeps({
      requestManifest: vi.fn().mockResolvedValue(manifest),
      getCachedManifest: vi.fn(() => manifest),
      dispatchAction: vi.fn().mockRejectedValue(new Error("transport went away")),
    });
    const server = createSessionServer("s-throw", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.list",
      arguments: {},
    })) as { isError: boolean; content: { type: string; text: string }[] };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe(EXECUTION_ERROR_CODE);
    expect(parsed.retriable).toBe(true);
    expect(parsed.message).toContain("transport went away");
  });

  it("maps SessionBindingError to SESSION_BINDING_GONE with retriable=false (#8432)", async () => {
    const manifest = [
      {
        id: "worktree.list",
        title: "Worktree: list",
        description: "List",
        category: "worktree",
        danger: "safe" as const,
        source: ["agent"] as const,
      },
    ] as unknown as import("../../../../shared/types/actions.js").ActionManifestEntry[];
    const deps = fakeDeps({
      requestManifest: vi.fn().mockResolvedValue(manifest),
      getCachedManifest: vi.fn(() => manifest),
      dispatchAction: vi.fn().mockRejectedValue(new SessionBindingError(42)),
    });
    const server = createSessionServer("s-binding", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.list",
      arguments: {},
    })) as { isError: boolean; content: { type: string; text: string }[] };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe(SESSION_BINDING_GONE);
    expect(parsed.retriable).toBe(false);
    expect(parsed.message).toContain("Do not retry");
    expect(parsed.message).toContain("42");
  });

  it("reclassifies a no-channel confirm dispatch to CONFIRMATION_REQUIRED, not EXECUTION_ERROR (#10640)", async () => {
    // recipe.run is a real danger:"confirm" action in the full tool set. Its
    // unconfirmed dispatch is forwarded to the renderer bridge (host-side
    // confirmation, #11342), which throws RendererBridgeUnavailableError when
    // no Daintree window is open. Because the manifest entry IS known to be
    // confirm-gated, that must surface as a non-retriable CONFIRMATION_REQUIRED
    // (the human couldn't be asked) rather than a retriable EXECUTION_ERROR.
    const manifest = [
      {
        id: "recipe.run",
        title: "Recipe: run",
        description: "Run a recipe",
        category: "recipe",
        danger: "confirm" as const,
        source: ["agent"] as const,
      },
    ] as unknown as import("../../../../shared/types/actions.js").ActionManifestEntry[];
    const dispatchAction = vi.fn().mockRejectedValue(new RendererBridgeUnavailableError());
    const deps = fakeDeps({
      // full tier so recipe.run clears the tier floor and reaches dispatch.
      sessionStore: fakeSessionStore("full"),
      requestManifest: vi.fn().mockResolvedValue(manifest),
      getCachedManifest: vi.fn(() => manifest),
      dispatchAction,
    });
    const server = createSessionServer("s-no-channel", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "recipe.run",
      arguments: {},
    })) as { isError: boolean; content: { type: string; text: string }[] };

    // Dispatch was attempted unconfirmed (the renderer is the confirm gate).
    expect(dispatchAction).toHaveBeenCalledWith("recipe.run", {}, false);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe("CONFIRMATION_REQUIRED");
    expect(parsed.retriable).toBe(false);
    expect(parsed.details).toEqual({ confirmationChannel: "unavailable" });
  });

  it("keeps a retriable EXECUTION_ERROR for a non-confirm tool when the bridge is unavailable (#10640)", async () => {
    // The reclassification is scoped to confirm-gated tools. A safe tool that
    // hits the same RendererBridgeUnavailableError is a genuine "no renderer"
    // failure (nothing needed confirming) and stays a retriable EXECUTION_ERROR
    // — but with an explicit cause rather than an opaque dispatch failure.
    const manifest = [
      {
        id: "worktree.list",
        title: "Worktree: list",
        description: "List worktrees",
        category: "worktree",
        danger: "safe" as const,
        source: ["agent"] as const,
      },
    ] as unknown as import("../../../../shared/types/actions.js").ActionManifestEntry[];
    const deps = fakeDeps({
      requestManifest: vi.fn().mockResolvedValue(manifest),
      getCachedManifest: vi.fn(() => manifest),
      dispatchAction: vi.fn().mockRejectedValue(new RendererBridgeUnavailableError()),
    });
    const server = createSessionServer("s-safe-no-channel", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.list",
      arguments: {},
    })) as { isError: boolean; content: { type: string; text: string }[] };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe(EXECUTION_ERROR_CODE);
    expect(parsed.retriable).toBe(true);
    expect(parsed.message).toContain("No Daintree window is open");
  });

  it("answers NO_FRONTEND_ATTACHED instead when Host-mode routing is on", async () => {
    const restore = setMcpDriveTargetResolver(() => ({ state: "vacant" }));
    try {
      const deps = fakeDeps({
        sessionStore: fakeSessionStore("full"),
        getCachedManifest: vi.fn(() => null),
        requestManifest: vi.fn().mockRejectedValue(new RendererBridgeUnavailableError()),
        dispatchAction: vi.fn().mockRejectedValue(new RendererBridgeUnavailableError()),
      });
      const server = createSessionServer("s-host-mode-no-channel", deps);
      await server.connect(makeMockTransport());

      const result = (await callTool(server, {
        name: "recipe.run",
        arguments: {},
      })) as { isError: boolean; content: { type: string; text: string }[] };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe(NO_FRONTEND_ATTACHED_CODE);
      expect(parsed.retriable).toBe(true);
      // Past the tier gate: the refusal is the dispatch's, not a tier's.
      expect(deps.dispatchAction).toHaveBeenCalledWith("recipe.run", {}, false);
    } finally {
      restore();
    }
  });

  it("cold-cache confirm tool with no renderer stays a retriable EXECUTION_ERROR — danger is unknowable without a manifest (#10640)", async () => {
    // Deliberate boundary: when no window is open AND the manifest cache is cold,
    // the manifest fetch itself goes through the renderer and throws, so
    // `lookupManifestEntry` returns undefined and the tool's danger is unknown.
    // We must NOT claim CONFIRMATION_REQUIRED for an unverified confirm tool, so
    // this stays a retriable EXECUTION_ERROR (the renderer may return when a
    // window opens) rather than the non-retriable confirmation signal the
    // warm-cache path produces.
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      // Cold cache + no renderer: both the manifest fetch and the dispatch fail.
      getCachedManifest: vi.fn(() => null),
      requestManifest: vi.fn().mockRejectedValue(new RendererBridgeUnavailableError()),
      dispatchAction: vi.fn().mockRejectedValue(new RendererBridgeUnavailableError()),
    });
    const server = createSessionServer("s-cold-cache", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "recipe.run",
      arguments: {},
    })) as { isError: boolean; content: { type: string; text: string }[] };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe(EXECUTION_ERROR_CODE);
    expect(parsed.retriable).toBe(true);
    expect(parsed.message).toContain("No Daintree window is open");
  });
});

describe("structuredContent for terminal query actions (#10676)", () => {
  // The three high-value query actions carry `mcpOutputSchema: true`, so the real
  // manifest entry the renderer reports back carries an object-typed outputSchema.
  // Mirror that here (per-action, so the fixture shape tracks the real result)
  // so the CallTool path exercises buildStructuredContent.
  const OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
    "terminal.list": { type: "object", properties: { terminals: { type: "array" } } },
    "terminal.getStatus": { type: "object", properties: { terminals: { type: "array" } } },
    "terminal.getOutput": {
      type: "object",
      properties: {
        terminalId: { type: "string" },
        content: { type: ["string", "null"] },
        lineCount: { type: "number" },
        truncated: { type: "boolean" },
      },
    },
  };

  function entryWithOutputSchema(id: string): ActionManifestEntry {
    return {
      ...makeManifestEntry(id),
      outputSchema: OUTPUT_SCHEMAS[id] ?? { type: "object", properties: {} },
    };
  }

  function structuredOf(result: unknown): Record<string, unknown> | undefined {
    return (result as { structuredContent?: Record<string, unknown> }).structuredContent;
  }

  function textOf(result: unknown): string {
    return (result as { content: { text: string }[] }).content[0].text;
  }

  // The ids exercised here (terminal.list/getStatus/getOutput) are all
  // curated-allowlist members, so the external-tier call reaches dispatch.
  function deps(id: string, payload: unknown, withSchema = true): SessionServerDeps {
    return fakeDeps({
      sessionStore: fakeSessionStore("external"),
      requestManifest: vi
        .fn()
        .mockResolvedValue([withSchema ? entryWithOutputSchema(id) : makeManifestEntry(id)]),
      dispatchAction: vi.fn().mockResolvedValue({ result: { ok: true, result: payload } }),
    });
  }

  it("emits structuredContent for terminal.list and still emits the JSON text body", async () => {
    const payload = { terminals: [{ id: "t-1", kind: "terminal", isFocused: true }] };
    const server = createSessionServer("sc-list", deps("terminal.list", payload));
    const result = await callTool(server, { name: "terminal.list", arguments: {} });

    expect(structuredOf(result)).toEqual(payload);
    // Backward compatibility: the text body is preserved for clients that ignore
    // structuredContent, and it serializes the same data.
    expect(JSON.parse(textOf(result))).toEqual(payload);
  });

  it("emits structuredContent for an empty result set (not just non-empty)", async () => {
    const payload = { terminals: [] };
    const server = createSessionServer("sc-empty", deps("terminal.list", payload));
    const result = await callTool(server, { name: "terminal.list", arguments: {} });

    expect(structuredOf(result)).toEqual(payload);
  });

  it("omits structuredContent when the manifest entry carries no outputSchema", async () => {
    // Proves the outputSchema gate is load-bearing: without it, the same object
    // result falls back to a text-only response (the pre-#10676 behavior).
    const payload = { terminals: [{ id: "t-1" }] };
    const server = createSessionServer(
      "sc-noschema",
      deps("terminal.list", payload, /* withSchema */ false)
    );
    const result = await callTool(server, { name: "terminal.list", arguments: {} });

    expect(structuredOf(result)).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual(payload);
  });

  it("emits structuredContent for a windowless-only tool when no frontend is attached (#15731)", async () => {
    // `agent.listModels` is in the viewless catalog but not the external tier, so
    // the cold-cache lookup under NoFrontendAttachedError used to find no entry
    // and the same call answered as JSON text only.
    // Pinned so the test fails loudly, rather than silently passing without the
    // fix, if the tool ever joins the external tier the old lookup read.
    expect(MCP_EXTERNAL_BASE_MANIFEST.some((e) => e.id === "agent.listModels")).toBe(false);
    const payload = { agents: [{ agentId: "codex", models: [] }] };
    const server = createSessionServer(
      "sc-viewless-only",
      fakeDeps({
        sessionStore: fakeSessionStore("full"),
        getCachedManifest: vi.fn(() => null),
        requestManifest: vi.fn().mockRejectedValue(new NoFrontendAttachedError("ws-1")),
        dispatchAction: vi.fn().mockResolvedValue({ result: { ok: true, result: payload } }),
      })
    );
    const result = await callTool(server, { name: "agent.listModels", arguments: {} });

    expect(structuredOf(result)).toEqual(payload);
    expect(JSON.parse(textOf(result))).toEqual(payload);
  });

  describe("oversized results are capped on the wire (#11526)", () => {
    function oversizedPayload() {
      return { terminals: [{ id: "t-1", content: "x".repeat(TOOL_RESULT_TEXT_MAX_BYTES * 2) }] };
    }

    it("truncates the text body of a dispatched result to the byte budget", async () => {
      const server = createSessionServer(
        "sc-oversized",
        deps("terminal.getOutput", oversizedPayload())
      );
      const result = await callTool(server, {
        name: "terminal.getOutput",
        arguments: { terminalId: "t-1" },
      });

      expect(Buffer.byteLength(textOf(result), "utf8")).toBeLessThanOrEqual(
        TOOL_RESULT_TEXT_MAX_BYTES
      );
      expect(textOf(result).startsWith("[Tool result truncated:")).toBe(true);
    });

    it("drops structuredContent above the cap so the duplicate cannot smuggle the payload", async () => {
      const server = createSessionServer(
        "sc-oversized-structured",
        deps("terminal.list", oversizedPayload())
      );
      const result = await callTool(server, { name: "terminal.list", arguments: {} });

      expect(structuredOf(result)).toBeUndefined();
    });

    it("flags a capped result whose tool declares an output schema", async () => {
      // structuredContent is present exactly when the entry declares an
      // outputSchema, and a client with that schema rejects a response carrying
      // neither it nor isError — the notice would never reach the agent.
      const server = createSessionServer(
        "sc-oversized-flagged",
        deps("terminal.list", oversizedPayload())
      );
      const result = await callTool(server, { name: "terminal.list", arguments: {} });

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toContain("Tool result truncated");
    });

    it("leaves a capped result unflagged when the tool declares no output schema", async () => {
      // Nothing was promised, so nothing is missing — a shortened body is still a
      // successful call.
      const server = createSessionServer(
        "sc-oversized-ok",
        deps("terminal.list", oversizedPayload(), false)
      );
      const result = await callTool(server, { name: "terminal.list", arguments: {} });

      expect((result as { isError?: boolean }).isError).not.toBe(true);
      expect(textOf(result)).toContain("Tool result truncated");
    });

    it("caps an error envelope whose renderer-supplied details is oversized", async () => {
      // `details` crosses from the renderer unbounded, so failures reach the
      // same oversized-response bug the success path just closed.
      const server = createSessionServer(
        "sc-oversized-error",
        fakeDeps({
          sessionStore: fakeSessionStore("external"),
          requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("terminal.list")]),
          dispatchAction: vi.fn().mockResolvedValue({
            result: {
              ok: false,
              error: {
                code: "EXECUTION_ERROR",
                message: "boom",
                details: { trace: "x".repeat(TOOL_RESULT_TEXT_MAX_BYTES * 2) },
              },
            },
          }),
        })
      );
      const result = await callTool(server, { name: "terminal.list", arguments: {} });

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(Buffer.byteLength(textOf(result), "utf8")).toBeLessThanOrEqual(
        TOOL_RESULT_TEXT_MAX_BYTES
      );
      expect(textOf(result).startsWith("[Tool result truncated:")).toBe(true);
    });

    it("keeps the batched-wait short-circuit intact below the cap", async () => {
      // The only converted call site with no other result-path coverage.
      const payload = { results: [{ terminalId: "t-1", idle: true }], timedOut: false };
      const server = createSessionServer(
        "sc-batch-wait",
        fakeDeps({
          sessionStore: fakeSessionStore("external"),
          requestManifest: vi
            .fn()
            .mockResolvedValue([makeManifestEntry("terminal.waitUntilIdleBatch")]),
          handleWaitUntilIdleBatch: vi.fn().mockResolvedValue(payload),
        })
      );
      const result = await callTool(server, {
        name: "terminal.waitUntilIdleBatch",
        arguments: { terminalIds: ["t-1"] },
      });

      expect(JSON.parse(textOf(result))).toEqual(payload);
      expect(structuredOf(result)).toEqual(payload);
    });

    it("caps a main-process short-circuit that attaches structuredContent unconditionally", async () => {
      // skills.load never consults buildStructuredContent, so it needs the cap
      // applied at its own return site rather than via the outputSchema gate.
      const server = createSessionServer(
        "sc-oversized-skills",
        fakeDeps({
          sessionStore: fakeSessionStore("external"),
          requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("skills.load")]),
          handleSkillsLoad: vi.fn(() => ({
            id: "s-1",
            name: "Oversized",
            description: "A skill whose markdown body blows the budget",
            body: "x".repeat(TOOL_RESULT_TEXT_MAX_BYTES * 2),
          })),
        })
      );
      const result = await callTool(server, {
        name: "skills.load",
        arguments: { id: "s-1" },
      });

      expect(Buffer.byteLength(textOf(result), "utf8")).toBeLessThanOrEqual(
        TOOL_RESULT_TEXT_MAX_BYTES
      );
      expect(structuredOf(result)).toBeUndefined();
    });
  });
});

describe("resolved-workspace result metadata (#11536)", () => {
  const WORKSPACE = {
    kind: "project" as const,
    workspaceId: "proj-a",
    workspacePath: "/repos/a",
  };

  const manifest = [
    {
      id: "worktree.list",
      title: "Worktree: list",
      description: "List worktrees",
      category: "worktree",
      danger: "safe" as const,
      source: ["agent"] as const,
    },
  ] as unknown as ActionManifestEntry[];

  function metaOf(result: unknown): Record<string, unknown> | undefined {
    return (result as { _meta?: Record<string, unknown> })._meta;
  }

  function workspaceMetaOf(result: unknown): unknown {
    return metaOf(result)?.[RESOLVED_WORKSPACE_META_KEY];
  }

  function textOf(result: unknown): string {
    return (result as { content: { type: string; text: string }[] }).content[0].text;
  }

  function depsFor(dispatch: unknown) {
    return fakeDeps({
      requestManifest: vi.fn().mockResolvedValue(manifest),
      getCachedManifest: vi.fn(() => manifest),
      dispatchAction: vi.fn().mockResolvedValue(dispatch),
    });
  }

  it("stamps the dispatched workspace on a successful result", async () => {
    const server = createSessionServer(
      "rp-ok",
      depsFor({ result: { ok: true, result: { hits: [] } }, dispatchedWorkspace: WORKSPACE })
    );
    await server.connect(makeMockTransport());

    const result = await callTool(server, { name: "worktree.list", arguments: {} });

    expect(workspaceMetaOf(result)).toEqual(WORKSPACE);
  });

  it("merges into an existing _meta without clobbering sibling keys or mutating the input", () => {
    const original = {
      content: [{ type: "text" as const, text: "ok" }],
      _meta: { "vendor.other/trace": "abc" },
    };

    const stamped = withResolvedWorkspace(original, WORKSPACE);

    expect(stamped._meta).toEqual({
      "vendor.other/trace": "abc",
      [RESOLVED_WORKSPACE_META_KEY]: WORKSPACE,
    });
    // Additive, never destructive: the caller's object is untouched.
    expect(original._meta).toEqual({ "vendor.other/trace": "abc" });
  });

  it("returns the result untouched when the workspace is unknown", () => {
    const original = { content: [{ type: "text" as const, text: "ok" }] };

    expect(withResolvedWorkspace(original, undefined)).toBe(original);
  });

  it("stamps the dispatched workspace on a renderer-returned action error", async () => {
    const server = createSessionServer(
      "rp-err",
      depsFor({
        result: {
          ok: false,
          error: { code: "VALIDATION_ERROR", message: "nope", details: { field: "query" } },
        },
        dispatchedWorkspace: WORKSPACE,
      })
    );
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.list",
      arguments: {},
    })) as { isError: boolean };

    // A renderer was reached, so the target is known and worth reporting —
    // and the error payload itself must survive the stamp untouched.
    expect(result.isError).toBe(true);
    expect(workspaceMetaOf(result)).toEqual(WORKSPACE);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.code).toBe("VALIDATION_ERROR");
    expect(parsed.message).toBe("nope");
    expect(parsed.details).toEqual({ field: "query" });
  });

  it("omits the key entirely when the dispatch reported no workspace", async () => {
    const server = createSessionServer("rp-none", depsFor({ result: { ok: true, result: "ok" } }));
    await server.connect(makeMockTransport());

    const result = await callTool(server, { name: "worktree.list", arguments: {} });

    // Absent, not null — "unknown" must not be confusable with "no workspace".
    expect(workspaceMetaOf(result)).toBeUndefined();
    expect(metaOf(result) === undefined || !(RESOLVED_WORKSPACE_META_KEY in metaOf(result)!)).toBe(
      true
    );
  });

  it("does not stamp a pre-dispatch failure, where no renderer was reached", async () => {
    const dispatchAction = vi.fn().mockRejectedValue(new RendererBridgeUnavailableError());
    const deps = fakeDeps({
      requestManifest: vi.fn().mockResolvedValue(manifest),
      getCachedManifest: vi.fn(() => manifest),
      dispatchAction,
    });
    const server = createSessionServer("rp-nowindow", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.list",
      arguments: {},
    })) as { isError: boolean };

    // Prove it really took the no-window dispatch path rather than bailing out
    // earlier for an unrelated reason.
    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result)).code).toBe(EXECUTION_ERROR_CODE);
    expect(workspaceMetaOf(result)).toBeUndefined();
  });

  it("preserves structuredContent alongside the stamp", async () => {
    const payload = { terminals: [{ id: "t-1", kind: "terminal", isFocused: true }] };
    const entry: ActionManifestEntry = {
      ...({
        id: "terminal.list",
        name: "terminal.list",
        title: "Terminal: list",
        description: "List terminals",
        category: "terminal",
        kind: "query",
        danger: "safe",
        enabled: true,
        requiresArgs: false,
      } as unknown as ActionManifestEntry),
      outputSchema: {
        type: "object",
        properties: { terminals: { type: "array" } },
      },
    };
    const server = createSessionServer(
      "rp-structured",
      fakeDeps({
        // `terminal.list` is on the curated external allowlist, so the external
        // tier reaches it on the allowlist alone (#11537 deleted the widening opt-in).
        sessionStore: fakeSessionStore("external"),
        requestManifest: vi.fn().mockResolvedValue([entry]),
        getCachedManifest: vi.fn(() => [entry]),
        dispatchAction: vi.fn().mockResolvedValue({
          result: { ok: true, result: payload },
          dispatchedWorkspace: WORKSPACE,
        }),
      })
    );
    await server.connect(makeMockTransport());

    const result = await callTool(server, { name: "terminal.list", arguments: {} });

    // The stamp must not displace structuredContent — both ride the same result.
    expect(workspaceMetaOf(result)).toEqual(WORKSPACE);
    expect((result as { structuredContent?: unknown }).structuredContent).toEqual(payload);
    expect(JSON.parse(textOf(result))).toEqual(payload);
  });
});
