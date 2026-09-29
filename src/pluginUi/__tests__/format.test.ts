import { describe, expect, it } from "vitest";
import * as kit from "@daintreehq/plugin-ui";
import { formatTimeAgo as hostTimeAgo } from "@/utils/timeAgo";
import { formatRelativeTime as hostRelativeTime } from "@/lib/formatRelativeTime";
import { formatBytes as hostBytes } from "@/lib/formatBytes";
import { formatCompactCount as hostCount } from "@/lib/formatCount";
import { formatElapsedDuration as hostDuration } from "@/utils/formatElapsedDuration";

// The kit's formatters delegate to the host's after normalising a plugin's
// input (see src/pluginUi/format.ts). These pin that the adapters change no
// label the host prints, and that the input they widen (ISO strings, Dates,
// junk from untyped JS) lands on the same labels or a safe fallback.
const NOW = new Date("2026-09-30T12:00:00Z").getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const AGES = [
  0,
  5 * SECOND,
  59 * SECOND,
  MINUTE,
  45 * MINUTE,
  HOUR,
  23 * HOUR,
  DAY,
  11 * DAY,
  29 * DAY,
  30 * DAY,
  45 * DAY,
  400 * DAY,
  -3 * HOUR,
  -2 * DAY,
];

describe("@daintreehq/plugin-ui formatters", () => {
  it("matches the host's formatTimeAgo", () => {
    for (const age of AGES) {
      expect(kit.formatTimeAgo(NOW - age, NOW)).toBe(hostTimeAgo(NOW - age, NOW));
      const iso = new Date(NOW - age).toISOString();
      expect(kit.formatTimeAgo(iso, NOW)).toBe(hostTimeAgo(iso, NOW));
    }
    expect(kit.formatTimeAgo("not a date", NOW)).toBe(hostTimeAgo("not a date", NOW));
    for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 9e15]) {
      expect(kit.formatTimeAgo(bad, NOW)).toBe(hostTimeAgo(bad, NOW));
      expect(kit.formatRelativeTime(bad, NOW)).toBe("Unknown");
    }
  });

  it("matches the host's formatRelativeTime, for ISO strings and Dates too", () => {
    for (const age of AGES) {
      const expected = hostRelativeTime(NOW - age, NOW);
      expect(kit.formatRelativeTime(NOW - age, NOW)).toBe(expected);
      expect(kit.formatRelativeTime(new Date(NOW - age).toISOString(), NOW)).toBe(expected);
      expect(kit.formatRelativeTime(new Date(NOW - age), NOW)).toBe(expected);
    }
    expect(kit.formatRelativeTime("not a date", NOW)).toBe("Unknown");
  });

  it("matches the host's formatBytes", () => {
    for (const bytes of [0, -1, 1, 512, 1023, 1024, 1536, 1048575, 1048576, 5.5e9, 3e12, 9e15]) {
      expect(kit.formatBytes(bytes)).toBe(hostBytes(bytes));
    }
  });

  it("matches the host's compact count", () => {
    for (const n of [0, 7, 999, 1000, 1299, 23_645, 99_999, 100_000, 1_234_567, 5e9, -5]) {
      expect(kit.formatCount(n)).toBe(hostCount(n));
    }
  });

  it("matches the host's elapsed duration", () => {
    for (const ms of [
      0,
      -5,
      999,
      1000,
      45_000,
      12 * MINUTE,
      3 * HOUR + 5 * MINUTE,
      2 * DAY + 4 * HOUR,
    ]) {
      expect(kit.formatDuration(ms)).toBe(hostDuration(ms));
    }
  });

  it("returns a safe string for junk from untyped JS instead of throwing", () => {
    // Parsed rather than typed: the shapes plain JavaScript sends.
    const loose: number[] = JSON.parse('[null, {}, [], "twelve"]');
    for (const value of [...loose, Number.NaN]) {
      expect(typeof kit.formatBytes(value)).toBe("string");
      expect(typeof kit.formatCount(value)).toBe("string");
      expect(typeof kit.formatDuration(value)).toBe("string");
      expect(kit.formatTimeAgo(value, NOW)).toBe("Unknown");
      expect(kit.formatRelativeTime(value, NOW)).toBe("Unknown");
    }
  });
});
