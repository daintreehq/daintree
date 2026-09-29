/**
 * A count with its noun: "1 file", "1,204 files". The one plural helper for
 * user-facing copy, so a count never reads "1 files" and large counts carry the
 * locale's digit grouping everywhere rather than on the surfaces that remembered.
 *
 * `plural` defaults to `${singular}s`; pass it for irregular nouns ("patch" →
 * "patches") or for a phrase whose verb agrees too ("terminal is" → "terminals are").
 */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? `1 ${singular}` : `${count.toLocaleString()} ${plural}`;
}

/** The noun alone, for sentences that place the count themselves. */
export function pluralNoun(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}
