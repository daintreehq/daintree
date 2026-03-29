/**
 * Convert an arbitrary recipe name into a safe filesystem filename.
 * Strips diacritics, forbidden chars, collapses whitespace to hyphens,
 * and truncates to 200 chars before appending ".json".
 */
export function safeRecipeFilename(name: string): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
      .replace(/[\\/:*?"<>|]/g, "") // strip OS-forbidden chars
      .replace(/\s+/g, "-") // spaces → hyphens
      .replace(/-+/g, "-") // collapse consecutive hyphens
      .replace(/^[-.]+|[-.]+$/g, "") // no leading/trailing hyphens or dots
      .toLowerCase()
      .slice(0, 200) || "recipe";

  return `${base}.json`;
}
