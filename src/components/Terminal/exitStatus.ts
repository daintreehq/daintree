export interface ExitStatusDisplay {
  /** The header badge, e.g. `[exit 1]` or `[exited]`. */
  badge: string;
  /** The line the agent indicator's tooltip shows for the same exit. */
  detail: string;
  /** Only a non-zero code is an observed failure and earns the error ink. */
  failed: boolean;
}

/**
 * One rule for how a pane's exit reads, shared by the header badge and the
 * agent indicator's tooltip so the two never disagree. A clean `0` is not a
 * failure, and an exit with no code (killed by a signal, or the code never
 * arrived) is only what we saw — neither gets the error colour.
 */
export function describeExitStatus(exitCode: number | null | undefined): ExitStatusDisplay {
  if (exitCode == null) {
    return { badge: "[exited]", detail: "Exited without an exit code", failed: false };
  }
  return { badge: `[exit ${exitCode}]`, detail: `Exit code: ${exitCode}`, failed: exitCode !== 0 };
}
