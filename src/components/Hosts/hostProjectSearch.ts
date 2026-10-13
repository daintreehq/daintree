/** A query's words, lowercased; empty for a blank query. */
export function queryTokens(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Whether every word of the query appears in one of the fields. Words match
 * independently, so "pagesugar linux" finds the project named on one field
 * and the host named on another. Every list of another host's projects
 * searches through here, so a query means the same in each of them.
 */
export function matchesTokens(tokens: readonly string[], fields: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const haystacks = fields.map((field) => field.toLocaleLowerCase());
  return tokens.every((token) => haystacks.some((haystack) => haystack.includes(token)));
}
