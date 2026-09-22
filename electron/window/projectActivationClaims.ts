/**
 * Projects a window has committed to activating whose view the window's manager
 * hasn't registered yet (#12596) — the guard passed, but repository checks, the
 * pending persist and the manager's switch queue still lie between that and the
 * manager's inventory showing it. Without this, two windows asking for the same
 * project in that gap would both find no owner and both build a view.
 *
 * One entry per claim rather than per project: the same window can have two
 * activations of a project in flight (a menu open landing on an IPC switch), and
 * the first to settle must not drop the other's protection.
 *
 * A leaf module with no Electron imports, so both owner lookups read it: the
 * in-app one (`projectOwnership.ts`) and the external-open world snapshot
 * (`windowOpenState.ts`), which sees a claimed window as having an open in flight.
 */
const pendingActivations = new Map<string, Set<{ windowId: number }>>();

/**
 * Claim `projectId` for `windowId` until the returned release runs. Taken
 * synchronously with the owner check and released once the window's manager has
 * the view (or the swap failed), with a `finally` behind that: a claim that
 * outlived its activation would send later requests for the project to a
 * window that may no longer have it. Releasing twice is harmless.
 */
export function claimProjectActivation(
  projectId: string,
  windowId: number | undefined
): () => void {
  if (windowId === undefined) return () => {};
  const claim = { windowId };
  let claims = pendingActivations.get(projectId);
  if (!claims) {
    claims = new Set();
    pendingActivations.set(projectId, claims);
  }
  claims.add(claim);
  return () => {
    const current = pendingActivations.get(projectId);
    if (!current?.delete(claim)) return;
    if (current.size === 0) pendingActivations.delete(projectId);
  };
}

export function hasPendingActivation(projectId: string, windowId: number): boolean {
  for (const claim of pendingActivations.get(projectId) ?? []) {
    if (claim.windowId === windowId) return true;
  }
  return false;
}

/** The projects `windowId` has a claimed activation in flight for, each once. */
export function getPendingActivationProjectIds(windowId: number): string[] {
  const ids: string[] = [];
  for (const [projectId, claims] of pendingActivations) {
    for (const claim of claims) {
      if (claim.windowId === windowId) {
        ids.push(projectId);
        break;
      }
    }
  }
  return ids;
}
