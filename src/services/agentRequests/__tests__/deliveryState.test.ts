import { describe, expect, it } from "vitest";
import { deliveryFromPhase, launchReadiness, promptReadiness } from "../deliveryState";

describe("deliveryFromPhase", () => {
  it("claims sent only once the whole prompt reached the pty", () => {
    expect(deliveryFromPhase("pty_written")).toEqual({ status: "sent" });
    expect(deliveryFromPhase("queued")).toBeNull();
    expect(deliveryFromPhase("writing")).toBeNull();
    expect(deliveryFromPhase("unknown")).toEqual({ status: "unconfirmed" });
    expect(deliveryFromPhase("failed")?.status).toBe("failed");
    expect(deliveryFromPhase("cancelled")?.status).toBe("failed");
  });

  it("marks an outcome that may have half-written the prompt as partial", () => {
    expect(deliveryFromPhase("failed")).toMatchObject({ partial: true });
    expect(deliveryFromPhase("cancelled")).toMatchObject({ partial: true });
    expect(deliveryFromPhase("unknown")).not.toHaveProperty("partial");
  });
});

describe("launchReadiness", () => {
  it("types a request only into an agent waiting at its own prompt", () => {
    expect(launchReadiness("waiting", "prompt")).toBe("ready");
    expect(launchReadiness("idle", undefined)).toBe("ready");
    // A trust or approval question is also "waiting"; typing would answer it.
    expect(launchReadiness("waiting", "question")).toBe("needs-you");
    expect(launchReadiness("waiting", "approval")).toBe("needs-you");
    expect(launchReadiness("waiting", "error")).toBe("needs-you");
    expect(launchReadiness("working", undefined)).toBe("not-yet");
    expect(launchReadiness(null, undefined)).toBe("not-yet");
  });
});

describe("promptReadiness", () => {
  it("takes only an agent settled at its own prompt", () => {
    expect(
      promptReadiness({ agentState: "waiting", waitingReason: "prompt", lastTransitionAt: 1 })
    ).toBe("ready");
    // Idle is the pane before its agent drew anything: the shell takes the line.
    expect(promptReadiness({ agentState: "idle", lastTransitionAt: 1 })).toBe("not-yet");
    expect(promptReadiness({ agentState: "waiting", lastTransitionAt: 1 })).toBe("not-yet");
    expect(promptReadiness({ agentState: "waiting", waitingReason: "prompt" })).toBe("not-yet");
    // A reason left over from the last wait says nothing once the agent moved on.
    expect(
      promptReadiness({ agentState: "working", waitingReason: "prompt", lastTransitionAt: 1 })
    ).toBe("not-yet");
    expect(
      promptReadiness({ agentState: "idle", waitingReason: "prompt", lastTransitionAt: 1 })
    ).toBe("not-yet");
    expect(promptReadiness({ agentState: null })).toBe("not-yet");
  });

  it("leaves a question, approval or error to the person", () => {
    for (const waitingReason of ["question", "approval", "error"]) {
      expect(promptReadiness({ agentState: "waiting", waitingReason, lastTransitionAt: 1 })).toBe(
        "needs-you"
      );
    }
  });
});
