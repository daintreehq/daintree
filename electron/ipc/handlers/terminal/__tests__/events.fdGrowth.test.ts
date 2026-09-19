import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type { FdGrowthPayload } from "../../../../../shared/types/pty-host.js";

const { broadcastToRenderer, broadcastToProjectRenderers, logWarn, logInfo } = vi.hoisted(() => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("../../../utils.js", () => ({ broadcastToRenderer, broadcastToProjectRenderers }));
vi.mock("../../../../utils/logger.js", () => ({ logWarn, logInfo }));
vi.mock("../../../../services/McpPaneConfigService.js", () => ({
  mcpPaneConfigService: { revokePaneConfig: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../../../services/pty/agentSessionCapturePersistence.js", () => ({
  acceptCapturedAgentSession: vi.fn(),
  releaseSupersededCapturedSession: vi.fn(),
}));
vi.mock("../../../../services/events.js", () => ({
  events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
}));

import { registerTerminalEventHandlers } from "../events.js";
import type { HandlerDependencies } from "../../../types.js";

function makePayload(overrides: Partial<FdGrowthPayload> = {}): FdGrowthPayload {
  return {
    state: "elevated",
    hostPid: 4242,
    terminals: 25,
    pooledPtys: 2,
    pluginPtys: 0,
    analysisWorkers: 3,
    fdCount: 140,
    expectedFds: 60,
    baselineFds: 37,
    growth: 43,
    sustainedSamples: 3,
    sampleIntervalMs: 30000,
    episodeStartedAt: 1_000_000,
    descriptorTypes: {
      charDevice: 28,
      socket: 3,
      fifo: 30,
      file: 70,
      directory: 6,
      other: 0,
      unavailable: 3,
    },
    timestamp: 1_060_000,
    ...overrides,
  };
}

describe("terminal event handlers — fd-growth (#12520)", () => {
  let ptyClient: EventEmitter & { getTerminalProjectId: ReturnType<typeof vi.fn> };
  let dispose: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ptyClient = Object.assign(new EventEmitter(), {
      getTerminalProjectId: vi.fn(),
    });
    dispose = registerTerminalEventHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
  });

  it("writes one warning per elevated transition, with the observation as context", () => {
    const payload = makePayload();

    ptyClient.emit("fd-growth", payload);

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logInfo).not.toHaveBeenCalled();
    const [message, context] = logWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(context).toEqual(payload);
    expect(message).toContain("pty-host 4242 FD count elevated");
    expect(message).toContain("140 open descriptors, 60 expected");
    expect(message).toContain("25 terminals, 2 pooled PTYs, 0 plugin PTYs, 3 analysis workers");
    expect(message).toContain("growth 43 over the post-restore baseline of 37");
    expect(message).toContain("for 3 samples 30s apart");
    expect(message).toContain("file 70");
    expect(message).not.toContain("other 0");
  });

  it("writes one info record when the episode recovers", () => {
    const payload = makePayload({
      state: "recovered",
      fdCount: 99,
      growth: 2,
      sustainedSamples: 2,
      descriptorTypes: undefined,
      timestamp: 1_000_000 + 12 * 60_000,
    });

    ptyClient.emit("fd-growth", payload);

    expect(logWarn).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledTimes(1);
    const [message] = logInfo.mock.calls[0] as [string];
    expect(message).toContain("FD count back near baseline");
    expect(message).toContain("growth 2 over the post-restore baseline of 37");
    expect(message).toContain("12 min after it rose");
  });

  it("omits the type breakdown when the elevation carries none", () => {
    ptyClient.emit("fd-growth", makePayload({ descriptorTypes: undefined }));

    expect(logWarn).toHaveBeenCalledTimes(1);
    const [message] = logWarn.mock.calls[0] as [string];
    expect(message).toContain("FD count elevated");
    expect(message).not.toContain("Descriptor types");
    expect(message).not.toContain("undefined");
  });

  it("states observations only — no leak verdict and no PTY-limit percentage", () => {
    ptyClient.emit("fd-growth", makePayload());
    ptyClient.emit("fd-growth", makePayload({ state: "recovered", growth: 0 }));

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledTimes(1);
    for (const [message] of [...logWarn.mock.calls, ...logInfo.mock.calls] as [string][]) {
      expect(message).not.toMatch(/leak/i);
      expect(message).not.toMatch(/% of limit/);
    }
  });

  it("does not relay either transition to renderers, so open views add no copies", () => {
    ptyClient.emit("fd-growth", makePayload());
    ptyClient.emit("fd-growth", makePayload({ state: "recovered", growth: 0 }));

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(broadcastToRenderer).not.toHaveBeenCalled();
    expect(broadcastToProjectRenderers).not.toHaveBeenCalled();
  });

  it("stops handling transitions after dispose", () => {
    dispose();
    dispose = () => {};

    ptyClient.emit("fd-growth", makePayload());

    expect(logWarn).not.toHaveBeenCalled();
    expect(ptyClient.listenerCount("fd-growth")).toBe(0);
  });
});
