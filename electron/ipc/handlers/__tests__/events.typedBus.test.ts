import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentStateChangePayload } from "../../../../shared/types/ipc/agent.js";
import type { EventBusEnvelope } from "../../../../shared/types/ipc/maps.js";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

const utilsMock = vi.hoisted(() => ({
  typedHandle: vi.fn(() => () => {}),
  broadcastToRenderer: vi.fn(),
}));

vi.mock("../../utils.js", () => utilsMock);

import { registerEventsHandlers } from "../events.js";

type Listener = (payload: AgentStateChangePayload) => void;

function makeTypedEventBus() {
  const listeners = new Map<string, Set<Listener>>();
  const emit = vi.fn((name: string, payload: AgentStateChangePayload) => {
    for (const l of listeners.get(name) ?? []) l(payload);
  });
  const on = vi.fn((name: string, listener: Listener) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(listener);
    return () => listeners.get(name)?.delete(listener);
  });
  return { emit, on, listeners };
}

function samplePayload(overrides: Partial<AgentStateChangePayload> = {}): AgentStateChangePayload {
  return {
    terminalId: "term-1",
    state: "working",
    previousState: "idle",
    timestamp: 1_700_000_000_000,
    trigger: "heuristic",
    confidence: 1,
    ...overrides,
  };
}

describe("events IPC handler — typed event bus bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("subscribes to agent:state-changed and broadcasts an envelope on events:push", () => {
    const bus = makeTypedEventBus();
    const cleanup = registerEventsHandlers({
      events: bus,
    } as unknown as Parameters<typeof registerEventsHandlers>[0]);

    expect(bus.on).toHaveBeenCalledWith("agent:state-changed", expect.any(Function));

    const payload = samplePayload();
    bus.emit("agent:state-changed", payload);

    expect(utilsMock.broadcastToRenderer).toHaveBeenCalledTimes(1);
    const [channel, envelope] = utilsMock.broadcastToRenderer.mock.calls[0]!;
    expect(channel).toBe("events:push");
    expect(envelope).toEqual<EventBusEnvelope>({
      name: "agent:state-changed",
      payload,
    });

    cleanup();
  });

  it("unsubscribes from the bus on cleanup so later emits do not broadcast", () => {
    const bus = makeTypedEventBus();
    const cleanup = registerEventsHandlers({
      events: bus,
    } as unknown as Parameters<typeof registerEventsHandlers>[0]);

    cleanup();

    bus.emit("agent:state-changed", samplePayload());

    expect(utilsMock.broadcastToRenderer).not.toHaveBeenCalled();
  });

  it("does not wire the bridge when events bus is undefined", () => {
    const cleanup = registerEventsHandlers({
      events: undefined,
    } as unknown as Parameters<typeof registerEventsHandlers>[0]);

    expect(utilsMock.broadcastToRenderer).not.toHaveBeenCalled();
    cleanup();
  });
});
