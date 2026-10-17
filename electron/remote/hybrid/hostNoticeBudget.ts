/**
 * Notices one host may raise in a window of {@link HOST_NOTICE_WINDOW_MS},
 * shared across its native notifications, its plugins' toasts and its
 * attention events, so no route or plugin name buys a host more.
 */
export const HOST_NOTICE_BURST = 6;
export const HOST_NOTICE_WINDOW_MS = 60_000;

const shownAt = new Map<string, number[]>();

/** Whether `hostId` is still under its share of notices; counts this one when it is. */
export function admitHostNotice(hostId: string, now = Date.now()): boolean {
  for (const [id, times] of shownAt) {
    if (times.every((at) => now - at >= HOST_NOTICE_WINDOW_MS)) shownAt.delete(id);
  }
  const recent = (shownAt.get(hostId) ?? []).filter((at) => now - at < HOST_NOTICE_WINDOW_MS);
  if (recent.length >= HOST_NOTICE_BURST) {
    shownAt.set(hostId, recent);
    return false;
  }
  recent.push(now);
  shownAt.set(hostId, recent);
  return true;
}

/** Forget every host's recent notices (tests). */
export function resetHostNoticeBudget(): void {
  shownAt.clear();
}
