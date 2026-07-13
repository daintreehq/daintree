export function isValidPastTimestamp(
  timestamp: number | null | undefined,
  now = Date.now()
): timestamp is number {
  return (
    typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now
  );
}
