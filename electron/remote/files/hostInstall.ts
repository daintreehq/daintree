import path from "node:path";
import type { ClientEndpoint } from "../../ipc/endpoint.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { getDriveLeaseService } from "../../services/DriveLeaseService.js";
import { gitServiceCache } from "../../services/GitServiceCache.js";
import { projectStore } from "../../services/ProjectStore.js";
import type { LinkSession } from "../link/session.js";
import { getRemoteService, registerRemoteService } from "../runtime.js";
import { HostFileService, type HostFileEndpoint } from "./HostFileService.js";

declare module "../runtime.js" {
  interface RemoteServices {
    hostFileService: HostFileService;
  }
}

const ROOTS_TTL_MS = 5_000;
const rootsCache = new Map<string, { at: number; roots: Promise<string[]> }>();

/**
 * A project's folder plus the working trees git tracks for it. Bare records
 * and the filesystem root are never roots: either would grant far more than
 * the project.
 */
export async function projectFileRoots(projectId: string): Promise<string[]> {
  const project = projectStore.getProjectById(projectId);
  if (!project) return [];
  const cached = rootsCache.get(project.path);
  if (cached && Date.now() - cached.at < ROOTS_TTL_MS) return cached.roots;
  const roots = gitServiceCache
    .getGitService(project.path)
    .listWorktrees()
    .catch(() => [])
    .then((worktrees) => [
      project.path,
      ...worktrees
        .filter((worktree) => !worktree.bare && path.parse(worktree.path).root !== worktree.path)
        .map((worktree) => worktree.path)
        .filter((candidate) => candidate !== project.path),
    ]);
  rootsCache.set(project.path, { at: Date.now(), roots });
  return roots;
}

/**
 * Start serving remote windows' previews and downloads from this host.
 * Returns the service (attach endpoints to it as their links come up) and a
 * teardown.
 */
export function installHostFileService(): { service: HostFileService; dispose(): void } {
  const lease = getDriveLeaseService();
  const service = new HostFileService({
    rootsFor: projectFileRoots,
    isDriving: (projectId, endpoint) => lease.isDriving(projectId, endpoint),
  });
  const disposers = [
    registerRemoteService("hostFileService", service),
    getEndpointRegistry().onChange(() => service.onEndpointsChanged()),
    lease.onChange((state) => service.onLeaseChanged(state.projectId)),
  ];
  return {
    service,
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
      service.dispose();
      rootsCache.clear();
    },
  };
}

/** Boot hook: serve file calls for this endpoint on the link it rides now. */
export function attachHostFiles(session: LinkSession, endpoint: HostFileEndpoint): void {
  getRemoteService("hostFileService")?.attach(session, endpoint);
}

/**
 * CopyTree hook: a bundle was generated for a remote endpoint, so that endpoint
 * (and only it, for its project) may download that exact file.
 */
export function recordHostBundle(
  endpoint: Pick<ClientEndpoint, "endpointId" | "projectId">,
  filePath: string
): void {
  getRemoteService("hostFileService")?.recordBundle(endpoint, filePath);
}
