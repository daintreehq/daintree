import type { BuiltinPluginFsApi } from "../../../../shared/types/plugin.js";
import type { SupportVerdict } from "../shared/protocol.js";
import { SourceTracker } from "./tracker.js";

/**
 * One open source workspace: a worktree, the app inside it, and everything
 * main holds on its behalf. Every handler after `workspaceOpen` names its
 * workspace by session id; nothing consults the active project or worktree.
 */
export interface Workspace {
  readonly id: string;
  readonly projectId: string;
  readonly worktreeId: string;
  /** The dev preview panel whose builder opened this workspace; its pushes go there. */
  readonly previewPanelId: string;
  readonly worktreePath: string;
  readonly appRoot: string;
  /**
   * What the bundled compiler was tested against for this app. Carried, never
   * consulted: no path here narrows what the workspace offers on the strength
   * of it — the view reports it so a person and an agent can weigh a traced
   * range themselves.
   */
  readonly support: SupportVerdict;
  /** Filesystem authority pinned to this workspace's project and worktree, not to focus. */
  readonly fs: BuiltinPluginFsApi;
  /**
   * Aborted when the workspace is released, whether the view closed it or the
   * LRU did. Every scan this workspace starts carries the signal, so a close
   * stops the walk between directories and rejects the read in flight instead
   * of letting a project scan finish for a panel that is gone.
   *
   * What it does not interrupt: a `JSON.parse`, a route-tree parse or a Svelte
   * parse already running. Those are synchronous, and the byte caps rather
   * than the signal are what keep them short.
   */
  readonly lifetime: AbortController;
  readonly tracker: SourceTracker;
}

/**
 * Concurrent worktree scans, across every open workspace. A scan is mostly
 * waiting on the filesystem, but each one holds a walk queue and parses what
 * it reads in main, so they are let through a few at a time rather than one
 * per renderer request. Sized to keep a handful of previews responsive without
 * turning a monorepo open into a burst of tree walks.
 */
export const MAX_CONCURRENT_SCANS = 4;

/**
 * Scans waiting for a slot. Past this the request is refused rather than
 * queued: a renderer whose three-second timeout has already fired will ask
 * again, and a queue that grows faster than it drains only serves answers
 * nobody is waiting for any more.
 */
export const MAX_QUEUED_SCANS = 32;

/** Thrown when the queue is full, so the caller reports a retry rather than a failure. */
export function scanOverloaded(): Error {
  return new Error("SCAN_BUSY: too many worktree scans are already running; try again");
}

/**
 * Bounds how many worktree scans run at once, and collapses identical ones.
 *
 * Deduplication is keyed by the caller: two dev previews asking whether the
 * same worktree holds a SvelteKit app want the same answer, and running that
 * walk twice is pure cost. Anything whose answer is caller-specific passes no
 * key and simply queues.
 */
export class ScanGate {
  private running = 0;
  private queued = 0;
  private readonly waiting: Array<{ resolve: () => void; reject: (reason: unknown) => void }> = [];
  private readonly inFlight = new Map<string, Promise<unknown>>();

  async run<T>(key: string | null, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (key !== null) {
      const existing = this.inFlight.get(key) as Promise<T> | undefined;
      if (existing) return existing;
    }
    const started = (async () => {
      await this.acquire(signal);
      try {
        return await work();
      } finally {
        this.release();
      }
    })();
    if (key !== null) {
      this.inFlight.set(key, started);
      // Cleared however it ends, including a refusal from a full queue — a
      // rejected entry left behind would answer every later caller with the
      // same failure.
      void started.finally(() => this.inFlight.delete(key)).catch(() => {});
    }
    return started;
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.running < MAX_CONCURRENT_SCANS) {
      this.running += 1;
      return;
    }
    if (this.queued >= MAX_QUEUED_SCANS) throw scanOverloaded();
    this.queued += 1;
    try {
      // The waiter inherits the slot the releasing scan held, so `running`
      // never dips between the two and a fresh caller cannot slip in past the
      // cap. A waiter whose workspace closes leaves the queue instead of
      // holding capacity for a scan nobody will read.
      let detach: (() => void) | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          const waiter = { resolve, reject };
          this.waiting.push(waiter);
          if (!signal) return;
          const onAbort = () => {
            const index = this.waiting.indexOf(waiter);
            if (index === -1) return;
            this.waiting.splice(index, 1);
            reject(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          // The signal is the workspace lifetime, not this scan's: a waiter
          // handed its slot normally must take its listener with it, or every
          // queued scan leaves one behind for the life of the workspace.
          detach = () => {
            signal.removeEventListener("abort", onAbort);
          };
        });
      } finally {
        detach?.();
      }
    } finally {
      this.queued -= 1;
    }
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next.resolve();
      return;
    }
    this.running -= 1;
  }
}

/**
 * Open workspaces are cheap but not free (each one watches directories). A
 * view that never closes its workspace — a crashed renderer — must not leak
 * forever, so the least recently used one is released past this many.
 */
export const MAX_OPEN_WORKSPACES = 32;

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();

  add(workspace: Workspace): void {
    this.workspaces.set(workspace.id, workspace);
    for (const [id, oldest] of this.workspaces) {
      if (this.workspaces.size <= MAX_OPEN_WORKSPACES) break;
      this.release(id, oldest);
    }
  }

  /** Looks a workspace up and marks it recently used. */
  get(id: string): Workspace | undefined {
    const workspace = this.workspaces.get(id);
    if (workspace) {
      this.workspaces.delete(id);
      this.workspaces.set(id, workspace);
    }
    return workspace;
  }

  close(id: string): boolean {
    const workspace = this.workspaces.get(id);
    if (!workspace) return false;
    this.release(id, workspace);
    return true;
  }

  closeAll(): void {
    for (const [id, workspace] of this.workspaces) this.release(id, workspace);
  }

  private release(id: string, workspace: Workspace): void {
    this.workspaces.delete(id);
    workspace.lifetime.abort();
    workspace.tracker.dispose();
  }
}
