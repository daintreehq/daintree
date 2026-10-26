import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  VoiceSessionReportSchema,
  VoiceSessionSummarySchema,
  type VoiceSessionReport,
  type VoiceSessionSummary,
} from "../voiceSessionSummary.js";

type Def = { type: string; innerType?: z.ZodType };

function leafType(field: z.ZodType): string {
  let def = field._zod.def as Def;
  while ((def.type === "nullable" || def.type === "optional") && def.innerType) {
    def = def.innerType._zod.def as Def;
  }
  return def.type;
}

const report: VoiceSessionReport = {
  provider: "openai",
  delayTier: "low",
  biasTermCount: 12,
  droppedPreStart: 0,
  droppedConnect: 0,
  droppedReplay: 0,
  reconnects: 1,
  completedSegments: 3,
  emptyCompletions: 1,
};

const summary: VoiceSessionSummary = {
  ...report,
  origin: "key",
  stopReason: "user",
  backendEnd: "stopped",
  cueMs: 14,
  micLiveMs: 240,
  socketReadyMs: 1_600,
  firstTextMs: 2_100,
  stopRequestedMs: 6_000,
  stopSettledMs: 700,
  correctionMs: null,
  correction: "none",
  droppedQueued: 0,
  charsCommitted: 42,
  audioNoText: false,
};

describe("voice session summary schema", () => {
  it.each([
    ["summary", VoiceSessionSummarySchema],
    ["report", VoiceSessionReportSchema],
  ])("%s holds only numbers, enums and flags", (_name, schema) => {
    for (const [field, type] of Object.entries(schema.shape)) {
      expect([field, leafType(type)]).toEqual([
        field,
        expect.stringMatching(/^(number|enum|boolean)$/),
      ]);
    }
  });

  it("rejects a field it does not declare", () => {
    expect(VoiceSessionSummarySchema.safeParse({ ...summary, panelTitle: "Claude" }).success).toBe(
      false
    );
    expect(VoiceSessionReportSchema.safeParse({ ...report, keyterms: ["daintree"] }).success).toBe(
      false
    );
  });

  it("rejects text where a number or enum belongs", () => {
    expect(VoiceSessionSummarySchema.safeParse({ ...summary, cueMs: "fix the bug" }).success).toBe(
      false
    );
    expect(
      VoiceSessionSummarySchema.safeParse({ ...summary, stopReason: "fix the bug" }).success
    ).toBe(false);
    expect(VoiceSessionReportSchema.safeParse({ ...report, provider: "Claude" }).success).toBe(
      false
    );
  });

  it("accepts a real summary and a report", () => {
    expect(VoiceSessionSummarySchema.parse(summary)).toEqual(summary);
    expect(VoiceSessionReportSchema.parse(report)).toEqual(report);
  });

  it("names no field the main logger would blank", () => {
    // electron/utils/logger.ts redacts these names and anything containing them.
    for (const field of Object.keys(VoiceSessionSummarySchema.shape)) {
      expect(field.toLowerCase()).not.toMatch(/secret|token|password|key/);
      expect(field.toLowerCase()).not.toBe("session");
    }
  });
});
