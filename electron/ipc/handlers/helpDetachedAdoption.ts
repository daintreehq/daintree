import type { HelpAdoptResult } from "../../../shared/types/ipc/help.js";
import type { ClientEndpoint } from "../endpoint.js";

type Adopted = Extract<HelpAdoptResult, { status: "adopted" }>;

export interface DetachedAdoptionDeps {
  /** The projects with an assistant running with no view. */
  detachedProjects(): readonly string[];
  /** The views attached to a project, this machine's own and other machines'. */
  endpointsFor(projectId: string): readonly ClientEndpoint[];
  /** The endpoint that drives the project now, or null when none attached does. */
  drivingEndpointId(projectId: string): string | null;
  detachedSlots(projectId: string): number[];
  adopt(projectId: string, slot: number, endpoint: ClientEndpoint): Promise<HelpAdoptResult>;
  /** The view closed or moved while it took the lane over: hand the lane back. */
  release(endpoint: ClientEndpoint, projectId: string, adopted: Adopted): Promise<void>;
  adopted(endpoint: ClientEndpoint, projectId: string, slot: number, adopted: Adopted): void;
}

function drives(deps: DetachedAdoptionDeps, endpoint: ClientEndpoint, projectId: string): boolean {
  return (
    !endpoint.isClosed() &&
    endpoint.projectId === projectId &&
    deps.drivingEndpointId(projectId) === endpoint.endpointId
  );
}

/**
 * Hands each project's detached assistants (#13360) to the view that drives
 * the project, as soon as there is one (#13389): another machine's, or since
 * #13511 one of this machine's own windows. Only the driver, as the
 * renderer's own take-over is driver-only: a watching view would pin the
 * assistant where its tool calls can't act, and keep it from the driver.
 * Each lane is re-checked before it is taken, since the view can close, move
 * or lose the lease while an earlier one is out.
 */
export async function adoptForReturningViews(deps: DetachedAdoptionDeps): Promise<void> {
  for (const projectId of deps.detachedProjects()) {
    const driving = deps.drivingEndpointId(projectId);
    const endpoint = deps.endpointsFor(projectId).find((view) => view.endpointId === driving);
    if (!endpoint || !drives(deps, endpoint, projectId)) continue;
    for (const slot of deps.detachedSlots(projectId)) {
      if (!drives(deps, endpoint, projectId)) break;
      const result = await deps.adopt(projectId, slot, endpoint);
      if (result.status !== "adopted") continue;
      if (endpoint.isClosed() || endpoint.projectId !== projectId) {
        await deps.release(endpoint, projectId, result);
        break;
      }
      deps.adopted(endpoint, projectId, slot, result);
    }
  }
}

/**
 * Runs `adoptForReturningViews` whenever who is attached or who drives
 * changes, one pass at a time: a change during a pass queues one more.
 */
export function installDetachedAdoption(
  deps: DetachedAdoptionDeps & {
    onChange(listener: () => void): () => void;
    onFailure(error: unknown): void;
  }
): () => void {
  let running = false;
  let again = false;
  let disposed = false;
  const run = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await adoptForReturningViews(deps);
      } while (again && !disposed);
    } catch (error) {
      deps.onFailure(error);
    } finally {
      running = false;
    }
  };
  const off = deps.onChange(() => {
    if (!disposed) void run();
  });
  return () => {
    disposed = true;
    off();
  };
}
