import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const handleTerminalExit = vi.hoisted(() => vi.fn());
const handleTerminalSpawnResult = vi.hoisted(() => vi.fn());
const serviceRef = vi.hoisted(() => ({
  current: null as {
    handleTerminalExit: typeof handleTerminalExit;
    handleTerminalSpawnResult: typeof handleTerminalSpawnResult;
  } | null,
}));

vi.mock("../../../utils.js", () => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
}));
vi.mock("../../../../services/McpPaneConfigService.js", () => ({
  mcpPaneConfigService: { revokePaneConfig: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../../../services/pty/agentSessionCapturePersistence.js", () => ({
  acceptCapturedAgentSession: vi.fn(),
  releaseSupersededCapturedSession: vi.fn(),
}));
vi.mock("../../../../window/serviceRefs.js", () => ({
  getMcpServerServiceRef: () => serviceRef.current,
}));

import { registerTerminalEventHandlers } from "../events.js";
import type { HandlerDependencies } from "../../../types.js";

// A hand-over is of one running process (#12490): every exit and spawn result
// is handed to the MCP server, which alone knows which launch was handed over.
// The orchestrator's side ends with its bearer, which the pane-config
// revocation covers.
describe("terminal event handlers — terminal hand-over (#12490)", () => {
  let dispose: () => void;
  let ptyClient: EventEmitter;

  beforeEach(() => {
    handleTerminalExit.mockReset();
    handleTerminalSpawnResult.mockReset();
    serviceRef.current = { handleTerminalExit, handleTerminalSpawnResult };
    ptyClient = Object.assign(new EventEmitter(), { getTerminalProjectId: vi.fn() });
    dispose = registerTerminalEventHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
  });

  it("reports every exit", () => {
    ptyClient.emit("exit", "t1", 0);

    expect(handleTerminalExit).toHaveBeenCalledWith("t1");
  });

  it("reports every spawn result whole, failures included", () => {
    const succeeded = { success: true, id: "t1", launchGeneration: 4 };
    const refused = {
      success: false,
      id: "t2",
      launchGeneration: 2,
      error: { code: "TERMINAL_ALREADY_LIVE", message: "still running" },
    };
    ptyClient.emit("spawn-result", "t1", succeeded);
    ptyClient.emit("spawn-result", "t2", refused);

    expect(handleTerminalSpawnResult.mock.calls).toEqual([
      ["t1", succeeded],
      ["t2", refused],
    ]);
  });

  it("does nothing before the MCP server has ever loaded", () => {
    serviceRef.current = null;

    expect(() => ptyClient.emit("exit", "t1", 0)).not.toThrow();
    expect(() =>
      ptyClient.emit("spawn-result", "t1", { success: true, id: "t1", launchGeneration: 1 })
    ).not.toThrow();
  });
});
