import { principalOwnerKey } from "./resourceOwnership.js";

/**
 * Terminals the user handed to an orchestrating agent pane (#12490).
 *
 * The ownership ledger answers "did this pane create it?", and only a trusted
 * creation result may write to it. That property is what makes it an
 * authorization boundary, so handing a terminal over is kept out of it
 * entirely: an adoption is a separate record, written only from a user gesture
 * in the renderer, and read by the non-destructive `*Owned` tools as a second
 * source of authority. `terminal.closeOwned` and `worktree.deleteOwned` never
 * read it — handing over a conversation is not handing over the right to
 * delete it.
 *
 * Three properties keep it from widening into something the user did not ask
 * for:
 *
 * 1. **Held by the pane's bearer principal**, never a transport session. A
 *    reconnect keeps the adoption because the bearer is the same pane (#12487);
 *    a relaunch mints a new bearer with a new principal, and the old
 *    principal's revocation drops the adoption in the same step, so it never
 *    silently follows a restart.
 * 2. **One driver per terminal.** A second pane asking for a terminal already
 *    handed to another is refused rather than transferred: two agents typing
 *    into one composer is the failure #11875 exists to prevent.
 * 3. **It ends with either pane.** The orchestrator's exit revokes its bearer;
 *    the handed-over terminal's exit drops its record here.
 */
export interface TerminalAdoptionRecord {
  terminalId: string;
  /** The pane the terminal was handed to — the orchestrator's own panel id. */
  orchestratorPaneId: string;
  /**
   * The workspace the terminal lives in, where main could resolve it. Supplies
   * a reveal's destination the way an ownership record's does.
   */
  workspaceId?: string;
  adoptedAt: number;
}

export type TerminalAdoptionOutcome =
  { ok: true; record: TerminalAdoptionRecord } | { ok: false; heldByPaneId: string };

interface StoredAdoption {
  record: TerminalAdoptionRecord;
  owner: string;
}

export class TerminalAdoptionLedger {
  private readonly byTerminal = new Map<string, StoredAdoption>();
  private readonly listeners = new Set<() => void>();

  /**
   * Hand `terminalId` to the pane whose bearer resolved to `principalId`.
   * Idempotent for the pane already holding it; refused for any other.
   */
  adopt(params: {
    terminalId: string;
    orchestratorPaneId: string;
    principalId: string;
    workspaceId?: string;
    now?: number;
  }): TerminalAdoptionOutcome {
    const owner = principalOwnerKey(params.principalId);
    const existing = this.byTerminal.get(params.terminalId);
    if (existing !== undefined) {
      if (existing.owner === owner) return { ok: true, record: existing.record };
      return { ok: false, heldByPaneId: existing.record.orchestratorPaneId };
    }
    const record: TerminalAdoptionRecord = {
      terminalId: params.terminalId,
      orchestratorPaneId: params.orchestratorPaneId,
      ...(params.workspaceId !== undefined ? { workspaceId: params.workspaceId } : {}),
      adoptedAt: params.now ?? Date.now(),
    };
    this.byTerminal.set(params.terminalId, { record, owner });
    this.emitChange();
    return { ok: true, record };
  }

  /**
   * The adoption that gives `owner` authority over `terminalId`, or
   * `undefined`. `owner` is the value `ResourceOwnershipLedger.ownerOf`
   * resolved for the calling session, so a session no pane bearer bound — an
   * api-key client — can never match: its owner is its own session id.
   */
  get(owner: string, terminalId: string): TerminalAdoptionRecord | undefined {
    const stored = this.byTerminal.get(terminalId);
    return stored !== undefined && stored.owner === owner ? stored.record : undefined;
  }

  /** Who is driving `terminalId`, whoever that is. */
  getForTerminal(terminalId: string): TerminalAdoptionRecord | undefined {
    return this.byTerminal.get(terminalId)?.record;
  }

  /** Drop the adoption of one terminal — the user took it back, or it exited. */
  release(terminalId: string): boolean {
    if (!this.byTerminal.delete(terminalId)) return false;
    this.emitChange();
    return true;
  }

  /**
   * Drop everything a revoked bearer was handed, in the same step as the
   * revocation itself, so nothing is dispatched under it afterwards.
   */
  revokePrincipal(principalId: string): void {
    const owner = principalOwnerKey(principalId);
    let changed = false;
    for (const [terminalId, stored] of this.byTerminal) {
      if (stored.owner !== owner) continue;
      this.byTerminal.delete(terminalId);
      changed = true;
    }
    if (changed) this.emitChange();
  }

  list(): TerminalAdoptionRecord[] {
    return [...this.byTerminal.values()].map((stored) => stored.record);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error("[MCP] Terminal adoption listener threw:", err);
      }
    }
  }
}
