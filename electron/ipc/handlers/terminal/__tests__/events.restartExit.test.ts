import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type { HandlerDependencies } from "../../../types.js";

const { broadcastToRenderer, revokePaneConfig, handleTerminalExit } = vi.hoisted(() => ({
  broadcastToRenderer: vi.fn(),
  revokePaneConfig: vi.fn().mockResolvedValue(undefined),
  handleTerminalExit: vi.fn(),
}));

vi.mock("../../../utils.js", () => ({ broadcastToRenderer }));
vi.mock("../../../../services/McpPaneConfigService.js", () => ({
  mcpPaneConfigService: { revokePaneConfig },
}));
vi.mock("../../../../services/pty/agentSessionCapturePersistence.js", () => ({
  acceptCapturedAgentSession: vi.fn(),
  releaseSupersededCapturedSession: vi.fn(),
}));
vi.mock("../../../../window/serviceRefs.js", () => ({
  getMcpServerServiceRef: () => ({ handleTerminalExit }),
}));
vi.mock("../../../../services/events.js", () => ({
  events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
}));

import { CHANNELS } from "../../../channels.js";
import { registerTerminalEventHandlers } from "../events.js";

describe("terminal exit forwarding during restart", () => {
  let ptyClient: EventEmitter & { consumeRestartExitSuppression: ReturnType<typeof vi.fn> };
  let dispose: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ptyClient = Object.assign(new EventEmitter(), {
      consumeRestartExitSuppression: vi.fn().mockReturnValue(false),
    });
    dispose = registerTerminalEventHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => dispose());

  it("withholds the restart exit from every view but still retires the old MCP bearer", () => {
    ptyClient.consumeRestartExitSuppression.mockReturnValueOnce(true);

    ptyClient.emit("exit", "t1", 0);

    expect(broadcastToRenderer).not.toHaveBeenCalled();
    expect(revokePaneConfig).toHaveBeenCalledExactlyOnceWith("t1");
    expect(handleTerminalExit).toHaveBeenCalledExactlyOnceWith("t1");

    ptyClient.emit("exit", "t1", 1);

    expect(broadcastToRenderer).toHaveBeenCalledExactlyOnceWith(CHANNELS.EVENTS_PUSH, {
      name: "terminal:exit",
      payload: ["t1", 1],
    });
  });

  it("continues forwarding ordinary successful exits", () => {
    ptyClient.emit("exit", "t1", 0);

    expect(broadcastToRenderer).toHaveBeenCalledExactlyOnceWith(CHANNELS.EVENTS_PUSH, {
      name: "terminal:exit",
      payload: ["t1", 0],
    });
  });
});
