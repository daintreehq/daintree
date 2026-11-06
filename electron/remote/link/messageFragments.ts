import {
  BULK_CHUNK_BYTES,
  FRAME_HEADER_BYTES,
  FrameProtocolError,
  LANE_COUNT,
  Lane,
  type LinkFrame,
} from "./frames.js";
import { BulkKind } from "./messages.js";

/**
 * Message fragments (#15892): a structured message whose encoded body is
 * larger than one bulk chunk crosses the link as several frames, so the
 * scheduler can put a ping, a keystroke echo or another terminal's output
 * between them instead of writing megabytes in one go.
 *
 *   whole message    kind          streamId 0    the encoded body
 *   fragment         kind | MORE   message id    the next MESSAGE_FRAGMENT_BYTES
 *   last fragment    kind          message id    the rest
 *
 * The message id is nonzero and only names the message while its fragments
 * cross; the fragments' payloads, in order, are the encoded body byte for
 * byte. Raw transfer chunks already carry a transfer id in `streamId` and are
 * never fragmented. A sender fragments only for a peer that said in its
 * handshake that it reads fragments, and starts at most one fragmented
 * message per lane at a time, so a receiver holds at most one partial body
 * per lane.
 */

export const MESSAGE_FRAGMENT_BYTES = BULK_CHUNK_BYTES;
/** Set on every fragment of a message but its last. */
export const FRAGMENT_MORE = 0x80;

const MAX_MESSAGE_ID = 0xffffffff;

function isRawChunk(frame: LinkFrame): boolean {
  return frame.lane === Lane.BULK && (frame.kind & ~FRAGMENT_MORE) === BulkKind.TRANSFER_CHUNK;
}

/** Whether a frame is one fragment of a larger message rather than a whole message. */
export function isMessageFragment(frame: LinkFrame): boolean {
  if (isRawChunk(frame)) return (frame.kind & FRAGMENT_MORE) !== 0;
  return frame.streamId !== 0 || (frame.kind & FRAGMENT_MORE) !== 0;
}

/**
 * Whether more of this frame's message follows it: true for every fragment but
 * the last, since no message kind uses the flag's bit.
 */
export function continuesMessage(frame: LinkFrame): boolean {
  return (frame.kind & FRAGMENT_MORE) !== 0;
}

/**
 * The frames one encoded message crosses as: itself when it fits one
 * fragment (or is a raw transfer chunk), otherwise its fragments under `id`.
 * Fragment payloads are views of the original payload, not copies.
 */
export function fragmentFrame(frame: LinkFrame, id: number): LinkFrame[] {
  const size = frame.payload.byteLength;
  if (size <= MESSAGE_FRAGMENT_BYTES || isRawChunk(frame)) return [frame];
  if (!Number.isInteger(id) || id < 1 || id > MAX_MESSAGE_ID) {
    throw new FrameProtocolError(`invalid message id ${id}`);
  }
  const fragments: LinkFrame[] = [];
  for (let at = 0; at < size; at += MESSAGE_FRAGMENT_BYTES) {
    const end = Math.min(size, at + MESSAGE_FRAGMENT_BYTES);
    fragments.push({
      lane: frame.lane,
      kind: end < size ? frame.kind | FRAGMENT_MORE : frame.kind,
      streamId: id,
      payload: frame.payload.subarray(at, end),
    });
  }
  return fragments;
}

/** Nonzero u32 message ids, one sequence per session. */
export class MessageIds {
  private next = 1;

  take(): number {
    const id = this.next;
    this.next = id >= MAX_MESSAGE_ID ? 1 : id + 1;
    return id;
  }
}

interface PartialMessage {
  id: number;
  kind: number;
  buf: Uint8Array;
  bytes: number;
}

/**
 * Rebuilds whole messages from fragments, one partial body per lane. A
 * fragment that breaks the rules (a second message started in a lane before
 * the first ended, a last fragment with nothing before it, a kind that
 * changes, a body past the cap) throws {@link FrameProtocolError}, after
 * which the session must end.
 *
 * Each partial body is one buffer grown by doubling, so what it holds is
 * bounded by the message cap however finely a peer cuts the message.
 */
export class MessageAssembler {
  private readonly partials: Array<PartialMessage | null> = Array.from(
    { length: LANE_COUNT },
    () => null
  );

  /** `maxFrameBytes` is the ceiling a whole message's frame would have had. */
  constructor(private readonly maxFrameBytes: number) {}

  /**
   * Take one frame off the wire: a whole message comes straight back, a
   * fragment comes back as its whole message once it is the last one, and
   * null until then.
   */
  push(frame: LinkFrame): LinkFrame | null {
    if (!isMessageFragment(frame)) return frame;
    const more = (frame.kind & FRAGMENT_MORE) !== 0;
    const kind = frame.kind & ~FRAGMENT_MORE;
    if (frame.streamId === 0) throw new FrameProtocolError("message fragment without an id");
    if (isRawChunk(frame)) throw new FrameProtocolError("fragmented transfer chunk");
    if (frame.payload.byteLength === 0) throw new FrameProtocolError("empty message fragment");
    const lane = frame.lane;
    let partial = this.partials[lane];
    if (partial) {
      if (partial.id !== frame.streamId) {
        throw new FrameProtocolError(
          `message ${frame.streamId} began inside message ${partial.id}`
        );
      }
      if (partial.kind !== kind) throw new FrameProtocolError("message fragment changed kind");
    } else {
      if (!more) throw new FrameProtocolError("last fragment of a message never begun");
      partial = { id: frame.streamId, kind, buf: new Uint8Array(0), bytes: 0 };
      this.partials[lane] = partial;
    }
    this.append(partial, frame.payload);
    if (more) return null;
    this.partials[lane] = null;
    return { lane, kind, streamId: 0, payload: partial.buf.subarray(0, partial.bytes) };
  }

  /** Bytes held in unfinished messages, across lanes. */
  get partialBytes(): number {
    let total = 0;
    for (const partial of this.partials) total += partial?.bytes ?? 0;
    return total;
  }

  clear(): void {
    this.partials.fill(null);
  }

  private append(partial: PartialMessage, bytes: Uint8Array): void {
    const need = partial.bytes + bytes.byteLength;
    const limit = this.maxFrameBytes - FRAME_HEADER_BYTES;
    if (need > limit) {
      throw new FrameProtocolError(`message of more than ${limit} bytes`);
    }
    if (need > partial.buf.byteLength) {
      let size = Math.max(partial.buf.byteLength * 2, 2 * MESSAGE_FRAGMENT_BYTES);
      while (size < need) size *= 2;
      const next = new Uint8Array(Math.min(size, limit));
      next.set(partial.buf.subarray(0, partial.bytes));
      partial.buf = next;
    }
    partial.buf.set(bytes, partial.bytes);
    partial.bytes = need;
  }
}
