import { Lane } from "../link/frames.js";
import { InteractiveKind } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import { safePost, type PortLike } from "./ports.js";
import {
  TERMINAL_RESUME_METHOD,
  TerminalInPortMessageSchema,
  TerminalOutPortMessageSchema,
  TerminalResumeResultSchema,
  type TerminalInPortMessage,
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
 */

export interface ClientTerminalRelayOptions {
  endpointId: string;
  /**
   * Hand the view a fresh port (token first, then the port) and return this
   * side's end, or null when the view cannot take one right now.
   */
  openRendererPort(): PortLike | null;
  /** Input typed while the link is down is held up to this many bytes. */
  maxPendingInputBytes?: number;
}

interface Position {
  incarnation: number;
  lastSeq: number;
}

const DEFAULT_MAX_PENDING_INPUT_BYTES = 64 * 1024;

export class ClientTerminalRelay {
  readonly endpointId: string;

  private readonly opts: ClientTerminalRelayOptions;
  private port: PortLike | null = null;
  private session: LinkSession | null = null;
  private sessionCleanup: (() => void)[] = [];
  private readonly positions = new Map<string, Position>();
  private readonly resuming = new Set<string>();
  private pendingInput: Extract<TerminalInPortMessage, { type: "write" }>[] = [];
  private pendingInputBytes = 0;
  private readonly pendingResize = new Map<
    string,
    Extract<TerminalInPortMessage, { type: "resize" }>
  >();
  private disposed = false;

  constructor(options: ClientTerminalRelayOptions) {
    this.opts = options;
    this.endpointId = options.endpointId;
  }

  get isAttached(): boolean {
    return this.session !== null;
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
    this.port = port;
    port.onMessage((message) => {
      if (this.port === port) this.onRendererMessage(message);
    });
    port.onClose(() => {
      if (this.port === port) this.port = null;
    });
    previous?.close();
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
        this.pendingInputBytes + size >
        (this.opts.maxPendingInputBytes ?? DEFAULT_MAX_PENDING_INPUT_BYTES)
      ) {
        return;
      }
      this.pendingInput.push(message);
      this.pendingInputBytes += size;
    } else if (message.type === "resize") {
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

  private onOutput(id: string, incarnation: number, seq: number, raw: unknown): void {
    const parsed = TerminalOutPortMessageSchema.safeParse(raw);
    if (!parsed.success || parsed.data.id !== id) return;
    const message = parsed.data;
    if (message.type !== "data") {
      safePost(this.port, message);
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
    this.positions.set(id, { incarnation, lastSeq: seq });
    safePost(this.port, message);
  }

  private onReset(id: string, incarnation: number, seq: number, snapshot: string | null): void {
    this.positions.set(id, { incarnation, lastSeq: seq });
    safePost(this.port, { type: "reset", id, snapshot });
  }

  private async resume(ids: string[], all: boolean): Promise<void> {
    const session = this.session;
    if (!session) return;
    const wanted = all ? ids : ids.filter((id) => !this.resuming.has(id));
    if (!all && wanted.length === 0) return;
    for (const id of wanted) this.resuming.add(id);
    const terminals = wanted.flatMap((id) => {
      const p = this.positions.get(id);
      return p ? [{ id, incarnation: p.incarnation, lastSeq: p.lastSeq }] : [];
    });
    let forget: string[];
    try {
      const result = TerminalResumeResultSchema.parse(
        await session.call(TERMINAL_RESUME_METHOD, { endpointId: this.endpointId, terminals })
      );
      forget = result.terminals.filter((t) => t.outcome === "unknown").map((t) => t.id);
    } catch {
      // Without an answer there is no sequence to wait for: adopt whatever
      // arrives next rather than drop it as out of order forever.
      forget = wanted;
    } finally {
      if (this.session === session) for (const id of wanted) this.resuming.delete(id);
    }
    if (this.session !== session) return;
    for (const id of forget) this.positions.delete(id);
  }
}
