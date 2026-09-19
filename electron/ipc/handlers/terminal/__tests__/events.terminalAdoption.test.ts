import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const releaseTerminalAdoption = vi.hoisted(() => vi.fn());
const serviceRef = vi.hoisted(() => ({
  current: null as { releaseTerminalAdoption: typeof releaseTerminalAdoption } | null,
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

// A hand-over is of one running process (#12490): the terminal exiting, or a
// new process taking its id, ends it on the terminal's side. The orchestrator's
// side ends with its bearer, which the pane-config revocation covers.
describe("terminal event handlers — terminal hand-over (#12490)", () => {
  let dispose: () => void;
  let ptyClient: EventEmitter;

  beforeEach(() => {
    releaseTerminalAdoption.mockReset();
    serviceRef.current = { releaseTerminalAdoption };
    ptyClient = Object.assign(new EventEmitter(), { getTerminalProjectId: vi.fn() });
    dispose = registerTerminalEventHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
  });

  it("ends a hand-over when the terminal exits", () => {
    ptyClient.emit("exit", "t1", 0);

    expect(releaseTerminalAdoption).toHaveBeenCalledWith("t1");
  });

  it("ends it when a new process is confirmed under the id, and not when a spawn is refused", () => {
    ptyClient.emit("spawn-result", "t1", { success: true, id: "t1", launchGeneration: 4 });
    ptyClient.emit("spawn-result", "t2", {
      success: false,
      id: "t2",
      launchGeneration: 2,
      error: { code: "TERMINAL_ALREADY_LIVE", message: "still running" },
    });

    expect(releaseTerminalAdoption.mock.calls).toEqual([["t1"]]);
  });

  it("does nothing before the MCP server has ever loaded", () => {
    serviceRef.current = null;

    expect(() => ptyClient.emit("exit", "t1", 0)).not.toThrow();
  });
});
