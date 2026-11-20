/**
 * Wall-clock arithmetic in a named IANA zone, through `Intl` alone: what a
 * zone's clock reads at an instant, and every instant it reads a given time.
 */

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

export function zoneFormat(zone: string | undefined): Intl.DateTimeFormat | null {
  const key = zone ?? "";
  let format = zoneFormats.get(key);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      });
    } catch {
      return null;
    }
    zoneFormats.set(key, format);
  }
  return format;
}

export function wallTime(epoch: number, format: Intl.DateTimeFormat): WallTime {
  const parts = Object.fromEntries(
    format.formatToParts(epoch).map((part) => [part.type, Number(part.value)])
  );
  return {
    year: parts.year!,
    month: parts.month! - 1,
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
  };
}

export function wallAsUtc(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute);
}

export const DAY_MS = 86_400_000;

/**
 * Every instant a zone's clock reads `wall`, earliest first: none in a
 * daylight-saving gap, two in a fold. Each candidate takes the zone's offset
 * from a day either side and is kept only if the clock reads `wall` there.
 */
export function instantsOf(wall: WallTime, format: Intl.DateTimeFormat): number[] {
  const target = wallAsUtc(wall);
  const instants = new Set<number>();
  for (const probe of [target - DAY_MS, target, target + DAY_MS]) {
    const instant = target - (wallAsUtc(wallTime(probe, format)) - probe);
    if (wallAsUtc(wallTime(instant, format)) === target) instants.add(instant);
  }
  return [...instants].sort((a, b) => a - b);
}
