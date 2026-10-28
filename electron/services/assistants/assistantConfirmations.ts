import {
  AGENT_DIRECTORY_CONFIRMATIONS_MAX,
  type AgentDirectoryConfirmation,
} from "../../../shared/types/agentDirectory.js";

interface Waiting extends AgentDirectoryConfirmation {
  helpSessionId: string;
  /** The terminal the session ran when the call started. */
  terminalId: string;
  /** Calls under this key still waiting: two may share one to the millisecond. */
  count: number;
}

/**
 * The Daintree confirmations each assistant session's calls are waiting on
 * (#14165), as main announced them to the session's own panel: held from the
 * announcement to the call settling, and never past the call's own deadline,
 * so one whose settle was lost still goes. Read-only to everyone else — the
 * dialog in the session's pinned view is the only place one is answered.
 *
 * Bound to the session and the terminal it ran then: a session relaunched
 * onto a new terminal, or a new session, never inherits an old run's waits.
 */
export class AssistantConfirmations {
  private readonly byCall = new Map<string, Waiting>();

  begin(
    callKey: string,
    owner: { helpSessionId: string; terminalId: string },
    confirmation: AgentDirectoryConfirmation
  ): void {
    // Reclaimed here too, so waits whose settle never came don't wait for a reader.
    this.prune(confirmation.since);
    const held = this.byCall.get(callKey);
    if (held) {
      held.count += 1;
      return;
    }
    this.byCall.set(callKey, { ...owner, ...confirmation, count: 1 });
  }

  settle(callKey: string): void {
    const held = this.byCall.get(callKey);
    if (!held) return;
    held.count -= 1;
    if (held.count <= 0) this.byCall.delete(callKey);
  }

  read(
    owner: { helpSessionId: string; terminalId: string },
    now: number
  ): { waiting: AgentDirectoryConfirmation[]; omitted: number } {
    this.prune(now);
    const waiting: AgentDirectoryConfirmation[] = [];
    for (const entry of this.byCall.values()) {
      if (entry.helpSessionId !== owner.helpSessionId || entry.terminalId !== owner.terminalId) {
        continue;
      }
      const confirmation = {
        actionId: entry.actionId,
        since: entry.since,
        expiresAt: entry.expiresAt,
      };
      for (let i = 0; i < entry.count; i++) waiting.push(confirmation);
    }
    waiting.sort((a, b) => a.since - b.since);
    return {
      waiting: waiting.slice(0, AGENT_DIRECTORY_CONFIRMATIONS_MAX),
      omitted: Math.max(0, waiting.length - AGENT_DIRECTORY_CONFIRMATIONS_MAX),
    };
  }

  private prune(now: number): void {
    for (const [key, entry] of this.byCall) {
      if (entry.expiresAt <= now) this.byCall.delete(key);
    }
  }
}

let instance: AssistantConfirmations | null = null;

export function getAssistantConfirmations(): AssistantConfirmations {
  instance ??= new AssistantConfirmations();
  return instance;
}
