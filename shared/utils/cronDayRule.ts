import type { ParsedCron } from "./cron.js";

/**
 * Which days a cron runs on, in the terms an OS calendar can hold: every day,
 * chosen days of the month, chosen weekdays, or either of the two.
 */
export type DayRule =
  | { readonly kind: "any" }
  | { readonly kind: "days"; readonly days: readonly number[] }
  | { readonly kind: "weekdays"; readonly weekdays: readonly number[] }
  | {
      readonly kind: "either";
      readonly days: readonly number[];
      readonly weekdays: readonly number[];
    };

export function chosen(values: readonly boolean[], min: number, max: number): number[] {
  const out: number[] = [];
  for (let value = min; value <= max; value++) if (values[value]) out.push(value);
  return out;
}

/**
 * Vixie cron's day rule, or null when it needs both day fields to match.
 * Cron ORs the two day fields when neither starts with `*` and ANDs them
 * otherwise. No OS calendar here has the AND, and each writes the OR as
 * separate entries so nothing leans on how it combines fields itself.
 */
export function dayRule(cron: ParsedCron): DayRule | null {
  const days = chosen(cron.daysOfMonth, 1, 31);
  const weekdays = chosen(cron.daysOfWeek, 0, 6);
  const everyDay = days.length === 31;
  const everyWeekday = weekdays.length === 7;
  if (!cron.dayOfMonthStarred && !cron.dayOfWeekStarred) {
    return everyDay || everyWeekday ? { kind: "any" } : { kind: "either", days, weekdays };
  }
  if (everyDay && everyWeekday) return { kind: "any" };
  if (everyDay) return { kind: "weekdays", weekdays };
  if (everyWeekday) return { kind: "days", days };
  return null;
}
