import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WhySlowSnapshot } from "../../../../shared/types/whySlow.js";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

// Mirror define.js's wiring so each op body can be invoked directly. The
// with-context variant reconstructs the IpcContext from the raw event, matching
// the real typedHandleWithContextValidated (webContentsId := event.sender.id).
const utilsMock = vi.hoisted(() => ({
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleValidated: vi.fn(),
  typedHandleWithContext: vi.fn(),
  typedHandleWithContextValidated: (
    channel: string,
    schema: { parse: (input: unknown) => unknown },
    handler: unknown
  ) => {
    ipcMainMock.handle(channel, (event: { sender: { id: number } }, ...args: unknown[]) => {
      const ctx = { event, webContentsId: event.sender.id };
      return (handler as (ctx: unknown, payload: unknown) => unknown)(ctx, schema.parse(args[0]));
    });
    return () => ipcMainMock.removeHandler(channel);
  },
}));

vi.mock("../../utils.js", () => utilsMock);

const collectorMock = vi.hoisted(() => ({ collectWhySlowSnapshot: vi.fn() }));
vi.mock("../../../services/DiagnosticsCollector.js", () => collectorMock);

const cacheMock = vi.hoisted(() => ({ recordRendererTerminalDiagnostics: vi.fn() }));
vi.mock("../../../services/RendererTerminalDiagnosticsCache.js", () => cacheMock);

import { registerWhySlowHandlers } from "../whySlow.js";

function getRegistered(channel: string): (...args: unknown[]) => unknown {
  const entry = ipcMainMock.handle.mock.calls.find(([ch]) => ch === channel);
  if (!entry) throw new Error(`no handler registered for ${channel}`);
  return entry[1] as (...args: unknown[]) => unknown;
}

const VALID_REPORT = {
  webglMode: "webgl",
  wantsWebgl: 2,
  terminalCount: 4,
  countsByTier: { FOCUSED: 1, BACKGROUND: 3 },
};

function eventFrom(senderId: number, isDestroyed = false) {
  return { sender: { id: senderId, isDestroyed: () => isDestroyed } };
}

describe("registerWhySlowHandlers — getWhySlowSnapshot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the collector snapshot", async () => {
    const snapshot: WhySlowSnapshot = {
      timestamp: 123,
      resource: null,
      focusThrottle: { throttled: false, pollMultiplier: 1 },
      rendererTerminals: [],
      pty: null,
      worktrees: null,
    };
    collectorMock.collectWhySlowSnapshot.mockResolvedValue(snapshot);

    registerWhySlowHandlers({} as never);
    const result = await getRegistered("system:get-why-slow-snapshot")(null);

    expect(result).toEqual(snapshot);
    expect(collectorMock.collectWhySlowSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe("registerWhySlowHandlers — reportTerminalRendererDiagnostics", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records the report keyed by the context webContents id, ignoring renderer-supplied ids", async () => {
    registerWhySlowHandlers({} as never);

    // A hostile renderer can inject an extra id in the payload; the schema strips
    // it and the handler keys off ctx.webContentsId (the trusted event sender).
    await getRegistered("system:report-terminal-renderer-diagnostics")(eventFrom(77), {
      ...VALID_REPORT,
      webContentsId: 999,
    });

    expect(cacheMock.recordRendererTerminalDiagnostics).toHaveBeenCalledTimes(1);
    const [id, payload] = cacheMock.recordRendererTerminalDiagnostics.mock.calls[0];
    expect(id).toBe(77);
    expect(payload).not.toHaveProperty("webContentsId");
    expect(payload).toMatchObject({ webglMode: "webgl", terminalCount: 4 });
  });

  it("ignores reports from a destroyed sender", async () => {
    registerWhySlowHandlers({} as never);

    await getRegistered("system:report-terminal-renderer-diagnostics")(
      eventFrom(77, true),
      VALID_REPORT
    );

    expect(cacheMock.recordRendererTerminalDiagnostics).not.toHaveBeenCalled();
  });

  it("rejects malformed payloads at the IPC boundary", async () => {
    registerWhySlowHandlers({} as never);
    const handler = getRegistered("system:report-terminal-renderer-diagnostics");

    expect(() => handler(eventFrom(77), { webglMode: "vulkan" })).toThrow();
    expect(() => handler(eventFrom(77), { ...VALID_REPORT, terminalCount: -1 })).toThrow();
    expect(cacheMock.recordRendererTerminalDiagnostics).not.toHaveBeenCalled();
  });
});
