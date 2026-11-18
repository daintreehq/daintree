import { describe, expect, it } from "vitest";
import {
  UNDATED_CLAUDE_USAGE_TTL_MS,
  isCurrentClaudeUsageReading,
  parseClaudeUsageDocument,
  serializeClaudeUsageDocument,
  type SavedClaudeUsageReading,
} from "../claudeUsageDocument.js";

const NOW = 1_800_000_000_000;

const saved = (overrides: Partial<SavedClaudeUsageReading>): SavedClaudeUsageReading => ({
  window: "weekly limit",
  statement: "reached",
  usedPercent: null,
  resetsAt: NOW + 60_000,
  terminalId: "t1",
  observedAt: NOW - 60_000,
  identity: "/home/me/.claude",
  ...overrides,
});

const document = (readings: unknown[], version: unknown = 1) =>
  JSON.stringify({ version, readings });

describe("claudeUsageDocument (#17610)", () => {
  it("reads back what it saved, and nothing but the reading's own fields", () => {
    const reading = saved({ usedPercent: 92, statement: "used", identity: null });
    const value = serializeClaudeUsageDocument([
      { ...reading, configDir: "/somewhere", shell: "/bin/zsh" } as SavedClaudeUsageReading,
    ]);

    expect(value).not.toContain("/somewhere");
    expect(value).not.toContain("/bin/zsh");
    expect(parseClaudeUsageDocument(value, NOW)).toEqual([reading]);
  });

  it("drops a reading at load once its reset has come", () => {
    const value = serializeClaudeUsageDocument([
      saved({ terminalId: "due", resetsAt: NOW }),
      saved({ terminalId: "ahead", resetsAt: NOW + 1 }),
    ]);

    expect(parseClaudeUsageDocument(value, NOW).map((reading) => reading.terminalId)).toEqual([
      "ahead",
    ]);
  });

  it("keeps a reading that named no reset for a week from when it showed", () => {
    const value = serializeClaudeUsageDocument([
      saved({
        terminalId: "week-old",
        resetsAt: null,
        observedAt: NOW - UNDATED_CLAUDE_USAGE_TTL_MS,
      }),
      saved({
        terminalId: "just-inside",
        resetsAt: null,
        observedAt: NOW - UNDATED_CLAUDE_USAGE_TTL_MS + 1,
      }),
    ]);

    expect(parseClaudeUsageDocument(value, NOW).map((reading) => reading.terminalId)).toEqual([
      "just-inside",
    ]);
  });

  it("drops a reading dated after now, which only a clock set back produces", () => {
    const value = serializeClaudeUsageDocument([
      saved({ terminalId: "later", observedAt: NOW + 1 }),
      saved({ terminalId: "now", observedAt: NOW }),
    ]);

    expect(parseClaudeUsageDocument(value, NOW).map((reading) => reading.terminalId)).toEqual([
      "now",
    ]);
  });

  it("skips a malformed entry and keeps the rest", () => {
    const good = saved({});
    const value = document([
      { ...good, window: "fortnightly limit" },
      { ...good, statement: "nearly" },
      { ...good, usedPercent: "92" },
      { ...good, resetsAt: Number.NaN },
      { ...good, terminalId: 7 },
      { ...good, observedAt: null },
      { ...good, identity: "" },
      { ...good, identity: 3 },
      null,
      "reading",
      good,
    ]);

    expect(parseClaudeUsageDocument(value, NOW)).toEqual([good]);
  });

  it("reads nothing from no document, an unreadable one, or another version's", () => {
    expect(parseClaudeUsageDocument(null, NOW)).toEqual([]);
    expect(parseClaudeUsageDocument("{not json", NOW)).toEqual([]);
    expect(parseClaudeUsageDocument("null", NOW)).toEqual([]);
    expect(parseClaudeUsageDocument(JSON.stringify({ version: 1 }), NOW)).toEqual([]);
    expect(parseClaudeUsageDocument(document([saved({})], 2), NOW)).toEqual([]);
  });

  it("treats a passed reset as current while the app runs, and an undated reading for a week", () => {
    expect(isCurrentClaudeUsageReading({ resetsAt: NOW - 1, observedAt: 0 }, NOW)).toBe(true);
    expect(
      isCurrentClaudeUsageReading(
        { resetsAt: null, observedAt: NOW - UNDATED_CLAUDE_USAGE_TTL_MS + 1 },
        NOW
      )
    ).toBe(true);
    expect(
      isCurrentClaudeUsageReading(
        { resetsAt: null, observedAt: NOW - UNDATED_CLAUDE_USAGE_TTL_MS },
        NOW
      )
    ).toBe(false);
  });
});
