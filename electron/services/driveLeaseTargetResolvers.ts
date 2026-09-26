import { promises as fs } from "node:fs";
import path from "node:path";
import { projectStore } from "./ProjectStore.js";
import { getOperationRegistry, normalizeOperationId } from "./operations/index.js";
import { probeGitCommonDir } from "../utils/gitUtils.js";
import { getPtyClient } from "../window/serviceRefs.js";
import type { LeaseTargetResolvers } from "./driveLeaseTargets.js";

/** A lookup that takes longer than this can't vouch for a call, which is then refused. */
const PATH_LOOKUP_TIMEOUT_MS = 5_000;
const GIT_PROBE_TIMEOUT_MS = 4_000;

interface ProjectRoot {
  id: string;
  root: string;
}

function normalize(p: string): string {
  return path.resolve(p).normalize("NFC");
}

/** The deepest registered project whose folder holds `candidate`. */
function containing(projects: readonly ProjectRoot[], candidate: string): string | null {
  let best: ProjectRoot | null = null;
  for (const project of projects) {
    const inside =
      candidate === project.root ||
      candidate.startsWith(
        project.root.endsWith(path.sep) ? project.root : project.root + path.sep
      );
    if (inside && (best === null || project.root.length > best.root.length)) best = project;
  }
  return best?.id ?? null;
}

async function realpathOrNull(p: string): Promise<string | null> {
  return fs.realpath(p).then(
    (real) => real.normalize("NFC"),
    () => null
  );
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The real spelling of `target`, and the deepest folder of it that exists:
 * a path not yet created (a folder `git init` will make) is judged by where it
 * would land. Any failure other than absence is a failed lookup, and throws.
 */
async function realSpelling(target: string): Promise<{ real: string; existing: string }> {
  let existing = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = (await fs.realpath(existing)).normalize("NFC");
      return { real: tail.length ? path.join(real, ...tail.reverse()) : real, existing: real };
    } catch (error) {
      const parent = path.dirname(existing);
      if (!isMissing(error) || parent === existing) throw error;
      tail.push(path.basename(existing));
      existing = parent;
    }
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("path ownership lookup timed out")),
      PATH_LOOKUP_TIMEOUT_MS
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Every registered project a path's changes land in: the one whose repository
 * owns it (a linked worktree's main working tree, the parent of git's common
 * dir), and the deepest one whose folder holds it. Both count, so a worktree
 * of B nested inside A's folder needs both leases, and a folder of a
 * registered sub-project inside a registered repository needs both too.
 * Compared by real path: git follows a symlink, so a link inside A that leads
 * into B changes B. Resolves [] only once git has said "not a repository" (or
 * named a repository no project owns) and no project folder holds the path;
 * a lookup that fails or stalls rejects instead.
 */
async function projectsForPathOwnership(
  projects: readonly ProjectRoot[],
  target: string
): Promise<string[]> {
  const { real, existing } = await realSpelling(target);
  const probe = await probeGitCommonDir(existing, GIT_PROBE_TIMEOUT_MS);
  if (probe.path === null && probe.failure === "transient") {
    throw new Error("git could not say which repository owns the path");
  }
  const realProjects = (
    await Promise.all(
      projects.map(async (project) => {
        const realRoot = await realpathOrNull(project.root);
        return realRoot ? { id: project.id, root: realRoot } : null;
      })
    )
  ).filter((project): project is ProjectRoot => project !== null);
  const owners = new Set<string>();
  // A project registered through a symlink has two spellings of its root,
  // and either may be the deeper holder: both count.
  const addOwners = (candidate: string) => {
    for (const id of [containing(projects, candidate), containing(realProjects, candidate)]) {
      if (id) owners.add(id);
    }
  };

  const commonDir = probe.path;
  if (commonDir && path.basename(commonDir) === ".git") {
    const mainRoot = normalize(path.dirname(commonDir));
    addOwners(mainRoot);
    const realMainRoot = await realpathOrNull(mainRoot);
    if (realMainRoot) addOwners(realMainRoot);
  }
  addOwners(real);
  return [...owners];
}

/** The lease gate's lookups, over this Host's project registry, pty-host and services. */
export function createLeaseTargetResolvers(): LeaseTargetResolvers {
  return {
    projectsForPath(target) {
      if (!path.isAbsolute(target)) throw new Error("a relative path names no project");
      const projects = projectStore
        .getAllProjectIdentities()
        .map((project) => ({ id: project.id, root: normalize(project.path) }));
      return withTimeout(projectsForPathOwnership(projects, normalize(target)));
    },

    projectForTerminal(terminalId) {
      const pty = getPtyClient();
      if (!pty) return null;
      const tracked = pty.getTerminalProjectId(terminalId);
      if (tracked) return tracked;
      return pty.getTerminalAsync(terminalId).then(
        (info) => info?.projectId || null,
        () => null
      );
    },

    projectsForOperation(opId) {
      const id = normalizeOperationId(opId);
      const projectId = id ? getOperationRegistry().get(id)?.projectId : null;
      return projectId ? [projectId] : [];
    },

    async projectsForDevPreviewPanel(panelId) {
      const { getDevPreviewProjectsForPanel } = await import("../ipc/handlers/devPreview.js");
      return getDevPreviewProjectsForPanel(panelId);
    },

    currentProjectId() {
      return projectStore.getCurrentProjectId();
    },

    async projectsForHelpSession(sessionId) {
      const { helpSessionService } = await import("./HelpSessionService.js");
      const projectId = helpSessionService.getSessionProjectId(sessionId);
      return projectId ? [projectId] : [];
    },
  };
}
