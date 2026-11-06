import { afterEach, describe, expect, it, vi } from "vitest";
import { TypedEventBus } from "../events.js";

describe("TypedEventBus debug logging", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("withholds a payload that carries a session id, and prints the rest", () => {
    const sessionId = "0199f8c1-2b4d-7e3a-9f10-5c6d7e8f9a0b";
    vi.stubEnv("DAINTREE_DEBUG_EVENTS", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const bus = new TypedEventBus();

    bus.emit("agent-session:observed", {
      terminalId: "t1",
      agentId: "codex",
      projectId: "proj-1",
      sessionId,
      run: { launchGeneration: 1, agentIncarnation: 1 },
    });
    bus.emit("terminal:restored", { id: "t-restored" });

    const printed = JSON.stringify(log.mock.calls);
    expect(printed).toContain("agent-session:observed");
    expect(printed).not.toContain(sessionId);
    expect(printed).toContain("t-restored");
  });
});
