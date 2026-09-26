/**
 * Length-prefixed frames for the remote-host link: one multiplexed byte stream
 * carrying five lanes. Wire layout, big-endian:
 *
 *   u32 bodyLength | u8 lane | u8 kind | u32 streamId | payload (bodyLength - 6)
 *
 * `bodyLength` counts everything after itself. `streamId` scopes a frame to a
 * logical stream within its lane (a terminal, a transfer, an RPC request); it is
 * 0 when unused. `kind` is lane-specific and opaque to the framing layer.
 */

export const Lane = {
  CONTROL: 0,
  RPC: 1,
  EVENTS: 2,
  INTERACTIVE: 3,
  BULK: 4,
} as const;
export type Lane = (typeof Lane)[keyof typeof Lane];

export const LANE_COUNT = 5;

/**
 * Drain order: control first (handshake, pings, lease changes), then
 * keystrokes and terminal output, then request/response, then events, and
 * bulk transfers last, so an upload never delays typing.
 */
export const LANE_PRIORITY: readonly Lane[] = [
  Lane.CONTROL,
  Lane.INTERACTIVE,
  Lane.RPC,
  Lane.EVENTS,
  Lane.BULK,
];

export interface LinkFrame {
  lane: Lane;
  kind: number;
  streamId: number;
  payload: Uint8Array;
}

export const FRAME_HEADER_BYTES = 10;
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** Bulk payloads are split into chunks no larger than this so other lanes interleave. */
export const BULK_CHUNK_BYTES = 64 * 1024;

export class FrameProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameProtocolError";
  }
}

function isLane(value: number): value is Lane {
  return Number.isInteger(value) && value >= 0 && value < LANE_COUNT;
}

export function encodeFrame(frame: LinkFrame, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): Uint8Array {
  if (!isLane(frame.lane)) throw new FrameProtocolError(`invalid lane ${frame.lane}`);
  if (!Number.isInteger(frame.kind) || frame.kind < 0 || frame.kind > 0xff) {
    throw new FrameProtocolError(`invalid kind ${frame.kind}`);
  }
  if (!Number.isInteger(frame.streamId) || frame.streamId < 0 || frame.streamId > 0xffffffff) {
    throw new FrameProtocolError(`invalid streamId ${frame.streamId}`);
  }
  const total = FRAME_HEADER_BYTES + frame.payload.byteLength;
  if (total > maxFrameBytes) {
    throw new FrameProtocolError(`frame of ${total} bytes exceeds ${maxFrameBytes}`);
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total - 4);
  out[4] = frame.lane;
  out[5] = frame.kind;
  view.setUint32(6, frame.streamId);
  out.set(frame.payload, FRAME_HEADER_BYTES);
  return out;
}

/**
 * Incremental decoder. Feed it arbitrary chunks from the socket; it yields
 * whole frames and throws {@link FrameProtocolError} on a frame that is
 * malformed or larger than the cap, at which point the session must be torn
 * down (the stream can no longer be resynchronised).
 *
 * Input is copied into one reassembly buffer, so memory is bounded by the
 * largest legal frame no matter how finely a peer fragments it, and the
 * caller may reuse the chunks it pushed. Every returned payload is its own
 * copy.
 */
export class FrameDecoder {
  private buf = new Uint8Array(4096);
  private start = 0;
  private end = 0;
  private failed = false;

  constructor(private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {}

  push(chunk: Uint8Array): LinkFrame[] {
    if (this.failed) throw new FrameProtocolError("decoder already failed");
    const frames: LinkFrame[] = [];
    let offset = 0;
    try {
      while (offset < chunk.byteLength || this.end - this.start >= 4) {
        // Take only what the frame in progress can still use, so buffered
        // bytes never exceed one frame's worth.
        const want = this.bytesWanted();
        if (want > 0 && offset < chunk.byteLength) {
          const n = Math.min(want, chunk.byteLength - offset);
          this.append(chunk.subarray(offset, offset + n));
          offset += n;
        }
        const frame = this.tryTake();
        if (frame) {
          frames.push(frame);
          continue;
        }
        if (offset >= chunk.byteLength) break;
      }
    } catch (err) {
      this.failed = true;
      this.buf = new Uint8Array(0);
      this.start = this.end = 0;
      throw err;
    }
    return frames;
  }

  get bufferedBytes(): number {
    return this.end - this.start;
  }

  private buffered(): number {
    return this.end - this.start;
  }

  /** Bytes still needed to complete the header or the frame in progress. */
  private bytesWanted(): number {
    const have = this.buffered();
    if (have < 4) return 4 - have;
    const total = this.frameTotal();
    return Math.max(0, total - have);
  }

  private frameTotal(): number {
    const bodyLength = new DataView(this.buf.buffer, this.buf.byteOffset + this.start, 4).getUint32(
      0
    );
    const total = bodyLength + 4;
    if (bodyLength < FRAME_HEADER_BYTES - 4 || total > this.maxFrameBytes) {
      throw new FrameProtocolError(`invalid frame length ${total}`);
    }
    return total;
  }

  private append(bytes: Uint8Array): void {
    const have = this.buffered();
    if (this.end + bytes.byteLength > this.buf.byteLength) {
      if (have + bytes.byteLength <= this.buf.byteLength && this.start > 0) {
        this.buf.copyWithin(0, this.start, this.end);
      } else {
        let size = this.buf.byteLength * 2;
        while (size < have + bytes.byteLength) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.buf.subarray(this.start, this.end));
        this.buf = next;
      }
      this.start = 0;
      this.end = have;
    }
    this.buf.set(bytes, this.end);
    this.end += bytes.byteLength;
  }

  private tryTake(): LinkFrame | null {
    if (this.buffered() < 4) return null;
    const total = this.frameTotal();
    if (this.buffered() < total) return null;
    const at = this.start;
    const lane = this.buf[at + 4]!;
    if (!isLane(lane)) throw new FrameProtocolError(`invalid lane ${lane}`);
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + at, total);
    const frame: LinkFrame = {
      lane,
      kind: this.buf[at + 5]!,
      streamId: view.getUint32(6),
      payload: this.buf.slice(at + FRAME_HEADER_BYTES, at + total),
    };
    this.start += total;
    if (this.start === this.end) this.start = this.end = 0;
    return frame;
  }
}
