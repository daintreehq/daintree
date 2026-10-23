/**
 * The key a file or folder name is compared under where a case-insensitive
 * disk (APFS, NTFS) decides which names are the same entry: compatibility
 * normalized, then case-folded by way of upper case until it stops changing.
 * One round leaves `ẞ` as `ß` while `ß` becomes `ss`, so the round repeats.
 * Deliberately over-eager — `ſ`, full-width letters and ligatures all fold to
 * their plain forms — so use it to refuse, never to accept.
 */
export function foldFileName(name: string): string {
  let folded = name.normalize("NFKC");
  for (let round = 0; round < 4; round++) {
    const next = folded.toUpperCase().toLowerCase();
    if (next === folded) break;
    folded = next;
  }
  return folded.normalize("NFC");
}
