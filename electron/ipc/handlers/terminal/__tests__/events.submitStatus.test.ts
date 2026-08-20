import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type { TerminalSubmitStatusPayload } from "../../../../../shared/types/pty-host.js";

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

describe("terminal event handlers — submit-status forwarding (#11875)", () => {
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

  function submitEnvelopes() {
    return broadcastToProjectRenderers.mock.calls.filter(
      (call) => call[1] === CHANNELS.EVENTS_PUSH && call[2]?.name === "terminal:submit-status"
    );
  }

  it("forwards the payload as a single object, not positional args", () => {
    // The router emits one `{ id, state }` object. Both ends of this
    // EventEmitter hop are untyped, so a positional/object mismatch would
    // compile cleanly and deliver `undefined` to the renderer.
    const payload: TerminalSubmitStatusPayload = { id: "t1", state: "slow" };

    ptyClient.emit("submit-status", payload);

    const envelopes = submitEnvelopes();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.[2]).toEqual({
      name: "terminal:submit-status",
      payload: { id: "t1", state: "slow" },
    });
  });

  it("carries every state through unchanged", () => {
    for (const state of ["slow", "stalled", "settled", "failed"] as const) {
      ptyClient.emit("submit-status", { id: "t1", state });
    }

    expect(submitEnvelopes().map((call) => call[2].payload.state)).toEqual([
      "slow",
      "stalled",
      "settled",
      "failed",
    ]);
  });

  it("scopes to the owning project rather than fanning out to every view", () => {
    ptyClient.emit("submit-status", { id: "t1", state: "slow" });

    expect(ptyClient.getTerminalProjectId).toHaveBeenCalledWith("t1");
    expect(submitEnvelopes()[0]?.[0]).toBe("project-for-t1");
    expect(
      broadcastToRenderer.mock.calls.some((call) => call[1]?.name === "terminal:submit-status")
    ).toBe(false);
  });

  it("passes an unknown project through so the util can fall back to a full broadcast", () => {
    // A killed terminal drops its pendingSpawns entry, so the project can be
    // null exactly when a late `settled` arrives — the fallback is what stops
    // that clearing event being swallowed.
    ptyClient.getTerminalProjectId.mockReturnValue(null);

    ptyClient.emit("submit-status", { id: "t1", state: "settled" });

    expect(submitEnvelopes()[0]?.[0]).toBeNull();
  });

  it("stops forwarding once the handlers are disposed", () => {
    dispose();

    ptyClient.emit("submit-status", { id: "t1", state: "slow" });

    expect(submitEnvelopes()).toHaveLength(0);
    expect(ptyClient.listenerCount("submit-status")).toBe(0);
  });
});
