import {
  LAST_MESSAGE_INDEX_MAX,
  LAST_MESSAGE_TEXT_REQUEST_MAX_BYTES,
  LAST_MESSAGE_TEXT_REQUEST_MIN_BYTES,
  type AgentLastMessageReadOptions,
} from "../../../shared/types/agentLastMessage.js";
import { decodeMessageCursor } from "../claude/ClaudeMessageCursor.js";

export type LastMessageReadArgs =
  { ok: true; options: AgentLastMessageReadOptions } | { ok: false; message: string };

function integerWithin(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * What a `terminal.readLastMessageOwned` call asks of the read beyond its
 * terminal id (#12496).
 *
 * Checked here because nothing else checks it: a main-executed tool never
 * passes through the action's schema parse. Only these three names are read,
 * and only as the call's own properties, so nothing else it sent — a path, a
 * session id, a scan ceiling — reaches the reader. A value out of range is
 * refused rather than clamped, so the caller learns the bound instead of
 * getting a different read than the one it asked for.
 */
export function parseLastMessageReadArgs(args: unknown): LastMessageReadArgs {
  const options: AgentLastMessageReadOptions = {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: true, options };
  }
  const own = (key: string): unknown =>
    Object.hasOwn(args, key) ? (args as Record<string, unknown>)[key] : undefined;

  const maxBytes = own("maxBytes");
  if (maxBytes !== undefined) {
    if (
      !integerWithin(
        maxBytes,
        LAST_MESSAGE_TEXT_REQUEST_MIN_BYTES,
        LAST_MESSAGE_TEXT_REQUEST_MAX_BYTES
      )
    ) {
      return {
        ok: false,
        message: `'maxBytes' must be an integer from ${LAST_MESSAGE_TEXT_REQUEST_MIN_BYTES} to ${LAST_MESSAGE_TEXT_REQUEST_MAX_BYTES}.`,
      };
    }
    options.maxBytes = maxBytes;
  }

  const messageIndex = own("messageIndex");
  if (messageIndex !== undefined) {
    if (!integerWithin(messageIndex, 0, LAST_MESSAGE_INDEX_MAX)) {
      return {
        ok: false,
        message: `'messageIndex' must be an integer from 0 to ${LAST_MESSAGE_INDEX_MAX}.`,
      };
    }
    options.messageIndex = messageIndex;
  }

  const cursor = own("cursor");
  if (cursor !== undefined) {
    if (typeof cursor !== "string" || decodeMessageCursor(cursor) === null) {
      return {
        ok: false,
        message:
          "'cursor' must be a 'message.nextCursor' this tool returned, passed back unchanged.",
      };
    }
    if (options.messageIndex !== undefined) {
      return {
        ok: false,
        message: "Pass 'cursor' or 'messageIndex', not both: a cursor already names its message.",
      };
    }
    options.cursor = cursor;
  }

  return { ok: true, options };
}
