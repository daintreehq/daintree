import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const { acceptCapturedAgentSession } = vi.hoisted(() => ({
  acceptCapturedAgentSession: vi.fn(),
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

  beforeEach(() => {
    acceptCapturedAgentSession.mockReset();
    const ptyClient = Object.assign(new EventEmitter(), { getTerminalProjectId: vi.fn() });
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

  it("stops accepting once the handlers are disposed", () => {
    dispose();
    dispose = () => {};

    events.emit("agent-session:captured", captured());

    expect(acceptCapturedAgentSession).not.toHaveBeenCalled();
  });
});
