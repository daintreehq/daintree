/**
 * The continuation a paged read of one message hands back (#12496).
 *
 * Stateless: it names the message by digests of its id and of the text before
 * the page boundary, and the next call finds that message by reading the
 * transcript again rather than trusting anything kept between calls. Offsets
 * are UTF-16 code units into the message's joined text, counted from its start
 * — Claude Code appends a message's blocks, so text already written keeps its
 * offsets while more arrives. A digest that no longer matches means the message
 * changed, which is reported rather than having another message's text spliced
 * in.
 *
 * The id goes in as a digest rather than as itself so every cursor has the same
 * short length: an id escapes to up to six bytes a character, and a cursor the
 * tool mints must always be one its own argument check accepts.
 *
 * It grants nothing. It is matched against whatever transcript the owned
 * terminal resolves to, so a cursor from another pane simply matches nothing.
 */

import { createHash } from "crypto";
import { LAST_MESSAGE_CURSOR_MAX_CHARS } from "../../../shared/types/agentLastMessage.js";

const VERSION = 1;
const DIGEST_CHARS = 16;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface MessageCursor {
  /** Digest of the message id, or null for a message that had none. */
  id: string | null;
  /** Exclusive end of the next page, in code units from the message's start. */
  end: number;
  digest: string;
}

/** Hashed as UTF-16 so a lone surrogate is not collapsed into a replacement character first. */
function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf16le").digest("base64url").slice(0, DIGEST_CHARS);
}

const isDigest = (value: unknown): value is string =>
  typeof value === "string" && value.length === DIGEST_CHARS && BASE64URL.test(value);

export function encodeMessageCursor(id: string | null, text: string, end: number): string {
  const payload = {
    v: VERSION,
    id: id === null ? null : digestOf(id),
    end,
    h: digestOf(text.slice(0, end)),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** The cursor a caller passed back, or null when it is not one this reader could have minted. */
export function decodeMessageCursor(value: string): MessageCursor | null {
  if (value.length > LAST_MESSAGE_CURSOR_MAX_CHARS || !BASE64URL.test(value)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { v, id, end, h } = parsed as Record<string, unknown>;
  if (v !== VERSION || (id !== null && !isDigest(id)) || !isDigest(h)) return null;
  if (typeof end !== "number" || !Number.isSafeInteger(end) || end <= 0) return null;
  return { id, end, digest: h };
}

/** Whether `text` is the message the cursor was minted from, as far as the cursor reaches. */
export function cursorMatches(cursor: MessageCursor, id: string | null, text: string): boolean {
  return (
    (id === null ? cursor.id === null : cursor.id === digestOf(id)) &&
    text.length >= cursor.end &&
    digestOf(text.slice(0, cursor.end)) === cursor.digest
  );
}
