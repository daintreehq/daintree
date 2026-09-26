/**
 * The revision `host.fs.writeFile` compares `expectedRevision` against: the
 * lowercase sha256 hex of the file's bytes. A string is hashed as its UTF-8
 * encoding, which is what `writeFile` puts on disk.
 *
 * Async because it uses Web Crypto, so the same function runs in a plugin
 * worker and in a panel view. Pass the bytes from `host.fs.readFileBytes`
 * rather than the text from `readFile` when you hash an existing file: a byte
 * order mark or an invalid UTF-8 sequence does not survive decoding, so the
 * text can hash differently from the file.
 */
export async function contentRevision(content: string | Uint8Array): Promise<string> {
  // A caller's view is copied because `subtle.digest` refuses a view over a
  // SharedArrayBuffer; the encoder's output is already a plain ArrayBuffer.
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
