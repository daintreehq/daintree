import { describe, expect, it } from "vitest";
import {
  ASSISTANT_SEND_GATE,
  EXACT_PROMPT_GATE,
  decisionGateOptionsFor,
  evaluateWakeGate,
  isAtChoiceDialog,
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
    ["a pane whose agent is being quit", { isClosing: true }],
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

describe("decisionGateOptionsFor (#16282)", () => {
  const WORKING: WakeGateSnapshot = { ...AT_PROMPT, agentState: "working" };

  it("takes a CLI that queues input mid-turn, and any agent at a prose question", () => {
    expect(evaluateWakeGate(WORKING, decisionGateOptionsFor("claude"))).toEqual({ kind: "ready" });
    for (const agentId of ["claude", "gemini"]) {
      expect(
        evaluateWakeGate(
          { ...AT_PROMPT, detectedAgentId: agentId, waitingReason: "question" },
          decisionGateOptionsFor(agentId)
        )
      ).toEqual({ kind: "ready" });
    }
  });

  it("holds a CLI that can't queue input until its prompt", () => {
    expect(
      evaluateWakeGate({ ...WORKING, detectedAgentId: "gemini" }, decisionGateOptionsFor("gemini"))
    ).toEqual({ kind: "hold", reason: "working" });
  });

  it("holds on a draft in the hybrid input or the CLI's line, at the prompt and mid-turn", () => {
    const options = decisionGateOptionsFor("claude");
    for (const snapshot of [AT_PROMPT, WORKING]) {
      expect(evaluateWakeGate({ ...snapshot, hasComposerDraft: true }, options)).toEqual({
        kind: "hold",
        reason: "typing",
      });
      expect(evaluateWakeGate({ ...snapshot, lastTypedInputAt: 1_001 }, options)).toEqual({
        kind: "hold",
        reason: "typing",
      });
    }
  });

  it("still blocks at a selector or an error, whatever the composer holds", () => {
    const options = decisionGateOptionsFor("claude");
    for (const reason of ["approval", "error"] as const) {
      expect(
        evaluateWakeGate({ ...AT_PROMPT, waitingReason: reason, hasComposerDraft: true }, options)
      ).toEqual({ kind: "blocked", reason });
    }
  });

  it("leaves every other gate blind to the hybrid input", () => {
    const draft = { ...AT_PROMPT, hasComposerDraft: true };
    expect(evaluateWakeGate(draft)).toEqual({ kind: "ready" });
    expect(evaluateWakeGate(draft, ASSISTANT_SEND_GATE)).toEqual({ kind: "ready" });
    expect(evaluateWakeGate(draft, EXACT_PROMPT_GATE)).toEqual({ kind: "ready" });
  });
});

describe("isAtChoiceDialog (#16209)", () => {
  const AT_DIALOG: WakeGateSnapshot = { ...AT_PROMPT, waitingReason: "approval" };

  it("is true only for a live agent waiting on a choice", () => {
    expect(isAtChoiceDialog(AT_DIALOG)).toBe(true);
    expect(isAtChoiceDialog(AT_PROMPT)).toBe(false);
    expect(isAtChoiceDialog({ ...AT_PROMPT, waitingReason: "question" })).toBe(false);
    expect(isAtChoiceDialog({ ...AT_DIALOG, agentState: "working" })).toBe(false);
  });

  it("never holds a shell or a pane whose agent has gone", () => {
    expect(isAtChoiceDialog({ ...AT_DIALOG, detectedAgentId: undefined })).toBe(false);
    expect(isAtChoiceDialog({ ...AT_DIALOG, isExited: true })).toBe(false);
    expect(isAtChoiceDialog({ ...AT_DIALOG, hasPty: false })).toBe(false);
  });
});
