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
import { hasOnlineOnlyEntries } from "../../shared/utils/onlineOnlyFiles.js";
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
// Past every walk's budget, so only a find the kernel won't let die gets here.
const STUCK_CHILD_REPORT_MS = 30_000;

const SIDES: readonly OnlineOnlyScanSide[] = ["git", "workingTree"];

const NOTHING_TO_DISPOSE = { dispose() {} };

type OnlineOnlyListener = (files: ProjectOnlineOnlyFiles) => void;

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
  holders: Map<string, OnlineOnlyListener>;
  timers: Map<OnlineOnlyScanSide, ReturnType<typeof setTimeout>>;
  running: Set<OnlineOnlyPass<unknown>>;
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
    a.complete === b.complete &&
    a.rootOnlineOnly === b.rootOnlineOnly
  );
}

/**
 * Counts each watched project's online-only files for as long as a view, or the
 * project's workspace host, asks. Nothing runs for a project nobody is holding,
 * so a project outside a cloud folder costs no process, timer or listener.
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
  // Outlives a project's holders, so releasing and watching again can't start a
  // child beside one that won't die. An entry goes when its child really exits.
  private readonly childGone = new Map<string, Promise<void>>();
  private revision = 0;
  private observers = 0;

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

    const watched = this.hold(
      project,
      endpoint.endpointId,
      (files) =>
        endpoint.send({
          type: "event",
          channel: CHANNELS.ONLINE_ONLY_FILES_CHANGED,
          args: [files],
        }),
      endpoint.onClose(() => this.release(endpoint))
    );
    return watched.snapshot;
  }

  release(endpoint: ClientEndpoint): void {
    this.releaseHolder(endpoint.endpointId);
  }

  /**
   * Main's own interest in a project, shared with any view watching it so there
   * is only ever the one walk. Hears every change until released.
   */
  observe(
    project: OnlineOnlyProject,
    listener: OnlineOnlyListener
  ): { files: ProjectOnlineOnlyFiles; release: () => void } {
    const holderId = `observer:${++this.observers}`;
    const watched = this.hold(project, holderId, listener, NOTHING_TO_DISPOSE);
    return { files: watched.snapshot, release: () => this.releaseHolder(holderId) };
  }

  dispose(): void {
    for (const { closed } of this.held.values()) closed.dispose();
    this.held.clear();
    for (const project of [...this.projects.values()]) this.stop(project);
  }

  private hold(
    project: OnlineOnlyProject,
    holderId: string,
    listener: OnlineOnlyListener,
    closed: { dispose(): void }
  ): WatchedProject {
    let watched = this.projects.get(project.id);
    if (watched && watched.root !== project.path) {
      watched = this.moveTo(watched, project);
    } else if (!watched) {
      watched = this.begin(project);
    }

    watched.holders.set(holderId, listener);
    this.held.set(holderId, { project: watched, closed });
    return watched;
  }

  private releaseHolder(holderId: string): void {
    const held = this.held.get(holderId);
    if (!held) return;
    this.held.delete(holderId);
    held.closed.dispose();
    held.project.holders.delete(holderId);
    if (held.project.holders.size === 0) this.stop(held.project);
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
      walkedMs: { git: 0, workingTree: 0 },
      stopped: false,
    };
    this.projects.set(project.id, watched);
    for (const side of SIDES) void this.walkSide(watched, side);
    return watched;
  }

  /** A project that moved keeps every view that was holding it, not only the one that noticed. */
  private moveTo(previous: WatchedProject, project: OnlineOnlyProject): WatchedProject {
    this.stop(previous);
    const moved = this.begin(project);
    for (const [holderId, listener] of previous.holders) {
      moved.holders.set(holderId, listener);
      const held = this.held.get(holderId);
      if (held) held.project = moved;
    }
    return moved;
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

    const floor = hasOnlineOnlyEntries(seen) ? OUTSTANDING_REST_MS : SETTLED_REST_MS;
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
    if (shape === "root-online-only") {
      return { files: 0, directories: 0, complete: false, rootOnlineOnly: true };
    }
    if (shape === "unknown") return { files: 0, directories: 0, complete: false };

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
   *
   * That side can't look again until the child goes, so its last report stops
   * being something to stand behind: a hold on git status and a notice both rest
   * on it, and neither may outlive the files. It says it can't tell instead.
   */
  private async runPass<T>(
    project: WatchedProject,
    side: OnlineOnlyScanSide,
    start: () => OnlineOnlyPass<T>
  ): Promise<T | null> {
    const childKey = `${side}\0${project.root}`;
    const previousChild = this.childGone.get(childKey);
    if (previousChild) {
      const stuck = setTimeout(() => {
        if (!project.stopped)
          this.record(project, side, { files: 0, directories: 0, complete: false });
      }, STUCK_CHILD_REPORT_MS);
      stuck.unref?.();
      await previousChild;
      clearTimeout(stuck);
    }
    if (project.stopped) return null;
    const slot = this.walkSlots[side];
    await this.takeWalkSlot(slot);
    const startedAt = Date.now();
    try {
      if (project.stopped) return null;
      const pass = start();
      project.running.add(pass);
      const gone: Promise<void> = pass.exited.then(() => {
        project.running.delete(pass);
        if (this.childGone.get(childKey) === gone) this.childGone.delete(childKey);
      });
      this.childGone.set(childKey, gone);
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
    for (const listener of project.holders.values()) {
      try {
        listener(project.snapshot);
      } catch {
        // Silently ignore send failures on a closing link.
      }
    }
  }
}

let shared: ProjectOnlineOnlyService | null = null;

/** The one service, so a project's views and its workspace host share a walk. */
export function getProjectOnlineOnlyService(): ProjectOnlineOnlyService {
  return (shared ??= new ProjectOnlineOnlyService());
}
