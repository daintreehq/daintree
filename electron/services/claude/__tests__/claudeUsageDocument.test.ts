import { describe, expect, it } from "vitest";
import {
  isCurrentClaudeUsageReading,
  parseClaudeUsageDocument,
  serializeClaudeUsageDocument,
  type SavedClaudeUsageReading,
} from "../claudeUsageDocument.js";

const NOW = 1_800_000_000_000;
const WEEK = 7 * 24 * 60 * 60 * 1000;

const saved = (overrides: Partial<SavedClaudeUsageReading>): SavedClaudeUsageReading => ({
  window: "weekly limit",
  statement: "reached",
  usedPercent: null,
  resetsAt: NOW + 60_000,
  terminalId: "t1",
  observedAt: NOW - 60_000,
  identity: "/home/me/.claude",
  configDir: "/home/me/.claude",
  ...overrides,
});

const document = (readings: unknown[], version: unknown = 1) =>
  JSON.stringify({ version, readings });

describe("claudeUsageDocument (#17610)", () => {
  it("reads back what it saved, and never the pane's shell", () => {
    const readings = [
      saved({ usedPercent: 92, statement: "used", identity: "/work", configDir: "/work" }),
      saved({ window: "5-hour limit", usedPercent: 0, identity: null, configDir: "/personal" }),
      saved({ window: "Opus limit", usedPercent: 100, identity: null, configDir: null }),
    ];
    const value = serializeClaudeUsageDocument(
      readings.map(
        (reading) =>
          ({ ...reading, shell: "/bin/zsh", paneTitle: "Fix login" }) as SavedClaudeUsageReading
      )
    );

    expect(value).not.toContain("/bin/zsh");
    expect(value).not.toContain("Fix login");
    expect(parseClaudeUsageDocument(value, NOW)).toEqual(readings);
  });

  it("drops a reading at load once its reset has come", () => {
    const value = serializeClaudeUsageDocument([
      saved({ terminalId: "past", resetsAt: NOW - 1 }),
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
        observedAt: NOW - WEEK,
      }),
      saved({
        terminalId: "just-inside",
        resetsAt: null,
        observedAt: NOW - WEEK + 1,
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
      { ...good, resetsAt: "soon" },
      { ...good, terminalId: 7 },
      { ...good, observedAt: null },
      { ...good, identity: "" },
      { ...good, identity: 3 },
      { ...good, configDir: "" },
      { ...good, configDir: undefined },
      // Placed under a folder the pane wasn't on, which no launch does.
      { ...good, configDir: "/somewhere-else" },
      { ...good, terminalId: "" },
      { ...good, usedPercent: 101 },
      { ...good, usedPercent: -1 },
      null,
      "reading",
      good,
    ]);

    expect(parseClaudeUsageDocument(value, NOW)).toEqual([good]);
  });

  it("skips a time JSON can only spell as out of range", () => {
    const value = `{"version":1,"readings":[${JSON.stringify(saved({})).replace(
      /"observedAt":\d+/,
      '"observedAt":-1e999'
    )}]}`;

    expect(value).toContain("-1e999");
    expect(parseClaudeUsageDocument(value, NOW)).toEqual([]);
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
    expect(isCurrentClaudeUsageReading({ resetsAt: null, observedAt: NOW - WEEK + 1 }, NOW)).toBe(
      true
    );
    expect(isCurrentClaudeUsageReading({ resetsAt: null, observedAt: NOW - WEEK }, NOW)).toBe(
      false
    );
  });
});
