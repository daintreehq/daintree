import { afterEach, describe, expect, it, vi } from "vitest";
import { machineTimeZone } from "@shared/utils/cron";
import { formatRunInstant, formatRunParts } from "../runTime";

const HOUR = 3_600_000;
// 12:00 UTC on the last day of 2026: still 2026 in New York, nearly 2027 in Tokyo.
const NOW = Date.UTC(2026, 11, 31, 12);
// Eight hours later it is 2027 in Tokyo but not yet in New York.
const LATER = NOW + 8 * HOUR;

function otherZone(...candidates: string[]): string {
  return candidates.find((zone) => zone !== machineTimeZone())!;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatRunParts", () => {
  it("names the year only where the zone has crossed into a new one", () => {
    expect(formatRunParts(LATER, "Asia/Tokyo", NOW).day).toContain("2027");
    expect(formatRunParts(LATER, "America/New_York", NOW).day).not.toMatch(/202[67]/);
    expect(formatRunParts(LATER, "Asia/Tokyo", NOW).day).toContain("2027");
    expect(formatRunParts(NOW, "Asia/Tokyo", NOW).day).not.toMatch(/202[67]/);
  });

  it("names the zone only when it isn't this machine's", () => {
    const local = machineTimeZone();
    const foreign = otherZone("Asia/Kathmandu", "America/Denver");
    const localTime = formatRunParts(NOW, local, NOW).time;
    const foreignTime = formatRunParts(NOW, foreign, NOW).time;
    expect(foreignTime).toBe(
      new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: foreign,
        timeZoneName: "short",
      }).format(NOW)
    );
    expect(localTime).toBe(
      new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: local,
      }).format(NOW)
    );
    expect(formatRunParts(NOW, local, NOW).time).toBe(localTime);
  });

  it("builds no more formatters for a long list than for a short one", () => {
    const zone = otherZone("Asia/Tokyo", "America/New_York");
    const runs = Array.from({ length: 30 }, (_, index) => NOW + index * 4 * HOUR);
    const format = (list: readonly number[]) => list.map((run) => formatRunParts(run, zone, NOW));
    const expected = format(runs);

    const spy = vi.spyOn(Intl, "DateTimeFormat");
    format(runs.slice(0, 3));
    const short = spy.mock.calls.length;
    spy.mockClear();
    const labels = format(runs);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(short);
    expect(labels).toEqual(expected);
  });
});

describe("formatRunInstant", () => {
  it("agrees with formatRunParts on year and zone", () => {
    const foreign = otherZone("Asia/Tokyo", "America/New_York");
    const instant = formatRunInstant(LATER, "Asia/Tokyo", NOW);
    expect(instant).toContain("2027");
    expect(formatRunInstant(LATER, "America/New_York", NOW)).not.toMatch(/202[67]/);
    const parts = formatRunParts(NOW, foreign, NOW);
    expect(formatRunInstant(NOW, foreign, NOW)).toContain(parts.time);
  });
});
