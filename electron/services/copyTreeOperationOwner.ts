/**
 * Who started a CopyTree run, captured when it starts. An id-less cancel stops
 * only the runs its caller owns: those of the caller's own workspace, and of
 * those only its own unless it drives that workspace (#16275).
 */
export interface CopyTreeOperationOwner {
  /** The project or scratch the run's view is bound to; null when it is bound to none. */
  readonly workspaceId: string | null;
  readonly endpointId: string | null;
}

export type CopyTreeOwnerPredicate = (owner: CopyTreeOperationOwner) => boolean;
