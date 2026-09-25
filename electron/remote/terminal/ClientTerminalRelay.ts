import type { SerializedTerminalSnapshot } from "../../../shared/types/terminal.js";
import { Lane } from "../link/frames.js";
import { InteractiveKind } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import { safePost, type PortLike } from "./ports.js";
import {
  MAX_RESUME_TERMINALS,
  TERMINAL_RESUME_METHOD,
  TerminalInPortMessageSchema,
  TerminalOutPortMessageSchema,
  TerminalResumeResultSchema,
  type TerminalInPortMessage,
  type TerminalResumeRequest,
} from "./protocol.js";

/**
 * Client side of one remote view's terminal stream. The view gets a local
 * port through the same token handshake a local view's pty-host port uses,
 * so the renderer's terminal client cannot tell the difference; this relay
 * carries that port's traffic over the link.
 *
 * It tracks the incarnation and last sequence number it delivered for each
 * terminal. Duplicates are dropped, a gap asks the host to resume that
 * terminal, and after a reconnect the relay resumes every terminal it knows so
 * the host replays what was missed or resets it from a snapshot. A reset
 * reaches the renderer as a `reset` port message.
 *
 * A position only advances once the frame reached a live renderer port, so
 * output that arrives while the view has no port is replayed later rather
 * than counted as seen. A replaced port (the view reloaded) has lost what the
 * old one painted, so every terminal is reset from a snapshot.
 */

export interface ClientTerminalRelayOptions {
  endpointId: string;
  /** The host this view's endpoint lives on. */
  hostId?: string;
  /**
   * Hand the view a fresh port (token first, then the port) and return this
   * side's end, or null when the view cannot take one right now.
   */
  openRendererPort(): PortLike | null;
  /** Input typed while the link is down is held up to this many bytes... */
  maxPendingInputBytes?: number;
  /** ...and this many messages, so a flood of empty writes is bounded too. */
  maxPendingInputMessages?: number;
  /** Distinct terminals with a resize held while the link is down. */
  maxPendingResizes?: number;
  /** Terminals whose position is remembered; the least recently active go first. */
  maxTrackedTerminals?: number;
}

interface Position {
  incarnation: number;
  lastSeq: number;
}

type WriteMessage = Extract<TerminalInPortMessage, { type: "write" }>;
type ResizeMessage = Extract<TerminalInPortMessage, { type: "resize" }>;

const DEFAULT_MAX_PENDING_INPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_PENDING_INPUT_MESSAGES = 1024;
const DEFAULT_MAX_PENDING_RESIZES = 256;
const DEFAULT_MAX_TRACKED_TERMINALS = MAX_RESUME_TERMINALS;

export class ClientTerminalRelay {
  readonly endpointId: string;
  readonly hostId: string | undefined;

  private readonly opts: ClientTerminalRelayOptions;
  private port: PortLike | null = null;
  private portsDelivered = 0;
  private session: LinkSession | null = null;
  private sessionCleanup: (() => void)[] = [];
  private readonly positions = new Map<string, Position>();
  private readonly resuming = new Set<string>();
  /** The renderer lost its screens: the next resume asks for snapshot resets. */
  private resetOwed = false;
  private resumesInFlight = 0;
  private pendingInput: WriteMessage[] = [];
  private pendingInputBytes = 0;
  private readonly pendingResize = new Map<string, ResizeMessage>();
  private disposed = false;

  constructor(options: ClientTerminalRelayOptions) {
    this.opts = options;
    this.endpointId = options.endpointId;
    this.hostId = options.hostId;
  }

  get isAttached(): boolean {
    return this.session !== null;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** A resume call is outstanding (including the one every attach makes). */
  get resumeInFlight(): boolean {
    return this.resumesInFlight > 0;
  }

  /** Terminals whose position is tracked, for diagnostics and tests. */
  get trackedTerminals(): number {
    return this.positions.size;
  }

  /** What the relay has delivered for a terminal, for diagnostics and tests. */
  position(terminalId: string): Position | null {
    const p = this.positions.get(terminalId);
    return p ? { ...p } : null;
  }

  /**
   * (Re)deliver the renderer port: at creation, and whenever the view loads a
   * new document or something else would have handed it a local port.
   * Returns false when the view could not take it.
   */
  deliverPort(): boolean {
    if (this.disposed) return false;
    const port = this.opts.openRendererPort();
    if (!port) return false;
    const previous = this.port;
    const replaced = this.portsDelivered > 0;
    this.portsDelivered++;
    this.port = port;
    port.onMessage((message) => {
      if (this.port === port) this.onRendererMessage(message);
    });
    port.onClose(() => {
      if (this.port === port) this.port = null;
    });
    previous?.close();
    if (replaced && this.positions.size > 0) {
      // The new document starts from nothing: what the old port painted is
      // gone, and a replay would only draw what came after it.
      this.resetOwed = true;
      if (this.session) void this.resume([...this.positions.keys()], true);
    }
    return true;
  }

  attach(session: LinkSession): void {
    if (this.disposed || this.session === session) return;
    this.detach();
    this.session = session;
    this.sessionCleanup = [
      session.on(Lane.INTERACTIVE, InteractiveKind.TERMINAL_OUT, (body) => {
        if (body.endpointId !== this.endpointId) return;
        this.onOutput(body.terminalId, body.incarnation, body.seq, body.message);
      }),
      session.on(Lane.INTERACTIVE, InteractiveKind.TERMINAL_RESET, (body) => {
        if (body.endpointId !== this.endpointId) return;
        this.onReset(body.terminalId, body.incarnation, body.seq, body.snapshot);
      }),
      session.onClose(() => {
        if (this.session === session) this.detach();
      }),
      session.onWritable(() => this.flushPendingInput()),
    ];
    this.flushPendingInput();
    void this.resume([...this.positions.keys()], true);
  }

  detach(): void {
    if (!this.session) return;
    this.session = null;
    this.resuming.clear();
    for (const cleanup of this.sessionCleanup.splice(0)) cleanup();
  }

  dispose(): void {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
    const port = this.port;
    this.port = null;
    port?.close();
    this.positions.clear();
    this.pendingInput = [];
    this.pendingInputBytes = 0;
    this.pendingResize.clear();
  }

  private onRendererMessage(raw: unknown): void {
    const parsed = TerminalInPortMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    const held = this.pendingInput.length > 0 || this.pendingResize.size > 0;
    if (this.session?.isOpen && !held && this.sendIn(message)) return;
    this.hold(message);
    if (held) this.flushPendingInput();
  }

  /**
   * Keep input the link could not take (down, or its queue full) to send in
   * order once it can. Acks are dropped: the host settles its own flow
   * control for a client that is away.
   */
  private hold(message: TerminalInPortMessage): void {
    if (message.type === "write") {
      const size = message.data.length;
      if (
        this.pendingInput.length >=
          (this.opts.maxPendingInputMessages ?? DEFAULT_MAX_PENDING_INPUT_MESSAGES) ||
        this.pendingInputBytes + size >
          (this.opts.maxPendingInputBytes ?? DEFAULT_MAX_PENDING_INPUT_BYTES)
      ) {
        return;
      }
      this.pendingInput.push(message);
      this.pendingInputBytes += size;
    } else if (message.type === "resize") {
      // Only the latest size per terminal matters; a new terminal past the cap
      // pushes out the one that has waited longest.
      this.pendingResize.delete(message.id);
      const cap = this.opts.maxPendingResizes ?? DEFAULT_MAX_PENDING_RESIZES;
      while (this.pendingResize.size >= cap) {
        const oldest = this.pendingResize.keys().next().value;
        if (oldest === undefined) break;
        this.pendingResize.delete(oldest);
      }
      this.pendingResize.set(message.id, message);
    }
  }

  /** False when the link refused it for now; true when sent or unsendable. */
  private sendIn(message: TerminalInPortMessage): boolean {
    const session = this.session;
    if (!session?.isOpen) return false;
    try {
      return (
        session.post({
          lane: Lane.INTERACTIVE,
          kind: InteractiveKind.TERMINAL_IN,
          body: { endpointId: this.endpointId, message },
        }) !== "refused"
      );
    } catch {
      // Unencodable: nothing the host could have used.
      return true;
    }
  }

  private flushPendingInput(): void {
    for (const [id, message] of [...this.pendingResize]) {
      if (!this.sendIn(message)) return;
      this.pendingResize.delete(id);
    }
    while (this.pendingInput.length > 0) {
      const message = this.pendingInput[0]!;
      if (!this.sendIn(message)) return;
      this.pendingInput.shift();
      this.pendingInputBytes -= message.data.length;
    }
  }

  private setPosition(id: string, position: Position): void {
    // Re-inserted so the map's order runs from least to most recently active.
    this.positions.delete(id);
    this.positions.set(id, position);
    const cap = this.opts.maxTrackedTerminals ?? DEFAULT_MAX_TRACKED_TERMINALS;
    while (this.positions.size > cap) {
      const oldest = this.positions.keys().next().value;
      if (oldest === undefined) break;
      this.positions.delete(oldest);
    }
  }

  private onOutput(id: string, incarnation: number, seq: number, raw: unknown): void {
    const parsed = TerminalOutPortMessageSchema.safeParse(raw);
    if (!parsed.success || parsed.data.id !== id) return;
    const message = parsed.data;
    // No renderer to take it: leave the position where it is, so the frame
    // is replayed (or the terminal reset) once a port arrives.
    const port = this.port;
    if (!port) return;
    if (message.type !== "data") {
      safePost(port, message);
      return;
    }
    const known = this.positions.get(id);
    if (known) {
      const next =
        known.incarnation === incarnation
          ? seq === known.lastSeq + 1
          : // A restarted PTY streams its new incarnation from the start.
            seq === 1;
      if (!next) {
        if (known.incarnation !== incarnation || seq > known.lastSeq + 1) {
          void this.resume([id], false);
        }
        return;
      }
    }
    if (!safePost(port, message)) return;
    this.setPosition(id, { incarnation, lastSeq: seq });
  }

  private onReset(
    id: string,
    incarnation: number,
    seq: number,
    snapshot: SerializedTerminalSnapshot | null
  ): void {
    // Undelivered, the position stays put and the next port asks for another reset.
    if (!safePost(this.port, { type: "reset", id, snapshot })) return;
    this.setPosition(id, { incarnation, lastSeq: seq });
  }

  private async resume(ids: string[], all: boolean): Promise<void> {
    const session = this.session;
    if (!session) return;
    const wanted = all ? ids : ids.filter((id) => !this.resuming.has(id));
    if (!all && wanted.length === 0) return;
    const reset = all && this.resetOwed;
    for (const id of wanted) this.resuming.add(id);
    const terminals: TerminalResumeRequest["terminals"] = wanted.flatMap((id) => {
      const p = this.positions.get(id);
      if (!p) return [];
      return [
        reset
          ? { id, incarnation: p.incarnation, lastSeq: p.lastSeq, reset: true }
          : { id, incarnation: p.incarnation, lastSeq: p.lastSeq },
      ];
    });
    // Always at least one call: the host starts streaming to a session only
    // once it has been told where the client is, even when that is nowhere.
    const chunks: TerminalResumeRequest["terminals"][] = [];
    for (let i = 0; i === 0 || i < terminals.length; i += MAX_RESUME_TERMINALS) {
      chunks.push(terminals.slice(i, i + MAX_RESUME_TERMINALS));
    }
    this.resumesInFlight++;
    try {
      const forget: string[] = [];
      let answered = true;
      await Promise.all(
        chunks.map(async (chunk) => {
          try {
            const result = TerminalResumeResultSchema.parse(
              await session.call(TERMINAL_RESUME_METHOD, {
                endpointId: this.endpointId,
                terminals: chunk,
              })
            );
            for (const t of result.terminals) if (t.outcome === "unknown") forget.push(t.id);
          } catch {
            // Without an answer there is no sequence to wait for: adopt whatever
            // arrives next rather than drop it as out of order forever.
            answered = false;
            for (const t of chunk) forget.push(t.id);
          }
        })
      );
      if (this.session === session) for (const id of wanted) this.resuming.delete(id);
      if (this.session !== session) return;
      if (reset && answered) this.resetOwed = false;
      for (const id of forget) this.positions.delete(id);
    } finally {
      this.resumesInFlight--;
    }
  }
}
