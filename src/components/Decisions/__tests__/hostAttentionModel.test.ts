import { describe, expect, it } from "vitest";
import type { DecisionsHostAttentionResult } from "@shared/types/decisionsAttention";
import {
  hostActionFailureText,
  hostAttentionReadOf,
  hostHandledConfirmBody,
  hostWaitingText,
} from "../hostAttentionModel";

type Failure = Exclude<DecisionsHostAttentionResult, { result: "acted" }>;

describe("a Remote Host's stopped delivery, in words (#18031)", () => {
  it.each<Failure>([{ result: "unreachable", failure: "disconnected" }, { result: "off" }])(
    "says nothing changed only where nothing reached the Host's delivery: %o",
    (result) => {
      expect(hostActionFailureText(result, "Studio", 7)).toMatch(/nothing changed$/);
    }
  );

  it.each<Failure>([
    { result: "unreachable", failure: "outcome-unknown" },
    { result: "unreachable", failure: "unexpected-answer" },
    { result: "unreachable", failure: "failed" },
    { result: "not-running" },
    { result: "too-large" },
  ])("never says nothing changed when the Host's answer can't say: %o", (result) => {
    const text = hostActionFailureText(result, "Studio", 7);
    expect(text).toContain("what became of q-7, so it may or may not have changed");
    expect(text).not.toContain("nothing changed");
  });

  it("points an older Host at the update, and a question no Host lists at the Host", () => {
    expect(
      hostActionFailureText({ result: "unreachable", failure: "needs-update" }, "Studio", 7)
    ).toContain("Update Daintree on Studio");
    expect(hostActionFailureText({ result: "no-host" }, "Studio", 7)).toContain(
      "Studio no longer lists this question"
    );
  });

  it("reads an older or away Host as a note, and anything else it can't read as worth a retry", () => {
    expect(hostAttentionReadOf({ result: "read", item: null })).toEqual({ kind: "gone" });
    expect(hostAttentionReadOf({ result: "unreachable", failure: "needs-update" })).toEqual({
      kind: "unavailable",
      reason: "needs-update",
    });
    expect(hostAttentionReadOf({ result: "unreachable", failure: "disconnected" })).toEqual({
      kind: "unavailable",
      reason: "disconnected",
    });
    expect(hostAttentionReadOf({ result: "off" })).toEqual({
      kind: "unavailable",
      reason: "not-running",
    });
    for (const failure of ["outcome-unknown", "unexpected-answer", "failed"] as const) {
      expect(hostAttentionReadOf({ result: "unreachable", failure })).toEqual({ kind: "failed" });
    }
  });

  it("names what the controls act on, cut to a line", () => {
    const answer = {
      source: "human" as const,
      choices: ["Ship it"],
      text: "Go ahead\nnow.",
      correction: false,
      answeredAt: "2026-11-02T10:05:00.000Z",
    };
    const followUp = {
      messageId: "m-1",
      onComputer: false,
      status: "needs-attention" as const,
      reason: "pane_gone",
      text: "Also this.",
      unreadable: false,
      sentAt: "2026-11-02T10:06:00.000Z",
    };
    const none = { answer: null, answerUnavailable: null, notice: null, followUps: [] };

    expect(hostWaitingText({ ...none, answer }, "Studio")).toBe(
      "Waiting on Studio: the answer “Ship it · Go ahead now.”"
    );
    expect(
      hostWaitingText(
        { ...none, answer: { ...answer, correction: true }, followUps: [followUp, followUp] },
        "Studio"
      )
    ).toBe("Waiting on Studio: the corrected answer “Ship it · Go ahead now.” and 2 follow-ups");
    expect(
      hostWaitingText(
        {
          ...none,
          notice: {
            kind: "expired",
            revision: 1,
            deadline: null,
            delivery: "needs-attention",
            disposition: null,
          },
          followUps: [followUp],
        },
        "Studio"
      )
    ).toBe("Waiting on Studio: the timeout notice and 1 follow-up");
    const long = hostWaitingText({ ...none, answer: { ...answer, text: "x".repeat(500) } }, "S");
    expect(long?.endsWith("…”")).toBe(true);
    expect(long!.length).toBeLessThan(200);
    expect(hostWaitingText(none, "Studio")).toBeNull();
  });

  it("names every way of delivering it that marking it handled takes away", () => {
    expect(
      hostHandledConfirmBody("answer", "Studio", { copy: true, resume: true, reassign: true })
    ).toContain("Copy, Try resume and Choose destination on Studio go with it.");
    expect(
      hostHandledConfirmBody("answer", "Studio", { copy: false, resume: false, reassign: true })
    ).toContain("Choose destination on Studio goes with it.");
    expect(
      hostHandledConfirmBody("follow-ups", "Studio", {
        copy: false,
        resume: false,
        reassign: false,
      })
    ).not.toContain("go with");
  });
});
