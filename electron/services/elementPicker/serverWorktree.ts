import path from "node:path";
import type { PortListener } from "../../remote/ports/listenerScan.js";
import { isStrictlyInside } from "./containment.js";

/**
 * Which of a project's worktrees a page's server runs from, as far as this
 * machine shows: the working directory of every process listening on the
 * page's port, the same thing a dev preview's own `cwd` tells it. A browser
 * panel records where it was opened, not where the server runs, and a terminal
 * records where it was opened, not where a process later `cd`'d to, so the
 * process itself is asked.
 *
 * `unknown` is the common answer and carries no claim: nothing listening, a
 * listener this machine can't account for, one running outside every worktree
 * of the project (another project's, a container's, a global tool's), or
 * listeners on the one port that disagree.
 */
export type ServerWorktreeVerdict =
  { status: "unknown" } | { status: "worktree"; worktreeId: string };

export interface ServerWorktreeDeps {
  findListeners(port: number): Promise<PortListener[] | null>;
  /** The path with every link resolved; null when it doesn't resolve. */
  canonical(target: string): Promise<string | null>;
  /** Whether a directory holds a `.git` of its own: another checkout starts there. */
  isCheckoutRoot(dir: string): Promise<boolean>;
}

const UNKNOWN: ServerWorktreeVerdict = { status: "unknown" };

/**
 * The port a page is served from on this machine, when its address says the
 * server is here: a loopback name or address. A `.local`, `.test` or private
 * address may be another machine, or a proxy in front of one, so it names no
 * listener worth asking about.
 */
export function localServerPort(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "[::]" ||
    host === "0.0.0.0" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!loopback) return null;
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
}

/** The worktree holding `target`, the innermost when one is checked out inside another. */
function innermost(
  worktrees: ReadonlyArray<{ id: string; root: string }>,
  target: string
): { id: string; root: string } | null {
  let best: { id: string; root: string } | null = null;
  for (const worktree of worktrees) {
    if (worktree.root !== target && !isStrictlyInside(worktree.root, target)) continue;
    if (best === null || worktree.root.length > best.root.length) best = worktree;
  }
  return best;
}

/** Whether `target`, inside `root`, sits in a checkout of its own between the two. */
async function nestedCheckout(
  root: string,
  target: string,
  deps: ServerWorktreeDeps
): Promise<boolean> {
  for (let dir = target; dir !== root; dir = path.dirname(dir)) {
    if (path.dirname(dir) === dir) return true;
    if (await deps.isCheckoutRoot(dir).catch(() => true)) return true;
  }
  return false;
}

/**
 * @param worktrees the project's worktrees with canonical roots, so a listener's
 *   canonical cwd compares like for like.
 */
export async function findServerWorktree(
  port: number,
  worktrees: ReadonlyArray<{ id: string; root: string }>,
  deps: ServerWorktreeDeps
): Promise<ServerWorktreeVerdict> {
  const listeners = await deps.findListeners(port).catch(() => null);
  if (listeners === null || listeners.length === 0) return UNKNOWN;
  let found: string | null = null;
  // Every socket on the port has to be placed, and all in one worktree:
  // `localhost` can reach either address family, so the unplaced one may be
  // the one serving the page.
  for (const listener of listeners) {
    if (listener.cwd === null || !path.isAbsolute(listener.cwd)) return UNKNOWN;
    const cwd = await deps.canonical(listener.cwd).catch(() => null);
    if (cwd === null) return UNKNOWN;
    const worktree = innermost(worktrees, cwd);
    if (worktree === null) return UNKNOWN;
    // A checkout nested inside the worktree, another project's or a
    // submodule, is not the worktree's own source.
    if (await nestedCheckout(worktree.root, cwd, deps)) return UNKNOWN;
    if (found !== null && found !== worktree.id) return UNKNOWN;
    found = worktree.id;
  }
  return found === null ? UNKNOWN : { status: "worktree", worktreeId: found };
}
