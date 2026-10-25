import { describe, expect, it } from "vitest";
import {
  ASSISTANT_SEND_GATE,
  evaluateWakeGate,
  type WakeGateSnapshot,
} from "../terminalWakeGate.js";

const AT_PROMPT: WakeGateSnapshot = {
  agentState: "waiting",
  waitingReason: "prompt",
  lastStateChange: 1_000,
  detectedAgentId: "claude",
  hasPty: true,
};

describe("evaluateWakeGate (#12491)", () => {
  it("admits an agent waiting at a prompt with nothing typed since", () => {
    expect(evaluateWakeGate(AT_PROMPT)).toEqual({ kind: "ready" });
    expect(evaluateWakeGate({ ...AT_PROMPT, lastTypedInputAt: 999 })).toEqual({ kind: "ready" });
  });

  it("holds while the agent works", () => {
    expect(evaluateWakeGate({ ...AT_PROMPT, agentState: "working" })).toEqual({
      kind: "hold",
      reason: "working",
    });
  });

  it("holds while the composer may hold typing, however long ago it was", () => {
    expect(evaluateWakeGate({ ...AT_PROMPT, lastTypedInputAt: 1_000 })).toEqual({
      kind: "hold",
      reason: "typing",
    });
  });

  it.each(["approval", "question", "error"] as const)("blocks at %s", (reason) => {
    expect(evaluateWakeGate({ ...AT_PROMPT, waitingReason: reason })).toEqual({
      kind: "blocked",
      reason,
    });
  });

  it.each<[string, Partial<WakeGateSnapshot>]>([
    ["idle, which may be a bare shell", { agentState: "idle" }],
    ["completed", { agentState: "completed" }],
    ["exited", { agentState: "exited" }],
    ["waiting with no classified reason", { waitingReason: undefined }],
    ["waiting with no settle time", { lastStateChange: undefined }],
    ["with no state reading at all", { agentState: undefined }],
  ])("fails closed when the agent is %s", (_label, patch) => {
    expect(evaluateWakeGate({ ...AT_PROMPT, ...patch })).toEqual({
      kind: "blocked",
      reason: "not-at-prompt",
    });
  });

  it.each<[string, Partial<WakeGateSnapshot>]>([
    ["no agent detected", { detectedAgentId: undefined }],
    ["an exited process", { isExited: true }],
    ["no pty", { hasPty: false }],
    ["a pane closed to the trash", { isTrashed: true }],
  ])("blocks with %s", (_label, patch) => {
    expect(evaluateWakeGate({ ...AT_PROMPT, ...patch })).toEqual({
      kind: "blocked",
      reason: "no-agent",
    });
  });

  describe("acceptQuestion (#14475)", () => {
    const AT_QUESTION: WakeGateSnapshot = { ...AT_PROMPT, waitingReason: "question" };

    it("admits a question asked in prose as the agent's prompt", () => {
      expect(evaluateWakeGate(AT_QUESTION, { acceptQuestion: true })).toEqual({ kind: "ready" });
      expect(evaluateWakeGate(AT_QUESTION, ASSISTANT_SEND_GATE)).toEqual({ kind: "ready" });
    });

    it("still holds a draft typed since the question settled", () => {
      expect(
        evaluateWakeGate({ ...AT_QUESTION, lastTypedInputAt: 1_000 }, ASSISTANT_SEND_GATE)
      ).toEqual({ kind: "hold", reason: "typing" });
    });

    it("still fails closed on a question with no settle time", () => {
      expect(
        evaluateWakeGate({ ...AT_QUESTION, lastStateChange: undefined }, ASSISTANT_SEND_GATE)
      ).toEqual({ kind: "blocked", reason: "not-at-prompt" });
    });

    it.each(["approval", "error"] as const)("still blocks at %s", (reason) => {
      expect(
        evaluateWakeGate({ ...AT_PROMPT, waitingReason: reason }, ASSISTANT_SEND_GATE)
      ).toEqual({ kind: "blocked", reason });
    });

    it("never takes a turn in progress", () => {
      expect(
        evaluateWakeGate({ ...AT_QUESTION, agentState: "working" }, ASSISTANT_SEND_GATE)
      ).toEqual({ kind: "hold", reason: "working" });
    });
  });
});
