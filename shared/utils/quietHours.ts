/**
 * Minutes-since-midnight (0-1439). Using plain numbers avoids HH:MM parsing
 * at evaluation time — the UI formats for display only.
 */
export function isInQuietHoursWindow(startMin: number, endMin: number, nowMin: number): boolean {
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || !Number.isFinite(nowMin)) {
    return false;
  }
  if (startMin < 0 || startMin > 1439 || endMin < 0 || endMin > 1439) return false;
  if (startMin === endMin) return false;
  if (nowMin < 0 || nowMin > 1439) return false;
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

export function isWeekdayActive(weekdays: readonly number[] | undefined, day: number): boolean {
  if (!weekdays || weekdays.length === 0) return true;
  return weekdays.includes(day);
}

export interface QuietHoursSchedule {
  quietHoursEnabled: boolean;
  quietHoursStartMin: number;
  quietHoursEndMin: number;
  quietHoursWeekdays: readonly number[];
}

export function isScheduledQuietNow(
  schedule: Partial<QuietHoursSchedule> | undefined,
  now: Date = new Date()
): boolean {
  if (!schedule?.quietHoursEnabled) return false;
  const startMin = schedule.quietHoursStartMin;
  const endMin = schedule.quietHoursEndMin;
  if (typeof startMin !== "number" || typeof endMin !== "number") return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (!isInQuietHoursWindow(startMin, endMin, nowMin)) return false;
  // When a schedule spans midnight, the start-side day is what counts.
  const effectiveDay = nowMin < endMin && startMin > endMin ? (now.getDay() + 6) % 7 : now.getDay();
  return isWeekdayActive(schedule.quietHoursWeekdays, effectiveDay);
}

/**
 * Minutes-since-midnight for the next occurrence of `targetMin` strictly in
 * the future. Used by the "Mute until tomorrow morning" quick action.
 */
export function nextOccurrenceTimestamp(targetMin: number, now: Date = new Date()): number {
  const candidate = new Date(now);
  candidate.setHours(Math.floor(targetMin / 60), targetMin % 60, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}

export function formatTimeOfDay(min: number): string {
  const safe = Math.max(0, Math.min(1439, Math.floor(min)));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
