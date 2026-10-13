// Notepad and Windows PowerShell 5.1 (`Set-Content -Encoding utf8`, `Out-File`)
// save UTF-8 with a byte-order mark, which JSON.parse rejects as invalid JSON.
export function parseJsonText(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}
