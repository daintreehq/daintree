export function parseExactNumber(query: string): number | null {
  const trimmed = query.trim();
  const match = trimmed.match(/^#?(\d+)$/);
  if (!match) return null;
  const num = parseInt(match[1]!, 10);
  if (num <= 0 || !Number.isFinite(num)) return null;
  return num;
}
