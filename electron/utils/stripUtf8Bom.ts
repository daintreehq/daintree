/**
 * Drops one leading UTF-8 byte-order mark. Windows PowerShell 5.1's
 * `Set-Content -Encoding utf8` / `Out-File`, older Notepad and some Windows
 * editors write one. Node's "utf-8" decoding keeps it as U+FEFF and
 * `JSON.parse` rejects it, so a hand-edited JSON file would read as malformed
 * and be skipped. Apply it before parsing user- or repo-authored JSON.
 */
export function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
