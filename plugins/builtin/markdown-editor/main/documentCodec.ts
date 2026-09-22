import { createHash } from "node:crypto";
import type { Eol } from "../shared/protocol.js";

/**
 * Bytes on disk ⇄ the text the editor holds (#12323). The editor buffer is
 * the file: nothing here reformats, re-wraps or trims. The only translations
 * are the three the format itself demands — a UTF-8 BOM is stripped for the
 * editor and re-emitted on save, CRLF line endings are stored as `\n` (the
 * way CodeMirror stores lines) and re-applied as the file's dominant ending on
 * an edited save, and a file that does not decode as strict UTF-8 is refused
 * outright rather than having its undecodable bytes replaced and written back.
 */
export interface DecodedDocument {
  /** Editor text: BOM stripped, lines joined with `\n`. */
  text: string;
  hasBom: boolean;
  /** The dominant line ending; ties fall to `\n`. */
  eol: Eol;
  /** Both endings present. An edited save normalises to `eol`; an unedited save never does. */
  mixedEol: boolean;
  /** sha256 hex of the bytes as read. */
  revision: string;
  size: number;
}

const BOM = [0xef, 0xbb, 0xbf] as const;
const BOM_CHAR = "\uFEFF";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256")
    .update(typeof bytes === "string" ? Buffer.from(bytes, "utf-8") : bytes)
    .digest("hex");
}

export function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2];
}

export function detectEol(raw: string): { eol: Eol; mixedEol: boolean } {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) !== 10) continue;
    if (i > 0 && raw.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return { eol: crlf > lf ? "\r\n" : "\n", mixedEol: crlf > 0 && lf > 0 };
}

export type DecodeResult =
  { ok: true; document: DecodedDocument } | { ok: false; reason: "NOT_UTF8" };

export function decodeDocument(bytes: Uint8Array): DecodeResult {
  const bom = hasUtf8Bom(bytes);
  const body = bom ? bytes.subarray(3) : bytes;
  let raw: string;
  try {
    raw = strictUtf8.decode(body);
  } catch {
    return { ok: false, reason: "NOT_UTF8" };
  }
  const { eol, mixedEol } = detectEol(raw);
  return {
    ok: true,
    document: {
      text: raw.replace(/\r\n/g, "\n"),
      hasBom: bom,
      eol,
      mixedEol,
      revision: sha256Hex(bytes),
      size: bytes.length,
    },
  };
}

/**
 * The string whose UTF-8 encoding is the file: BOM prefix, lines joined with
 * the recorded ending. Handed to `host.fs.writeFile` as text, which encodes it
 * as UTF-8 — the same bytes `encodeDocument` produces.
 */
export function assembleDocument(text: string, meta: { hasBom: boolean; eol: Eol }): string {
  const body = meta.eol === "\n" ? text : text.replace(/\n/g, meta.eol);
  return meta.hasBom ? BOM_CHAR + body : body;
}

export function encodeDocument(text: string, meta: { hasBom: boolean; eol: Eol }): Uint8Array {
  return new Uint8Array(Buffer.from(assembleDocument(text, meta), "utf-8"));
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}
