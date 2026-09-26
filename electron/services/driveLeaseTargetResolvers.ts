import { promises as fs } from "node:fs";
import path from "node:path";
import { projectStore } from "./ProjectStore.js";
import { getOperationRegistry, normalizeOperationId } from "./operations/index.js";
import { getGitCommonDir } from "../utils/gitUtils.js";
import { getPtyClient } from "../window/serviceRefs.js";
import type { LeaseTargetResolvers } from "./driveLeaseTargets.js";

/** A lookup that takes longer than this can't vouch for a call, which is then refused. */
const PATH_LOOKUP_TIMEOUT_MS = 5_000;

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

/**
 * The project a linked worktree elsewhere on disk, or a folder spelled through
 * a symlink, belongs to: its repository's main working tree (the parent of
 * git's common dir), and every spelling compared by real path.
 */
async function projectForPathSlow(
  projects: readonly ProjectRoot[],
  target: string
): Promise<string | null> {
  const commonDir = await getGitCommonDir(target, { logErrors: false }).catch(() => null);
  const mainRoot =
    commonDir && path.basename(commonDir) === ".git" ? normalize(path.dirname(commonDir)) : null;
  if (mainRoot) {
    const byRoot = containing(projects, mainRoot);
    if (byRoot) return byRoot;
  }
  const spellings = [target, ...(mainRoot ? [mainRoot] : [])];
  const reals = (await Promise.all(spellings.map(realpathOrNull))).filter(
    (real): real is string => real !== null
  );
  const realProjects = (
    await Promise.all(
      projects.map(async (project) => {
        const real = await realpathOrNull(project.root);
        return real ? { id: project.id, root: real } : null;
      })
    )
  ).filter((project): project is ProjectRoot => project !== null);
  for (const real of reals) {
    const found = containing(projects, real) ?? containing(realProjects, real);
    if (found) return found;
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), PATH_LOOKUP_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The lease gate's lookups, over this Host's project registry, pty-host and services. */
export function createLeaseTargetResolvers(): LeaseTargetResolvers {
  return {
    projectForPath(target) {
      if (!path.isAbsolute(target)) return null;
      const projects = projectStore
        .getAllProjectIdentities()
        .map((project) => ({ id: project.id, root: normalize(project.path) }));
      const normalized = normalize(target);
      // Lexical containment alone would trust a symlink inside one project
      // that points into another: git follows it, so the real path decides.
      return withTimeout(
        realpathOrNull(normalized).then((real) => {
          const direct = containing(projects, real ?? normalized);
          return direct ?? projectForPathSlow(projects, real ?? normalized);
        }),
        null
      );
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
