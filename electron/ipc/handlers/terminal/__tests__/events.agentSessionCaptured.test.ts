import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const { acceptCapturedAgentSession, releaseSupersededCapturedSession } = vi.hoisted(() => ({
  acceptCapturedAgentSession: vi.fn(),
  releaseSupersededCapturedSession: vi.fn(),
}));

vi.mock("../../../utils.js", () => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
}));
vi.mock("../../../../services/McpPaneConfigService.js", () => ({
  mcpPaneConfigService: { revokePaneConfig: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../../../services/pty/agentSessionCapturePersistence.js", () => ({
  acceptCapturedAgentSession,
  releaseSupersededCapturedSession,
}));

import { events, type DaintreeEventMap } from "../../../../services/events.js";
import { registerTerminalEventHandlers } from "../events.js";
import type { HandlerDependencies } from "../../../types.js";

function captured(): DaintreeEventMap["agent-session:captured"] {
  return {
    terminalId: "t1",
    launchGeneration: 2,
    boundary: "exit",
    record: {
      sessionId: "synthetic-session",
      agentId: "codex",
      worktreeId: null,
      title: null,
      projectId: "p1",
    },
  };
}

describe("terminal event handlers — captured agent sessions (#12433)", () => {
  let dispose: () => void;
  let ptyClient: EventEmitter;

  beforeEach(() => {
    acceptCapturedAgentSession.mockReset();
    releaseSupersededCapturedSession.mockReset();
    ptyClient = Object.assign(new EventEmitter(), { getTerminalProjectId: vi.fn() });
    dispose = registerTerminalEventHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
  });

  it("hands each capture to persistence before the emit returns", () => {
    const payload = captured();

    events.emit("agent-session:captured", payload);

    // Synchronous acceptance is what lets a quit's drain see this write: a
    // hop through a microtask would leave a window where it is invisible.
    expect(acceptCapturedAgentSession).toHaveBeenCalledTimes(1);
    expect(acceptCapturedAgentSession).toHaveBeenCalledWith(payload);
  });

  it("offers only a confirmed spawn, with its generation, to the relaunch release", () => {
    ptyClient.emit("spawn-result", "t1", { success: true, id: "t1", launchGeneration: 4 });
    ptyClient.emit("spawn-result", "t2", {
      success: false,
      id: "t2",
      launchGeneration: 2,
      error: { code: "TERMINAL_ALREADY_LIVE", message: "still running" },
    });

    // A refused spawn leaves the previous process — and its id — in place.
    expect(releaseSupersededCapturedSession.mock.calls).toEqual([["t1", 4]]);
  });

  it("stops accepting once the handlers are disposed", () => {
    dispose();
    dispose = () => {};

    events.emit("agent-session:captured", captured());

    expect(acceptCapturedAgentSession).not.toHaveBeenCalled();
  });
});
