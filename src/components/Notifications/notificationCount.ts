export const MAX_NOTIFICATION_COUNT = 99;

export function formatNotificationCountGlyph(count: number, prefix = ""): string {
  if (!Number.isFinite(count)) return `${prefix}0`;
  const safe = Math.max(0, Math.floor(count));
  return safe > MAX_NOTIFICATION_COUNT ? `${prefix}${MAX_NOTIFICATION_COUNT}+` : `${prefix}${safe}`;
}

export function formatNotificationCountAriaLabel(count: number): string {
  const safe = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return `${safe} events`;
}
