import fs from "node:fs/promises";
import path from "node:path";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { contextDir } from "../../services/copyTreeOutputFile.js";
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

const BUNDLE_MAX_AGE_MS = 10 * 60 * 1000;

function bundlePrefix(root: string): string {
  // Mirrors buildContextFileName's project segment.
  const segment = path
    .basename(root)
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return `${segment || "project"}-`;
}

/**
 * A CopyTree bundle for a remote window's "copy as file". The context folder
 * is shared by every project, so a bundle is granted only to a project whose
 * folder or worktree it was generated from (by its name) and only while it is
 * fresh — not the whole folder.
 */
export async function grantContextBundle(
  projectId: string,
  candidate: string,
  dir: string = contextDir()
): Promise<string | null> {
  if (path.dirname(path.normalize(candidate)) !== path.normalize(dir)) return null;
  const name = path.basename(candidate);
  const roots = await projectFileRoots(projectId);
  if (!roots.some((root) => name.startsWith(bundlePrefix(root)))) return null;
  const stat = await fs.lstat(candidate).catch(() => null);
  if (!stat?.isFile() || Date.now() - stat.mtimeMs > BUNDLE_MAX_AGE_MS) return null;
  const realDir = await fs.realpath(dir).catch(() => null);
  return realDir ? path.join(realDir, name) : null;
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
    grantDownload: grantContextBundle,
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
