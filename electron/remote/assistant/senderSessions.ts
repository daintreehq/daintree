import type { LinkSession } from "../link/session.js";

/**
 * Which assistant sender each link session proved with `assistant.authenticate`.
 * The tools this host runs for a Shell (#13493), and the reads a v0.44 Shell
 * still makes of its retired exchanges (#13496), take the caller from here,
 * so neither ever takes a sender from anywhere but that proof. Kept per
 * transport, so a session gone takes its binding with it, and per session id
 * too, so a resumed transport of the same session can't prove another sender.
 */
export class SenderSessions {
  private readonly senders = new WeakMap<LinkSession, string>();
  private readonly bySessionId = new Map<string, string>();

  bind(session: LinkSession, senderId: string, sessionId?: string): void {
    this.senders.set(session, senderId);
    if (sessionId !== undefined) this.bySessionId.set(sessionId, senderId);
  }

  senderOf(session: LinkSession): string | undefined {
    return this.senders.get(session);
  }

  /** The sender a session id proved on any of its transports. */
  senderOfSessionId(sessionId: string): string | undefined {
    return this.bySessionId.get(sessionId);
  }

  /** A link session that ended for good: nothing can resume it. */
  forgetSessionId(sessionId: string): void {
    this.bySessionId.delete(sessionId);
  }
}
