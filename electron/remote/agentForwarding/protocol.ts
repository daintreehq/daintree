/**
 * The ssh-agent wire format (draft-miller-ssh-agent): every message is a
 * `uint32` body length followed by the body, whose first byte is its type.
 * The relay moves whole messages, never a byte stream, so each side can
 * judge one request at a time and answer it exactly once.
 */

/** OpenSSH's own ceiling for a message body, in either direction. */
export const AGENT_MAX_MESSAGE_BYTES = 256 * 1024;

export const AgentMessageType = {
  FAILURE: 5,
  REQUEST_IDENTITIES: 11,
  SIGN_REQUEST: 13,
  EXTENSION: 27,
} as const;

/**
 * The one extension a forwarded connection may carry. ssh binds each agent
 * connection to the host key of the server it is signing in to, and the
 * agent checks a destination-constrained key against that binding, so
 * passing it on is stricter than leaving the connection unbound.
 */
export const SESSION_BIND_EXTENSION = "session-bind@openssh.com";

/** A complete `SSH_AGENT_FAILURE` body. */
export const AGENT_FAILURE_BODY: Uint8Array = Uint8Array.of(AgentMessageType.FAILURE);

export class AgentFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentFramingError";
  }
}

/** Length-prefix a message body for the wire. */
export function frameAgentMessage(body: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(4 + body.byteLength);
  out.writeUInt32BE(body.byteLength, 0);
  out.set(body, 4);
  return out;
}

/**
 * Cuts a byte stream into message bodies. A zero or oversized length is a
 * broken peer, refused before anything is allocated for it.
 */
export class AgentMessageReader {
  private chunks: Buffer[] = [];
  private buffered = 0;

  /** Bytes held toward a message not yet complete. */
  get pendingBytes(): number {
    return this.buffered;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength > 0) {
      this.chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      this.buffered += chunk.byteLength;
    }
    const messages: Uint8Array[] = [];
    while (this.buffered >= 4) {
      const head = this.peek(4);
      const length = head.readUInt32BE(0);
      if (length === 0 || length > AGENT_MAX_MESSAGE_BYTES) {
        throw new AgentFramingError(`Agent message length ${length} is out of bounds`);
      }
      if (this.buffered < 4 + length) break;
      const whole = this.take(4 + length);
      messages.push(Uint8Array.prototype.slice.call(whole, 4));
    }
    return messages;
  }

  private peek(size: number): Buffer {
    if (this.chunks[0]!.byteLength >= size) return this.chunks[0]!;
    const joined = Buffer.concat(this.chunks);
    this.chunks = [joined];
    return joined;
  }

  private take(size: number): Buffer {
    const head = this.peek(size);
    const taken = head.subarray(0, size);
    const rest = head.subarray(size);
    if (rest.byteLength > 0) this.chunks[0] = rest;
    else this.chunks.shift();
    this.buffered -= size;
    return taken;
  }
}

/** An SSH `string`'s contents at `offset`, or null when the body is too short for it. */
function readString(body: Uint8Array, offset: number): Uint8Array | null {
  if (offset + 4 > body.byteLength) return null;
  const length = Buffer.from(body.buffer, body.byteOffset, body.byteLength).readUInt32BE(offset);
  if (offset + 4 + length > body.byteLength) return null;
  return body.subarray(offset + 4, offset + 4 + length);
}

/**
 * Whether a request may reach this computer's agent: listing keys, signing
 * with one, and binding the connection to a session. Adding, removing,
 * locking or unlocking keys, smartcard providers and every other extension
 * are answered with a failure by the relay itself.
 */
export function isForwardableRequest(body: Uint8Array): boolean {
  switch (body[0]) {
    case AgentMessageType.REQUEST_IDENTITIES:
    case AgentMessageType.SIGN_REQUEST:
      return true;
    case AgentMessageType.EXTENSION: {
      const name = readString(body, 1);
      return name !== null && Buffer.from(name).toString("latin1") === SESSION_BIND_EXTENSION;
    }
    default:
      return false;
  }
}
