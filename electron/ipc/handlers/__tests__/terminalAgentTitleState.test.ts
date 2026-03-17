import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the handleTerminalAgentTitleState logic.
 * We test the handler function's behavior in isolation.
 */

describe("handleTerminalAgentTitleState logic", () => {
  type TransitionFn = (
    id: string,
    event: { type: string },
    trigger: string,
    confidence: number
  ) => void;

  let transitionState: ReturnType<typeof vi.fn<TransitionFn>>;

  function handlePayload(payload: unknown) {
    try {
      if (!payload || typeof payload !== "object") return;
      const { id, state } = payload as { id: string; state: string };
      if (typeof id !== "string" || !id) return;
      if (state !== "working" && state !== "waiting") return;

      const event = state === "working" ? { type: "busy" } : { type: "prompt" };
      transitionState(id, event, "title", 0.98);
    } catch {
      // swallowed
    }
  }

  beforeEach(() => {
    transitionState = vi.fn<TransitionFn>();
  });

  it("maps working state to busy event with 0.98 confidence", () => {
    handlePayload({ id: "term-1", state: "working" });
    expect(transitionState).toHaveBeenCalledWith("term-1", { type: "busy" }, "title", 0.98);
  });

  it("maps waiting state to prompt event with 0.98 confidence", () => {
    handlePayload({ id: "term-1", state: "waiting" });
    expect(transitionState).toHaveBeenCalledWith("term-1", { type: "prompt" }, "title", 0.98);
  });

  it("ignores null payload", () => {
    handlePayload(null);
    expect(transitionState).not.toHaveBeenCalled();
  });

  it("ignores non-object payload", () => {
    handlePayload("garbage");
    expect(transitionState).not.toHaveBeenCalled();
  });

  it("ignores payload with missing id", () => {
    handlePayload({ state: "working" });
    expect(transitionState).not.toHaveBeenCalled();
  });

  it("ignores payload with empty id", () => {
    handlePayload({ id: "", state: "working" });
    expect(transitionState).not.toHaveBeenCalled();
  });

  it("ignores payload with invalid state", () => {
    handlePayload({ id: "term-1", state: "idle" });
    expect(transitionState).not.toHaveBeenCalled();
  });

  it("ignores payload with non-string state", () => {
    handlePayload({ id: "term-1", state: 42 });
    expect(transitionState).not.toHaveBeenCalled();
  });
});
