import {
  assistantPrincipalOf,
  type AssistantOwnershipPrincipal,
  type ResourceOwnershipLedger,
} from "./resourceOwnership.js";
import type { TerminalAdoptionLedger } from "./terminalAdoption.js";

/** Most runs whose creator is remembered; the oldest go first. */
export const WORKER_CREATION_HISTORY_MAX = 1024;

export interface WorkerCreation {
  /** The owner key the creation was recorded under in the ownership ledger. */
  owner: string;
  /** The launch generation of the run created; null when main tracked none. */
  launchGeneration: number | null;
  createdAt: number;
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

  constructor(
    private readonly launchGenerationOf: (terminalId: string) => number | null = () => null,
    private readonly now: () => number = Date.now,
    private readonly max: number = WORKER_CREATION_HISTORY_MAX
  ) {}

  /** Note the terminals `owner` was just recorded as creating. */
  note(owner: string, terminalIds: readonly string[]): void {
    for (const terminalId of terminalIds) {
      this.byTerminal.delete(terminalId);
      this.byTerminal.set(terminalId, {
        owner,
        launchGeneration: this.launchGenerationOf(terminalId),
        createdAt: this.now(),
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

  /** Forget runs no longer alive, after a complete read of what runs. */
  retainOnly(liveTerminalIds: ReadonlySet<string>): void {
    for (const terminalId of [...this.byTerminal.keys()]) {
      if (!liveTerminalIds.has(terminalId)) this.byTerminal.delete(terminalId);
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
  const owner = records.resourceOwnership.creatorOf("terminal", terminalId);
  if (owner !== undefined && creation?.owner === owner) {
    const principal = assistantPrincipalOf(owner);
    return { createdBy, controlledBy: principal ? { principal, basis: "creation" } : null };
  }
  const held = records.terminalAdoption.holderOf(terminalId);
  const principal =
    held !== undefined && held.record.launchGeneration === launchGeneration
      ? assistantPrincipalOf(held.owner)
      : null;
  return { createdBy, controlledBy: principal ? { principal, basis: "handover" } : null };
}
