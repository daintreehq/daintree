const SAME_DAY = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
const OTHER_DAY = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * A time a host reported, to the second: a relaunch and the session it
 * replaced can be seconds apart. The date shows when it isn't today.
 */
export function formatHostTime(at: number, now: number = Date.now()): string {
  const when = new Date(at);
  const today = new Date(now);
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate();
  return (sameDay ? SAME_DAY : OTHER_DAY).format(when);
}
