import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  VoiceCorrectionPassagesSchema,
  VoiceCorrectionTimingSchema,
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

// Every field, nested objects flattened to dotted paths.
function leaves(shape: Record<string, z.ZodType>, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, type] of Object.entries(shape)) {
    const kind = leafType(type);
    if (kind === "object") {
      Object.assign(out, leaves((type as z.ZodObject).shape, `${prefix}${field}.`));
    } else {
      out[`${prefix}${field}`] = kind;
    }
  }
  return out;
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
  correctionMs: 2_000,
  correctionPrepMs: 30,
  correctionRequestMs: 1_400,
  correctionApplyMs: 6,
  correction: "applied",
  correctionPassages: {
    sent: 1,
    applied: 1,
    unchanged: 0,
    skipped: 0,
    rejectedEditSize: 0,
    rejectedNegation: 0,
    rejectedNumber: 0,
    rejectedProtectedSpan: 0,
    rejectedCommand: 0,
    rejectedLowConfidence: 0,
    failed: 0,
    timedOut: 0,
    dropped: 0,
    unlanded: 0,
  },
  correctionChunks: 2,
  droppedQueued: 0,
  charsCommitted: 42,
  audioNoText: false,
};

describe("voice session summary schema", () => {
  it.each([
    ["summary", VoiceSessionSummarySchema],
    ["report", VoiceSessionReportSchema],
    ["correction timing", VoiceCorrectionTimingSchema],
    ["correction passages", VoiceCorrectionPassagesSchema],
  ])("%s holds only numbers, enums and flags", (_name, schema) => {
    for (const [field, type] of Object.entries(leaves(schema.shape))) {
      expect([field, type]).toEqual([field, expect.stringMatching(/^(number|enum|boolean)$/)]);
    }
  });

  it("leaves the passage counts as counts", () => {
    expect(
      VoiceCorrectionPassagesSchema.safeParse({ ...summary.correctionPassages, applied: "text" })
        .success
    ).toBe(false);
    expect(
      VoiceCorrectionPassagesSchema.safeParse({ ...summary.correctionPassages, rejected: "x" })
        .success
    ).toBe(false);
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

  it("takes main's correction timing as durations alone", () => {
    expect(VoiceCorrectionTimingSchema.safeParse({ prepMs: 12.5, requestMs: null }).success).toBe(
      true
    );
    for (const bad of [
      { prepMs: "fix the bug", requestMs: null },
      { prepMs: -1, requestMs: 900 },
      { prepMs: 3, requestMs: 900, prompt: "fix the bug" },
    ]) {
      expect(VoiceCorrectionTimingSchema.safeParse(bad).success).toBe(false);
    }
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
