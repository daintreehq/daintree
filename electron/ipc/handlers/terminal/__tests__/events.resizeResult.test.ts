import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type { TerminalResizeResult } from "../../../../../shared/types/pty-host.js";

const { broadcastToRenderer, broadcastToProjectRenderers } = vi.hoisted(() => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
}));

vi.mock("../../../utils.js", () => ({ broadcastToRenderer, broadcastToProjectRenderers }));
vi.mock("../../../../services/McpPaneConfigService.js", () => ({
  mcpPaneConfigService: { revokePaneConfig: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../../../services/pty/agentSessionJournal.js", () => ({
  journalAgentSession: vi.fn(),
}));
// The real bus's `on()` returns an unsubscribe function, which the handler
// pushes straight onto its cleanup list — a bare EventEmitter returns itself
// and the teardown then throws.
vi.mock("../../../../services/events.js", () => ({
  events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
}));

import { CHANNELS } from "../../../channels.js";
import { registerTerminalEventHandlers } from "../events.js";
import type { HandlerDependencies } from "../../../types.js";

function makeResult(overrides: Partial<TerminalResizeResult> = {}): TerminalResizeResult {
  return {
    launchGeneration: 3,
    requestedCols: 120,
    requestedRows: 40,
    appliedCols: 120,
    appliedRows: 40,
    outcome: "applied",
    ...overrides,
  };
}

describe("terminal event handlers — resize-result forwarding (#11641)", () => {
  let ptyClient: EventEmitter & { getTerminalProjectId: ReturnType<typeof vi.fn> };
  let dispose: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ptyClient = Object.assign(new EventEmitter(), {
      getTerminalProjectId: vi.fn((id: string) => `project-for-${id}`),
    });
    dispose = registerTerminalEventHandlers({
      ptyClient,
    } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
  });

  function resizeEnvelopes() {
    return broadcastToProjectRenderers.mock.calls.filter(
      (call) => call[1] === CHANNELS.EVENTS_PUSH && call[2]?.name === "terminal:resize-result"
    );
  }

  it("forwards a resize result as an events-push envelope carrying id and result", () => {
    const result = makeResult();

    ptyClient.emit("resize-result", "t1", result);

    const envelopes = resizeEnvelopes();
    expect(envelopes).toHaveLength(1);
    // The payload is a tuple the preload destructures as `([id, result])` —
    // an object payload here would silently deliver `undefined` to callers.
    expect(envelopes[0]?.[2]).toEqual({
      name: "terminal:resize-result",
      payload: ["t1", result],
    });
  });

  it("scopes the echo to the owning project instead of fanning out to every view", () => {
    ptyClient.emit("resize-result", "t1", makeResult());

    expect(ptyClient.getTerminalProjectId).toHaveBeenCalledWith("t1");
    expect(resizeEnvelopes()[0]?.[0]).toBe("project-for-t1");
    // Every non-owning view drops the echo in `recordPtyResizeResult` anyway, so
    // a global broadcast would be a structured clone + IPC task per unrelated view.
    expect(
      broadcastToRenderer.mock.calls.some((call) => call[1]?.name === "terminal:resize-result")
    ).toBe(false);
  });

  it("passes an unknown project through so the util can fall back to a full broadcast", () => {
    ptyClient.getTerminalProjectId.mockReturnValue(null);

    ptyClient.emit("resize-result", "t1", makeResult());

    expect(resizeEnvelopes()[0]?.[0]).toBeNull();
  });

  it("forwards a result with no confirmed geometry without inventing one", () => {
    ptyClient.emit(
      "resize-result",
      "t1",
      makeResult({ outcome: "deferred", appliedCols: null, appliedRows: null })
    );

    const payload = resizeEnvelopes()[0]?.[2]?.payload as [string, TerminalResizeResult];
    expect(payload[1].appliedCols).toBeNull();
    expect(payload[1].appliedRows).toBeNull();
  });

  it("stops forwarding once the handlers are disposed", () => {
    dispose();

    ptyClient.emit("resize-result", "t1", makeResult());

    expect(resizeEnvelopes()).toHaveLength(0);
    expect(ptyClient.listenerCount("resize-result")).toBe(0);
  });
});
