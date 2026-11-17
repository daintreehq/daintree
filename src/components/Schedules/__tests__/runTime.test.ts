import { afterEach, describe, expect, it, vi } from "vitest";
import { machineTimeZone } from "@shared/utils/cron";
import { formatRunColumn, formatRunInstant, localDayNumber } from "../runTime";

const HOUR = 3_600_000;
// 12:00 UTC on the last day of 2026: still 2026 in New York, nearly 2027 in Tokyo.
const NOW = Date.UTC(2026, 11, 31, 12);
// Eight hours later it is 2027 in Tokyo but not yet in New York.
const LATER = NOW + 8 * HOUR;
const ZONES = ["Asia/Tokyo", "America/New_York", "Asia/Kathmandu", "UTC"];

function otherZone(...candidates: string[]): string {
  return candidates.find((zone) => zone !== machineTimeZone())!;
}

// Built fresh on every call, so a formatter cached under the wrong key shows up
// as a disagreement.
function freshYear(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(epochMs);
}

function freshParts(epochMs: number, timeZone: string, now: number) {
  const foreign = timeZone !== machineTimeZone();
  const newYear = freshYear(epochMs, timeZone) !== freshYear(now, timeZone);
  return {
    at: epochMs,
    day: new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone,
      ...(newYear ? { year: "numeric" } : {}),
    }).format(epochMs),
    time: new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      ...(foreign ? { timeZoneName: "short" } : {}),
    }).format(epochMs),
  };
}

function freshInstant(epochMs: number, timeZone: string, now: number): string {
  const newYear = freshYear(epochMs, timeZone) !== freshYear(now, timeZone);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    ...(newYear ? { year: "numeric" } : {}),
    ...(timeZone !== machineTimeZone() ? { timeZoneName: "short" } : {}),
  }).format(epochMs);
}

function stubMachineZone(timeZone: string) {
  let reported = timeZone;
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
    this: Intl.DateTimeFormat
  ) {
    return { ...real.call(this), timeZone: reported };
  });
  return (next: string) => {
    reported = next;
  };
}

// A module with empty caches, so the count starts from nothing built, after
// filling the cache with other zones' formatters.
async function columnConstructions(runs: readonly number[], timeZone: string, crowd = 0) {
  vi.resetModules();
  const cold = await import("../runTime");
  for (const zone of Intl.supportedValuesOf("timeZone").slice(0, crowd)) {
    cold.localDayNumber(NOW, zone);
  }
  const spy = vi.spyOn(Intl, "DateTimeFormat");
  cold.formatRunColumn(runs, timeZone, NOW);
  const first = spy.mock.calls.length;
  spy.mockClear();
  cold.formatRunColumn(runs, timeZone, NOW);
  const again = spy.mock.calls.length;
  spy.mockRestore();
  return { first, again };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatRunColumn", () => {
  it("names the year only on rows the zone has carried into a new one", () => {
    const tokyo = formatRunColumn([NOW, LATER], "Asia/Tokyo", NOW).rows;
    expect(tokyo[0]?.day).not.toMatch(/202[67]/);
    expect(tokyo[1]?.day).toContain("2027");
    const newYork = formatRunColumn([NOW, LATER], "America/New_York", NOW).rows;
    expect(newYork.map((row) => row.day).join(" ")).not.toMatch(/202[67]/);
    expect(formatRunColumn([LATER], "Asia/Tokyo", NOW).rows).toEqual([
      freshParts(LATER, "Asia/Tokyo", NOW),
    ]);
  });

  it("names the zone only when it isn't this machine's", () => {
    const local = formatRunColumn([NOW], machineTimeZone(), NOW);
    expect(local.foreign).toBe(false);
    const foreignZone = otherZone("Asia/Kathmandu", "America/Denver");
    const foreign = formatRunColumn([NOW], foreignZone, NOW);
    expect(foreign.foreign).toBe(true);
    expect(foreign.rows[0]?.time).not.toBe(local.rows[0]?.time);
    expect(formatRunColumn([NOW], machineTimeZone(), NOW).rows).toEqual(local.rows);
  });

  it("names the zone once the machine has moved out of it", () => {
    const move = stubMachineZone("Asia/Tokyo");
    const runs = [NOW, LATER];
    const home = formatRunColumn(runs, "Asia/Tokyo", NOW);
    expect(home.foreign).toBe(false);
    expect(home.rows).toEqual(runs.map((run) => freshParts(run, "Asia/Tokyo", NOW)));

    move("America/New_York");
    const away = formatRunColumn(runs, "Asia/Tokyo", NOW);
    expect(away.foreign).toBe(true);
    expect(away.rows).toEqual(runs.map((run) => freshParts(run, "Asia/Tokyo", NOW)));
    expect(away.rows[0]?.time).not.toBe(home.rows[0]?.time);
  });

  it("labels every row as freshly built formatters would, across zones and years", () => {
    const runs = Array.from({ length: 12 }, (_, index) => NOW + index * 3 * HOUR);
    const zones = [...ZONES, machineTimeZone(), ...ZONES];
    for (const zone of zones) {
      const column = formatRunColumn(runs, zone, NOW);
      expect(column.foreign).toBe(zone !== machineTimeZone());
      expect(column.rows).toEqual(runs.map((run) => freshParts(run, zone, NOW)));
    }
  });

  it("builds each distinct formatter once, however long the column", async () => {
    // Every column here crosses New Year in Tokyo, so each needs the same formatters.
    const runs = Array.from({ length: 30 }, (_, index) => NOW + index * 4 * HOUR);
    const long = await columnConstructions(runs, "Asia/Tokyo");
    const short = await columnConstructions(runs.slice(0, 3), "Asia/Tokyo");
    expect(long.first).toBe(short.first);
    // Reading and checking the machine's zone, then the column's year, time, and
    // day with and without the year.
    expect(long.first).toBeLessThanOrEqual(6);
    // Only the machine's zone is read again.
    expect(long.again).toBeLessThanOrEqual(1);
  });

  it("builds each formatter once even when the cache fills up partway through a column", async () => {
    const runs = Array.from({ length: 30 }, (_, index) => NOW + index * 4 * HOUR);
    const { first } = await columnConstructions(runs, "Asia/Tokyo");
    for (let crowd = 1; crowd <= 40; crowd++) {
      expect((await columnConstructions(runs, "Asia/Tokyo", crowd)).first).toBe(first);
    }
  });
});

describe("formatRunInstant", () => {
  it("labels instants as freshly built formatters would, across zones and years", () => {
    for (const zone of [...ZONES, machineTimeZone(), ...ZONES]) {
      for (const at of [NOW, LATER, NOW + 400 * 24 * HOUR]) {
        expect(formatRunInstant(at, zone, NOW)).toBe(freshInstant(at, zone, NOW));
      }
    }
  });
});

describe("localDayNumber", () => {
  it("keeps each zone's day count apart", () => {
    expect(localDayNumber(LATER, "Asia/Tokyo") - localDayNumber(NOW, "Asia/Tokyo")).toBe(1);
    expect(
      localDayNumber(LATER, "America/New_York") - localDayNumber(NOW, "America/New_York")
    ).toBe(0);
    expect(localDayNumber(LATER, "Asia/Tokyo")).toBe(localDayNumber(LATER, "America/New_York") + 1);
  });
});
