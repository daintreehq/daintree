import { CHANNELS } from "../ipc/channels.js";
import type { ClientEndpoint } from "../ipc/endpoint.js";
import {
  startOnlineOnlyProbe,
  startOnlineOnlyScan,
  type OnlineOnlyPass,
  type OnlineOnlyRootShape,
  type OnlineOnlyScanOptions,
  type OnlineOnlyScanSide,
} from "../utils/onlineOnlyScan.js";
import { getPowerPolicy } from "../window/powerPolicy.js";
import type { CloudSyncService } from "../../shared/utils/cloudSyncDetection.js";
import type {
  OnlineOnlyFilesSide,
  ProjectOnlineOnlyFiles,
} from "../../shared/types/onlineOnlyFiles.js";

const PROBE_BUDGET_MS = 5_000;
// Separate limits, so a huge working tree can't use up the time for `.git`, which git blocks on.
const WALK_BUDGET_MS: Record<OnlineOnlyScanSide, number> = { git: 15_000, workingTree: 30_000 };

// Often enough to show files arriving.
const OUTSTANDING_REST_MS = 5_000;
// Still checked at zero, because a provider can evict files again at any time.
const SETTLED_REST_MS = 60_000;
// A walk rests four times as long as it took, so a slow tree spends at most a fifth of its time walking.
const REST_PER_WALK_MS = 4;
const NOBODY_LOOKING_FACTOR = 5;

const SIDES: readonly OnlineOnlyScanSide[] = ["git", "workingTree"];

export interface OnlineOnlyScanner {
  probe(root: string, options: OnlineOnlyScanOptions): OnlineOnlyPass<OnlineOnlyRootShape>;
  scan(
    root: string,
    side: OnlineOnlyScanSide,
    options: OnlineOnlyScanOptions
  ): OnlineOnlyPass<OnlineOnlyFilesSide>;
}

export interface OnlineOnlyProject {
  id: string;
  path: string;
  service: CloudSyncService;
}

interface WatchedProject {
  root: string;
  snapshot: ProjectOnlineOnlyFiles;
  holders: Map<string, ClientEndpoint>;
  timers: Map<OnlineOnlyScanSide, ReturnType<typeof setTimeout>>;
  running: Set<OnlineOnlyPass<unknown>>;
  lastExit: Record<OnlineOnlyScanSide, Promise<void>>;
  walkedMs: Record<OnlineOnlyScanSide, number>;
  stopped: boolean;
}

interface WalkSlot {
  busy: boolean;
  waiting: Array<() => void>;
}

const realScanner: OnlineOnlyScanner = {
  probe: startOnlineOnlyProbe,
  scan: startOnlineOnlyScan,
};

function sameSide(a: OnlineOnlyFilesSide | null, b: OnlineOnlyFilesSide): boolean {
  return (
    a !== null &&
    a.files === b.files &&
    a.directories === b.directories &&
    a.complete === b.complete
  );
}

/**
 * Counts each watched project's online-only files for as long as a view asks.
 * Nothing runs for a project no view is holding, so a project outside a cloud
 * folder, or one nobody asked about, costs no process, timer or listener.
 */
export class ProjectOnlineOnlyService {
  private readonly projects = new Map<string, WatchedProject>();
  private readonly held = new Map<
    string,
    { project: WatchedProject; closed: { dispose(): void } }
  >();
  // One walk per side across every project, so several cloud projects can't add
  // up to a disk storm. `.git` has its own turn because git blocks on it, and a
  // huge working tree must not hold up the news that it can stop waiting.
  private readonly walkSlots: Record<OnlineOnlyScanSide, WalkSlot> = {
    git: { busy: false, waiting: [] },
    workingTree: { busy: false, waiting: [] },
  };
  private revision = 0;

  constructor(
    private readonly scanner: OnlineOnlyScanner = realScanner,
    private readonly nobodyLooking: () => boolean = () => !getPowerPolicy().canObserve
  ) {}

  /** A view holds one project at a time, so watching again moves it rather than adding to it. */
  watch(project: OnlineOnlyProject, endpoint: ClientEndpoint): ProjectOnlineOnlyFiles {
    const current = this.held.get(endpoint.endpointId)?.project;
    if (current && current.snapshot.projectId === project.id && current.root === project.path) {
      return current.snapshot;
    }
    this.release(endpoint);

    let watched = this.projects.get(project.id);
    if (watched && watched.root !== project.path) {
      this.stop(watched);
      watched = undefined;
    }
    if (!watched) watched = this.begin(project);

    watched.holders.set(endpoint.endpointId, endpoint);
    this.held.set(endpoint.endpointId, {
      project: watched,
      closed: endpoint.onClose(() => this.release(endpoint)),
    });
    return watched.snapshot;
  }

  release(endpoint: ClientEndpoint): void {
    const held = this.held.get(endpoint.endpointId);
    if (!held) return;
    this.held.delete(endpoint.endpointId);
    held.closed.dispose();
    held.project.holders.delete(endpoint.endpointId);
    if (held.project.holders.size === 0) this.stop(held.project);
  }

  dispose(): void {
    for (const { closed } of this.held.values()) closed.dispose();
    this.held.clear();
    for (const project of [...this.projects.values()]) this.stop(project);
  }

  private begin(project: OnlineOnlyProject): WatchedProject {
    const watched: WatchedProject = {
      root: project.path,
      snapshot: {
        projectId: project.id,
        service: project.service,
        revision: ++this.revision,
        git: null,
        workingTree: null,
      },
      holders: new Map(),
      timers: new Map(),
      running: new Set(),
      lastExit: { git: Promise.resolve(), workingTree: Promise.resolve() },
      walkedMs: { git: 0, workingTree: 0 },
      stopped: false,
    };
    this.projects.set(project.id, watched);
    for (const side of SIDES) void this.walkSide(watched, side);
    return watched;
  }

  private stop(project: WatchedProject): void {
    project.stopped = true;
    for (const timer of project.timers.values()) clearTimeout(timer);
    project.timers.clear();
    for (const pass of project.running) pass.cancel();
    if (this.projects.get(project.snapshot.projectId) === project) {
      this.projects.delete(project.snapshot.projectId);
    }
  }

  /** The two sides pace themselves, so a slow working tree never delays news about `.git`. */
  private async walkSide(project: WatchedProject, side: OnlineOnlyScanSide): Promise<void> {
    project.walkedMs[side] = 0;
    const seen = side === "git" ? await this.observeGit(project) : await this.observeTree(project);
    if (seen === null || project.stopped) return;
    this.record(project, side, seen);

    const floor = seen.files + seen.directories > 0 ? OUTSTANDING_REST_MS : SETTLED_REST_MS;
    const rest = Math.max(floor, project.walkedMs[side] * REST_PER_WALK_MS);
    const timer = setTimeout(
      () => void this.walkSide(project, side),
      this.nobodyLooking() ? rest * NOBODY_LOOKING_FACTOR : rest
    );
    timer.unref?.();
    project.timers.set(side, timer);
  }

  private observeTree(project: WatchedProject): Promise<OnlineOnlyFilesSide | null> {
    return this.runPass(project, "workingTree", () =>
      this.scanner.scan(project.root, "workingTree", {
        budgetMs: WALK_BUDGET_MS.workingTree,
      })
    );
  }

  private async observeGit(project: WatchedProject): Promise<OnlineOnlyFilesSide | null> {
    const shape = await this.runPass(project, "git", () =>
      this.scanner.probe(project.root, { budgetMs: PROBE_BUDGET_MS })
    );
    if (shape === null) return null;
    if (shape === "no-git") return { files: 0, directories: 0, complete: true };
    if (shape === "root-online-only" || shape === "unknown") {
      return { files: 0, directories: 0, complete: false };
    }

    const seen = await this.runPass(project, "git", () =>
      this.scanner.scan(project.root, "git", { budgetMs: WALK_BUDGET_MS.git })
    );
    if (seen === null) return null;
    // A linked worktree's metadata is somewhere else, and finding it means
    // reading pointer files that may be online-only themselves. So this side
    // stays unfinished rather than answering zero for files nobody looked at.
    return shape === "git-pointer" ? { ...seen, complete: false } : seen;
  }

  /**
   * A killed find can stay alive while the kernel holds it in a wait, so the
   * walk slot frees at the pass's budget while its side waits for the child to
   * really exit. A stuck find then costs its own side, with no pile-up, and
   * never another project.
   */
  private async runPass<T>(
    project: WatchedProject,
    side: OnlineOnlyScanSide,
    start: () => OnlineOnlyPass<T>
  ): Promise<T | null> {
    await project.lastExit[side];
    if (project.stopped) return null;
    const slot = this.walkSlots[side];
    await this.takeWalkSlot(slot);
    const startedAt = Date.now();
    try {
      if (project.stopped) return null;
      const pass = start();
      project.running.add(pass);
      project.lastExit[side] = pass.exited.then(() => {
        project.running.delete(pass);
      });
      return await pass.result;
    } finally {
      // Time spent queueing isn't walking, or a busy machine would slow every side's rests.
      project.walkedMs[side] += Date.now() - startedAt;
      this.freeWalkSlot(slot);
    }
  }

  private takeWalkSlot(slot: WalkSlot): Promise<void> {
    if (!slot.busy) {
      slot.busy = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => slot.waiting.push(resolve));
  }

  private freeWalkSlot(slot: WalkSlot): void {
    const next = slot.waiting.shift();
    if (next) next();
    else slot.busy = false;
  }

  private record(project: WatchedProject, side: OnlineOnlyScanSide, seen: OnlineOnlyFilesSide) {
    if (sameSide(project.snapshot[side], seen)) return;
    project.snapshot = { ...project.snapshot, [side]: seen, revision: ++this.revision };
    for (const endpoint of project.holders.values()) {
      try {
        endpoint.send({
          type: "event",
          channel: CHANNELS.ONLINE_ONLY_FILES_CHANGED,
          args: [project.snapshot],
        });
      } catch {
        // Silently ignore send failures on a closing link.
      }
    }
  }
}
