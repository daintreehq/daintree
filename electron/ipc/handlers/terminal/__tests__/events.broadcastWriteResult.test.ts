import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const { broadcastToRenderer, broadcastToProjectRenderers } = vi.hoisted(() => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
}));

vi.mock("../../../utils.js", () => ({ broadcastToRenderer, broadcastToProjectRenderers }));
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

import { CHANNELS } from "../../../channels.js";
import { registerTerminalEventHandlers } from "../events.js";
import type { HandlerDependencies } from "../../../types.js";

const PROJECTS: Record<string, string | null> = {
  a1: "project-a",
  a2: "project-a",
  b1: "project-b",
  gone: null,
};

describe("terminal event handlers — broadcast-write-result forwarding", () => {
  let ptyClient: EventEmitter & { getTerminalProjectId: (id: string) => string | null };
  let dispose: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ptyClient = Object.assign(new EventEmitter(), {
      getTerminalProjectId: (id: string) => PROJECTS[id] ?? null,
    });
    dispose = registerTerminalEventHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
  });

  it("sends the result to the owning project's views only", () => {
    const payload = {
      results: [
        { id: "a1", ok: false },
        { id: "a2", ok: true },
      ],
    };
    ptyClient.emit("broadcast-write-result", payload);

    expect(broadcastToProjectRenderers).toHaveBeenCalledTimes(1);
    expect(broadcastToProjectRenderers).toHaveBeenCalledWith(
      "project-a",
      CHANNELS.TERMINAL_BROADCAST_WRITE_RESULT,
      payload
    );
    expect(broadcastToRenderer).not.toHaveBeenCalled();
  });

  it("splits a mixed result into one payload per project", () => {
    ptyClient.emit("broadcast-write-result", {
      results: [
        { id: "a1", ok: false },
        { id: "b1", ok: false },
        { id: "a2", ok: true },
      ],
    });

    expect(broadcastToProjectRenderers.mock.calls).toEqual([
      [
        "project-a",
        CHANNELS.TERMINAL_BROADCAST_WRITE_RESULT,
        {
          results: [
            { id: "a1", ok: false },
            { id: "a2", ok: true },
          ],
        },
      ],
      [
        "project-b",
        CHANNELS.TERMINAL_BROADCAST_WRITE_RESULT,
        { results: [{ id: "b1", ok: false }] },
      ],
    ]);
    expect(broadcastToRenderer).not.toHaveBeenCalled();
  });

  it("sends only unattributable entries unscoped, keeping live targets in their project", () => {
    ptyClient.emit("broadcast-write-result", {
      results: [
        { id: "a1", ok: false },
        { id: "gone", ok: false },
      ],
    });

    expect(broadcastToProjectRenderers.mock.calls).toEqual([
      [
        "project-a",
        CHANNELS.TERMINAL_BROADCAST_WRITE_RESULT,
        { results: [{ id: "a1", ok: false }] },
      ],
      // A null project is the all-views fallback inside broadcastToProjectRenderers.
      [null, CHANNELS.TERMINAL_BROADCAST_WRITE_RESULT, { results: [{ id: "gone", ok: false }] }],
    ]);
  });

  it("sends nothing for an empty result", () => {
    ptyClient.emit("broadcast-write-result", { results: [] });
    expect(broadcastToProjectRenderers).not.toHaveBeenCalled();
    expect(broadcastToRenderer).not.toHaveBeenCalled();
  });
});
