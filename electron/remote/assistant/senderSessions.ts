import type { LinkSession } from "../link/session.js";

/**
 * Which assistant sender each link session proved with `assistant.authenticate`.
 * The host's exchange calls and the tools it runs for a Shell (#13493) read the
 * caller from here, so neither ever takes a sender from anywhere but that proof.
 * Keyed on the transport, so a session gone takes its binding with it.
 */
export class SenderSessions {
  private readonly senders = new WeakMap<LinkSession, string>();

  bind(session: LinkSession, senderId: string): void {
    this.senders.set(session, senderId);
  }

  senderOf(session: LinkSession): string | undefined {
    return this.senders.get(session);
  }
}
