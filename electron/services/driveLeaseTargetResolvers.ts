import { promises as fs } from "node:fs";
import path from "node:path";
import { projectStore } from "./ProjectStore.js";
import { getOperationRegistry, normalizeOperationId } from "./operations/index.js";
import { probeGitCommonDir } from "../utils/gitUtils.js";
import { getPtyClient } from "../window/serviceRefs.js";
import type { LeaseTargetResolvers } from "./driveLeaseTargets.js";
import type { TerminalRecord } from "../ipc/channelRemoteScope.js";

/** A lookup that takes longer than this can't vouch for a call, which is then refused. */
const PATH_LOOKUP_TIMEOUT_MS = 5_000;
const GIT_PROBE_TIMEOUT_MS = 4_000;

interface ProjectRoot {
  id: string;
  root: string;
}

/**
 * One spelling for names the file system treats as one. macOS does not tell
 * NFC from NFD; Linux keeps them as two different folders, so there the bytes
 * are compared as they are.
 */
function unicodeForm(p: string): string {
  return process.platform === "darwin" ? p.normalize("NFC") : p;
}

function normalize(p: string): string {
  return unicodeForm(path.resolve(p));
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
    (real) => unicodeForm(real),
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
      const real = unicodeForm(await fs.realpath(existing));
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
  // git needs a folder to run in: a path naming a file is asked about from its own folder.
  const probeDir = (await fs.stat(existing)).isDirectory() ? existing : path.dirname(existing);
  const probe = await probeGitCommonDir(probeDir, GIT_PROBE_TIMEOUT_MS);
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
  } else if (commonDir) {
    // A repository made with `--separate-git-dir` keeps its git directory
    // away from its files, and nothing in it says where they are: the project
    // that shares it is found by asking each its own (cached) common dir.
    const realCommon = await realpathOrNull(commonDir);
    const shared = await Promise.all(
      projects.map(async (project) => {
        const own = await probeGitCommonDir(project.root, GIT_PROBE_TIMEOUT_MS);
        if (own.path === null) return null;
        const realOwn = await realpathOrNull(own.path);
        return realOwn !== null && realOwn === realCommon ? project.id : null;
      })
    );
    for (const id of shared) if (id) owners.add(id);
  }
  addOwners(real);
  return [...owners];
}

/** The lease gate's lookups, over this Host's project registry, pty-host and services. */
/**
 * What the host knows of a terminal for scoping a remote view's reads: gone,
 * or the project it belongs to (null for one with none). A lookup that fails
 * answers "no project", which no view may read.
 */
export function describeTerminalForScope(
  terminalId: string
): TerminalRecord | Promise<TerminalRecord> {
  const pty = getPtyClient();
  if (!pty) return "missing";
  const tracked = pty.getTerminalProjectId(terminalId);
  if (tracked) return { projectId: tracked };
  // Strict: a lookup that times out throws rather than reading as "no such terminal".
  return pty.getTerminalAsync(terminalId, undefined, { strict: true }).then(
    (info): TerminalRecord => (info ? { projectId: info.projectId || null } : "missing"),
    (): TerminalRecord => ({ projectId: null })
  );
}

export function createLeaseTargetResolvers(): LeaseTargetResolvers {
  return {
    projectsForPath(target) {
      if (!path.isAbsolute(target)) throw new Error("a relative path names no project");
      const projects = projectStore
        .getAllProjectIdentities()
        .map((project) => ({ id: project.id, root: normalize(project.path) }));
      // The caller's own spelling, not a lexical tidy-up of it: "A/link/.." is
      // wherever the link leads, up one, which is where the handler's git runs.
      return withTimeout(projectsForPathOwnership(projects, unicodeForm(target)));
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
