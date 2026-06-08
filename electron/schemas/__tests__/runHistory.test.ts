import { describe, expect, it } from "vitest";
import { RunHistoryAppendInputSchema } from "../runHistory.js";

describe("RunHistoryAppendInputSchema", () => {
  it("accepts a well-formed recipe payload", () => {
    const result = RunHistoryAppendInputSchema.safeParse({
      kind: "recipe",
      recipeName: "Build",
      totalTerminals: 2,
      spawned: [{ index: 0, terminalId: "t1", title: "Claude" }],
      failed: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a well-formed fleet payload", () => {
    const result = RunHistoryAppendInputSchema.safeParse({
      kind: "fleet",
      targetCount: 2,
      successCount: 2,
      failureCount: 0,
      cancelled: false,
      perTarget: [{ terminalId: "t1", status: "fulfilled" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const result = RunHistoryAppendInputSchema.safeParse({ kind: "bogus" });
    expect(result.success).toBe(false);
  });

  it("rejects a recipe payload missing required fields", () => {
    const result = RunHistoryAppendInputSchema.safeParse({ kind: "recipe" });
    expect(result.success).toBe(false);
  });

  it("rejects a fleet payload with a wrong-typed count", () => {
    const result = RunHistoryAppendInputSchema.safeParse({
      kind: "fleet",
      targetCount: "two",
      successCount: 2,
      failureCount: 0,
      cancelled: false,
      perTarget: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid per-target status", () => {
    const result = RunHistoryAppendInputSchema.safeParse({
      kind: "fleet",
      targetCount: 1,
      successCount: 0,
      failureCount: 1,
      cancelled: false,
      perTarget: [{ terminalId: "t1", status: "exploded" }],
    });
    expect(result.success).toBe(false);
  });
});
