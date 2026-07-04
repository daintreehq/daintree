import { describe, it, expect } from "vitest";
import type { WaitingReason } from "../../types/agent.js";
import { coerceWaitingReason } from "../../types/agent.js";
import {
  actionableWaitingReason,
  compareWaitingAttention,
  describeWaiting,
  describeWaitingMany,
  waitingAttentionRank,
  waitingHeadline,
} from "../waitingReasonDisplay.js";

const ALL_REASONS: WaitingReason[] = ["prompt", "question", "approval", "error"];

describe("actionableWaitingReason", () => {
  it("passes through classifier-backed reasons and rejects the weak fallback", () => {
    expect(actionableWaitingReason("approval")).toBe("approval");
    expect(actionableWaitingReason("question")).toBe("question");
    expect(actionableWaitingReason("error")).toBe("error");
    expect(actionableWaitingReason("prompt")).toBeNull();
    expect(actionableWaitingReason(undefined)).toBeNull();
  });
});

describe("describeWaiting / waitingHeadline", () => {
  it("collapses prompt and undefined to the same generic phrasing (no overclaiming)", () => {
    expect(describeWaiting("Claude", "prompt")).toBe(describeWaiting("Claude", undefined));
    expect(waitingHeadline("prompt")).toBe(waitingHeadline(undefined));
  });

  it("gives each actionable reason a distinct phrasing that names the subject", () => {
    const sentences = ALL_REASONS.map((r) => describeWaiting("Claude", r));
    expect(new Set(sentences).size).toBe(ALL_REASONS.length);
    for (const sentence of sentences) {
      expect(sentence).toContain("Claude");
    }
  });

  it("gives each actionable reason a distinct headline", () => {
    const headlines = ALL_REASONS.map((r) => waitingHeadline(r));
    expect(new Set(headlines).size).toBe(ALL_REASONS.length);
  });

  it("keeps plural bodies distinct per reason and collapses prompt/undefined", () => {
    const bodies = ALL_REASONS.map((r) => describeWaitingMany(3, r));
    expect(new Set(bodies).size).toBe(ALL_REASONS.length);
    expect(describeWaitingMany(3, "prompt")).toBe(describeWaitingMany(3, undefined));
    for (const body of bodies) {
      expect(body).toContain("3 agents");
    }
  });
});

describe("waitingAttentionRank", () => {
  it("orders approval before error before question before the prompt fallback", () => {
    expect(waitingAttentionRank("approval")).toBeLessThan(waitingAttentionRank("error"));
    expect(waitingAttentionRank("error")).toBeLessThan(waitingAttentionRank("question"));
    expect(waitingAttentionRank("question")).toBeLessThan(waitingAttentionRank("prompt"));
  });

  it("treats a missing reason like the prompt fallback", () => {
    expect(waitingAttentionRank(undefined)).toBe(waitingAttentionRank("prompt"));
  });
});

describe("compareWaitingAttention", () => {
  it("sorts by reason rank first regardless of wait duration", () => {
    const prompt = { id: "a", waitingReason: "prompt" as const, lastStateChange: 1 };
    const approval = { id: "b", waitingReason: "approval" as const, lastStateChange: 999 };
    expect([prompt, approval].sort(compareWaitingAttention).map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("breaks reason ties by longest wait first", () => {
    const newer = { id: "a", waitingReason: "approval" as const, lastStateChange: 200 };
    const older = { id: "b", waitingReason: "approval" as const, lastStateChange: 100 };
    expect([newer, older].sort(compareWaitingAttention).map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("sorts entries without a timestamp after timestamped peers and tie-breaks by id", () => {
    const stamped = { id: "z", waitingReason: "question" as const, lastStateChange: 5 };
    const unstampedB = { id: "b", waitingReason: "question" as const };
    const unstampedA = { id: "a", waitingReason: "question" as const };
    const sorted = [unstampedB, stamped, unstampedA].sort(compareWaitingAttention);
    expect(sorted.map((t) => t.id)).toEqual(["z", "a", "b"]);
  });

  it("is deterministic for identical inputs (comparator returns 0 only on same id)", () => {
    const a = { id: "same", waitingReason: "error" as const, lastStateChange: 10 };
    expect(compareWaitingAttention(a, { ...a })).toBe(0);
  });
});

describe("coerceWaitingReason", () => {
  it("accepts only canonical reasons off the wire", () => {
    for (const reason of ALL_REASONS) {
      expect(coerceWaitingReason(reason)).toBe(reason);
    }
    expect(coerceWaitingReason("permission")).toBeUndefined();
    expect(coerceWaitingReason("")).toBeUndefined();
    expect(coerceWaitingReason(42)).toBeUndefined();
    expect(coerceWaitingReason(null)).toBeUndefined();
    expect(coerceWaitingReason(undefined)).toBeUndefined();
  });
});
