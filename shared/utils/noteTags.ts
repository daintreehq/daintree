export function normalizeTag(raw: string): string {
  return raw.toLowerCase().trim();
}

export function normalizeTags(raw: unknown): string[] {
  let items: unknown[];

  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    items = [raw];
  } else if (Array.isArray(raw)) {
    items = raw;
  } else {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    if (typeof item !== "string") continue;
    const normalized = normalizeTag(item);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}
