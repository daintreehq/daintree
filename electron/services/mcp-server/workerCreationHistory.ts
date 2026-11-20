import {
  assistantPrincipalOf,
  type AssistantOwnershipPrincipal,
  type OwnedResourceDraft,
  type OwnedResourceKind,
  type OwnedResourceRecord,
  type ResourceOwnershipLedger,
} from "./resourceOwnership.js";
import type { TerminalAdoptionLedger } from "./terminalAdoption.js";

const TERMINAL: OwnedResourceKind = "terminal";

/** Most runs whose creator is remembered; the oldest go first. */
export const WORKER_CREATION_HISTORY_MAX = 1024;

export interface WorkerCreation {
  /** The owner key the creation was recorded under in the ownership ledger. */
  owner: string;
  /** The launch generation of the run created; null when main tracked none. */
  launchGeneration: number | null;
  createdAt: number;
  /** Order of noting, for fencing a prune against creations a read could not have seen. */
  sequence: number;
  /**
   * The ledger record this creation was given, when it was given one. Whoever
   * holds that very record holds this run (#17919): a conversation's records
   * outlive the bearer that made them, so the owner key alone can't say it.
   */
  record?: OwnedResourceRecord;
}

/**
 * Whether `owner` created this run: noted under it, or holding the very record
 * the creation was given (#17919), as a resumed Assistant does for what its
 * conversation launched before. A record for a later run under the id is
 * another record, and a run with no creation is no one's.
 */
export function isCreationOf(
  creation: WorkerCreation | undefined,
  owner: string,
  heldRecord: OwnedResourceRecord | undefined
): boolean {
  if (creation === undefined) return false;
  return (
    creation.owner === owner || (creation.record !== undefined && creation.record === heldRecord)
  );
}

/**
 * Who created each terminal, for showing an assistant's work (#14166). The
 * ownership ledger can't say it: a revoked principal's records go with its
 * authority, which is exactly when "created by, no longer controlled" needs
 * saying. So creation is kept here, written at the same trusted point as the
 * ledger and from the same records, and read by nothing that authorizes.
 *
 * Keyed by terminal and launch generation: a later run under the same id is a
 * different run, and a record for the earlier one never names it. Held in
 * memory only, so a restart remembers nothing it could hand a successor.
 */
export class WorkerCreationHistory {
  private readonly byTerminal = new Map<string, WorkerCreation>();
  private sequence = 0;

  constructor(
    private readonly launchGenerationOf: (terminalId: string) => number | null = () => null,
    private readonly now: () => number = Date.now,
    private readonly max: number = WORKER_CREATION_HISTORY_MAX
  ) {}

  /**
   * Note the terminals among a trusted dispatch's created resources, with the
   * ledger records the dispatch was given for them, if any.
   */
  noteDrafts(
    owner: string,
    drafts: readonly OwnedResourceDraft[],
    recorded: readonly OwnedResourceRecord[] = []
  ): void {
    const records = new Map(
      recorded.filter((record) => record.kind === TERMINAL).map((record) => [record.id, record])
    );
    this.note(
      owner,
      drafts.filter((draft) => draft.kind === TERMINAL).map((draft) => draft.id),
      records
    );
  }

  /** Note the terminals `owner` was just recorded as creating. */
  note(
    owner: string,
    terminalIds: readonly string[],
    records?: ReadonlyMap<string, OwnedResourceRecord>
  ): void {
    for (const terminalId of terminalIds) {
      const record = records?.get(terminalId);
      this.byTerminal.delete(terminalId);
      this.byTerminal.set(terminalId, {
        owner,
        launchGeneration: this.launchGenerationOf(terminalId),
        createdAt: this.now(),
        sequence: ++this.sequence,
        ...(record !== undefined ? { record } : {}),
      });
      if (this.byTerminal.size > this.max) {
        this.byTerminal.delete(this.byTerminal.keys().next().value as string);
      }
    }
  }

  /** The creation of exactly this run, or undefined: never an earlier run's under its id. */
  get(terminalId: string, launchGeneration: number): WorkerCreation | undefined {
    const creation = this.byTerminal.get(terminalId);
    return creation !== undefined && creation.launchGeneration === launchGeneration
      ? creation
      : undefined;
  }

  /** Taken before a read of what runs; see {@link retainOnly}. */
  mark(): number {
    return this.sequence;
  }

  /**
   * Forget runs no longer alive, after a complete read of what runs. Only
   * creations noted before `mark` was taken: one noted while the read was in
   * flight may be missing from it without having gone.
   */
  retainOnly(liveTerminalIds: ReadonlySet<string>, mark: number): void {
    for (const [terminalId, creation] of [...this.byTerminal]) {
      if (creation.sequence <= mark && !liveTerminalIds.has(terminalId)) {
        this.byTerminal.delete(terminalId);
      }
    }
  }
}

/** Who created one exact run, and who holds authority over it now; assistants only. */
export interface RunAssistantWork {
  createdBy: AssistantOwnershipPrincipal | null;
  controlledBy: { principal: AssistantOwnershipPrincipal; basis: "creation" | "handover" } | null;
}

/**
 * Which assistant created one exact run, and which holds authority over it
 * now (#14166), read from the records the ownership checks themselves read.
 * Answers nothing those checks ask: showing who controls a worker is no way
 * to act on it.
 *
 * Control by creation needs the ledger's creator to be the one that created
 * this run: a ledger record outlives a respawn the person made under the id.
 * Control by hand-over needs the record to be of this run's launch.
 */
export function readRunAssistantWork(
  records: {
    workerCreations: WorkerCreationHistory;
    resourceOwnership: ResourceOwnershipLedger;
    terminalAdoption: TerminalAdoptionLedger;
  },
  terminalId: string,
  launchGeneration: number
): RunAssistantWork {
  const creation = records.workerCreations.get(terminalId, launchGeneration);
  const createdBy = creation === undefined ? null : assistantPrincipalOf(creation.owner);
  const holder = records.resourceOwnership.creatorOf("terminal", terminalId);
  const record = records.resourceOwnership.recordOf("terminal", terminalId);
  if (
    holder !== undefined &&
    creation !== undefined &&
    (creation.owner === holder || (creation.record !== undefined && creation.record === record))
  ) {
    // A conversation's record is controlled by its bound bearer, and by no one
    // while none is (#17919).
    const controller = records.resourceOwnership.controllerOf("terminal", terminalId);
    const principal = controller === undefined ? null : assistantPrincipalOf(controller);
    return { createdBy, controlledBy: principal ? { principal, basis: "creation" } : null };
  }
  const held = records.terminalAdoption.holderOf(terminalId);
  const principal =
    held !== undefined && held.record.launchGeneration === launchGeneration
      ? assistantPrincipalOf(held.owner)
      : null;
  return { createdBy, controlledBy: principal ? { principal, basis: "handover" } : null };
}
