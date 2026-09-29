import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const { broadcastToRenderer, broadcastToProjectRenderers, revokePaneConfig } = vi.hoisted(() => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
  revokePaneConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../utils.js", () => ({ broadcastToRenderer, broadcastToProjectRenderers }));
vi.mock("../../../../services/McpPaneConfigService.js", () => ({
  mcpPaneConfigService: { revokePaneConfig },
}));
vi.mock("../../../../services/pty/agentSessionCapturePersistence.js", () => ({
  acceptCapturedAgentSession: vi.fn(),
  releaseSupersededCapturedSession: vi.fn(),
}));
vi.mock("../../../../services/events.js", () => ({
  events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
}));

import { CHANNELS } from "../../../channels.js";
import { registerTerminalEventHandlers } from "../events.js";
import { SPAWN_CONFIRMATION_TIMEOUT_MS, armSpawnConfirmation } from "../spawnConfirmation.js";
import type { HandlerDependencies } from "../../../types.js";

describe("terminal event handlers — spawn confirmation (#12754)", () => {
  let ptyClient: EventEmitter & { getTerminalProjectId: ReturnType<typeof vi.fn> };
  let dispose: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    ptyClient = Object.assign(new EventEmitter(), {
      getTerminalProjectId: vi.fn(() => "project-a"),
    });
    dispose = registerTerminalEventHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
    vi.useRealTimers();
  });

  function spawnResultEnvelopes() {
    return broadcastToRenderer.mock.calls.filter(
      (call) => call[0] === CHANNELS.EVENTS_PUSH && call[1]?.name === "terminal:spawn-result"
    );
  }

  it("tells the renderer when the host never answers, without main-side failure handling", () => {
    armSpawnConfirmation("t1");
    vi.advanceTimersByTime(SPAWN_CONFIRMATION_TIMEOUT_MS);

    const envelopes = spawnResultEnvelopes();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]![1].payload).toEqual([
      "t1",
      expect.objectContaining({
        success: false,
        id: "t1",
        error: expect.objectContaining({ code: "SPAWN_TIMEOUT" }),
      }),
    ]);
    // The spawn may still land — nothing may treat this as a final failure.
    expect(revokePaneConfig).not.toHaveBeenCalled();
  });

  it("a real spawn-result settles the window", () => {
    armSpawnConfirmation("t1");
    ptyClient.emit("spawn-result", "t1", { success: true, id: "t1" });
    vi.advanceTimersByTime(SPAWN_CONFIRMATION_TIMEOUT_MS * 2);

    expect(spawnResultEnvelopes()).toHaveLength(1);
    expect(spawnResultEnvelopes()[0]![1].payload[1]).toMatchObject({ success: true });
  });

  it("a predecessor's exit does not disarm a restarted launch's window", () => {
    armSpawnConfirmation("t1");
    ptyClient.emit("exit", "t1", 0);
    vi.advanceTimersByTime(SPAWN_CONFIRMATION_TIMEOUT_MS);

    expect(spawnResultEnvelopes()).toHaveLength(1);
    expect(spawnResultEnvelopes()[0]![1].payload[1]).toMatchObject({
      error: { code: "SPAWN_TIMEOUT" },
    });
  });

  it("disposing the handlers drops armed windows", () => {
    armSpawnConfirmation("t1");
    dispose();
    dispose = () => {};
    vi.advanceTimersByTime(SPAWN_CONFIRMATION_TIMEOUT_MS);
    expect(spawnResultEnvelopes()).toHaveLength(0);
  });
});
