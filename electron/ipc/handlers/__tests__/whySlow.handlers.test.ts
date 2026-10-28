import { describe, it, expect, vi, beforeEach } from "vitest";

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

const memoryAccountingMock = vi.hoisted(() => ({ getCompositeMemorySnapshot: vi.fn() }));
vi.mock("../../../services/memoryAccounting.js", () => memoryAccountingMock);

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

  it("rejects an oversized tier map so a buggy renderer can't balloon the cache", async () => {
    registerWhySlowHandlers({} as never);
    const handler = getRegistered("system:report-terminal-renderer-diagnostics");

    const countsByTier: Record<string, number> = {};
    for (let i = 0; i < 64; i++) countsByTier[`tier-${i}`] = 1;

    expect(() => handler(eventFrom(77), { ...VALID_REPORT, countsByTier })).toThrow();
    expect(cacheMock.recordRendererTerminalDiagnostics).not.toHaveBeenCalled();
  });

  it("accepts buffer line counts and strips anything else a renderer adds (#14213)", async () => {
    registerWhySlowHandlers({} as never);

    await getRegistered("system:report-terminal-renderer-diagnostics")(eventFrom(77), {
      ...VALID_REPORT,
      bufferMemory: {
        sampledAt: 1_000,
        terminals: [
          { terminalId: "t1", normalLines: 10_000, alternateLines: 40, cols: 182, text: "secret" },
        ],
      },
    });

    const [, payload] = cacheMock.recordRendererTerminalDiagnostics.mock.calls[0];
    expect(payload.bufferMemory).toEqual({
      sampledAt: 1_000,
      terminals: [{ terminalId: "t1", normalLines: 10_000, alternateLines: 40, cols: 182 }],
    });
  });

  it("rejects malformed buffer counts", () => {
    registerWhySlowHandlers({} as never);
    const handler = getRegistered("system:report-terminal-renderer-diagnostics");
    const terminal = { terminalId: "t1", normalLines: 1, alternateLines: 0, cols: 80 };

    expect(() =>
      handler(eventFrom(77), {
        ...VALID_REPORT,
        bufferMemory: { sampledAt: 1, terminals: [{ ...terminal, normalLines: -1 }] },
      })
    ).toThrow();
    expect(() =>
      handler(eventFrom(77), {
        ...VALID_REPORT,
        bufferMemory: { sampledAt: 1, terminals: [{ ...terminal, cols: 1.5 }] },
      })
    ).toThrow();
    expect(() =>
      handler(eventFrom(77), {
        ...VALID_REPORT,
        bufferMemory: { sampledAt: 1, terminals: Array.from({ length: 1_001 }, () => terminal) },
      })
    ).toThrow();
    expect(cacheMock.recordRendererTerminalDiagnostics).not.toHaveBeenCalled();
  });
});

describe("registerWhySlowHandlers — getMemorySnapshot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks for renderer terminal buffers on the user-pulled read", async () => {
    const deps = { ptyClient: null } as never;
    memoryAccountingMock.getCompositeMemorySnapshot.mockResolvedValue({ timestamp: 1 });
    registerWhySlowHandlers(deps);

    await getRegistered("system:get-memory-snapshot")({});

    expect(memoryAccountingMock.getCompositeMemorySnapshot).toHaveBeenCalledWith(null, {
      rendererTerminalBuffers: deps,
    });
  });
});
