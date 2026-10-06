import type { CopyTreeOptions, CopyTreeProgress, CopyTreeResult } from "../types/index.js";
import type { CopytreeWorkerClient } from "../workspace-host/CopytreeWorkerClient.js";

/**
 * CopyTree for a workspace root — the folder of a scratch or a worktree-less
 * project (#13210).
 *
 * Worktree copies run in their project's workspace host, found by path. A
 * scratch never gets a host at all, and `resolveHostForPath`'s sole-host
 * fallback would hand its root to an unrelated project's host, so roots run on
 * a worker thread owned by main instead. Imported lazily: the client pulls in
 * `CopyTreeService`, which main otherwise never loads, and the worker it spawns
 * is persistent — one per process, never one per copy.
 */
let clientPromise: Promise<CopytreeWorkerClient> | null = null;
const activeOperations = new Set<string>();

function getClient(): Promise<CopytreeWorkerClient> {
  clientPromise ??= import("../workspace-host/CopytreeWorkerClient.js").then(
    (module) => new module.CopytreeWorkerClient()
  );
  return clientPromise;
}

export async function generateWorkspaceRootContext(
  rootPath: string,
  options: CopyTreeOptions,
  onProgress: (progress: CopyTreeProgress) => void,
  outputPath: string
): Promise<CopyTreeResult> {
  const operationId = crypto.randomUUID();
  activeOperations.add(operationId);
  try {
    const client = await getClient();
    return await client.generate(rootPath, options, onProgress, operationId, outputPath);
  } finally {
    activeOperations.delete(operationId);
  }
}

export function cancelAllWorkspaceRootContext(): void {
  if (!clientPromise || activeOperations.size === 0) return;
  const ids = [...activeOperations];
  void clientPromise.then((client) => {
    for (const id of ids) client.cancel(id);
  });
}

/** Test-only: forget the lazily created client. */
export function _resetWorkspaceRootCopyTreeForTests(): void {
  clientPromise = null;
  activeOperations.clear();
}
