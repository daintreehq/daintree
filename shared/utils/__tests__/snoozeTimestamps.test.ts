import { describe, expect, it } from "vitest";
import { resolveSnoozeDuration, SNOOZE_LABEL } from "../snoozeTimestamps.js";

describe("resolveSnoozeDuration", () => {
  it("'1h' adds one hour", () => {
    const now = new Date(2026, 4, 27, 14, 30, 0, 0);
    const target = new Date(resolveSnoozeDuration("1h", now));
    expect(target.getHours()).toBe(15);
    expect(target.getMinutes()).toBe(30);
    expect(target.getDate()).toBe(27);
  });

  it("'4h' adds four hours", () => {
    const now = new Date(2026, 4, 27, 10, 0, 0, 0);
    const target = new Date(resolveSnoozeDuration("4h", now));
    expect(target.getHours()).toBe(14);
    expect(target.getDate()).toBe(27);
  });

  it("'4h' rolls into the next day when invoked late in the evening", () => {
    const now = new Date(2026, 4, 27, 22, 0, 0, 0);
    const target = new Date(resolveSnoozeDuration("4h", now));
    expect(target.getHours()).toBe(2);
    expect(target.getDate()).toBe(28);
  });

  it("'tomorrow-8am' resolves to tomorrow at 8am local", () => {
    const now = new Date(2026, 4, 27, 14, 30, 45, 123); // Wed 14:30:45
    const target = new Date(resolveSnoozeDuration("tomorrow-8am", now));
    expect(target.getDate()).toBe(28);
    expect(target.getHours()).toBe(8);
    expect(target.getMinutes()).toBe(0);
    expect(target.getSeconds()).toBe(0);
    expect(target.getMilliseconds()).toBe(0);
  });

  it("'tomorrow-8am' resolves to tomorrow even when invoked before 8am today", () => {
    const now = new Date(2026, 4, 27, 6, 0, 0, 0); // Wed 06:00
    const target = new Date(resolveSnoozeDuration("tomorrow-8am", now));
    expect(target.getDate()).toBe(28);
    expect(target.getHours()).toBe(8);
  });

  it("'tomorrow-8am' rolls across month boundary", () => {
    const now = new Date(2026, 4, 31, 23, 0, 0, 0); // May 31, 23:00
    const target = new Date(resolveSnoozeDuration("tomorrow-8am", now));
    expect(target.getMonth()).toBe(5); // June
    expect(target.getDate()).toBe(1);
    expect(target.getHours()).toBe(8);
  });

  it("'next-monday-8am' resolves to next Monday 8am when invoked on a Wednesday", () => {
    const now = new Date(2026, 4, 27, 10, 0, 0, 0); // Wed 2026-05-27
    const target = new Date(resolveSnoozeDuration("next-monday-8am", now));
    expect(target.getDay()).toBe(1); // Monday
    expect(target.getDate()).toBe(1); // June 1
    expect(target.getMonth()).toBe(5);
    expect(target.getHours()).toBe(8);
  });

  it("'next-monday-8am' rolls a full week when invoked on a Monday", () => {
    const now = new Date(2026, 5, 1, 10, 0, 0, 0); // Mon 2026-06-01
    const target = new Date(resolveSnoozeDuration("next-monday-8am", now));
    expect(target.getDay()).toBe(1);
    expect(target.getDate()).toBe(8); // June 8 — full week out, never the same day
  });

  it("'next-monday-8am' resolves to the following Monday when invoked on Sunday", () => {
    const now = new Date(2026, 4, 31, 14, 0, 0, 0); // Sun 2026-05-31
    const target = new Date(resolveSnoozeDuration("next-monday-8am", now));
    expect(target.getDay()).toBe(1);
    expect(target.getDate()).toBe(1); // June 1 — tomorrow
  });

  it("returns a strictly future timestamp for every option", () => {
    const now = new Date(2026, 4, 27, 14, 30, 0, 0);
    for (const option of ["1h", "4h", "tomorrow-8am", "next-monday-8am"] as const) {
      expect(resolveSnoozeDuration(option, now)).toBeGreaterThan(now.getTime());
    }
  });
});

describe("SNOOZE_LABEL", () => {
  it("covers every option in the ladder", () => {
    for (const option of ["1h", "4h", "tomorrow-8am", "next-monday-8am"] as const) {
      expect(SNOOZE_LABEL[option]).toBeTruthy();
    }
  });
});
