import type { CanopyTerminalView } from "../../../shared/types/ipc/canopy.js";
import { HOST_SIGN_IN_TERMINAL_PREFIX } from "../../../shared/config/terminalScreenPersistence.js";
import type { ProjectPushTarget } from "../../ipc/utils.js";
import { AppError } from "../../utils/errorTypes.js";
import type { CanopySignInPayload } from "./linkMethods.js";
import type { CanopyViewer } from "./viewer.js";

/** Sign-ins one host runs at once, across every Shell. */
export const MAX_HOST_SIGN_INS = 4;

export interface HostSignInDeps {
  newId(): string;
  /**
   * Starts the agent's own sign-in command under `terminalId`, in a terminal
   * placed in no project. Resolves once it runs, with when it started; throws
   * an `AppError` saying why it didn't. `cancelled` turns true once its viewer
   * has gone, so a spawn still preparing starts nothing.
   */
  spawn(spec: {
    terminalId: string;
    agentId: string;
    cancelled(): boolean;
  }): Promise<{ spawnedAt: number }>;
  /**
   * Hear the terminal end: its process exiting, or the pty-host dropping it
   * in a restart, which replays no sign-in. Answers how to stop listening.
   */
  onGone(terminalId: string, gone: () => void): () => void;
  /** Ends the process outright; a terminal already gone is no error. */
  kill(terminalId: string): void;
  /** Stream the terminal to the target, from a snapshot, until `ended` or its exit. */
  watch(
    target: ProjectPushTarget,
    terminalId: string,
    spawnedAt: number,
    ended: () => boolean,
    onEnded: (end: () => void) => () => void
  ): Promise<CanopyTerminalView>;
  /** The terminal the target's stream `watchId` shows, or null with no such open stream. */
  watched(target: ProjectPushTarget, watchId: number): string | null;
  write(terminalId: string, data: string): void;
  resize(target: ProjectPushTarget, watchId: number, cols: number, rows: number): void;
  unwatch(target: ProjectPushTarget, watchId: number): void;
  /** Ends every stream the target has open. */
  release(target: ProjectPushTarget): void;
}

interface Run {
  terminalId: string;
  agentId: string;
  /** Null until the terminal is known to run. */
  spawnedAt: number | null;
  target: ProjectPushTarget;
  ended: boolean;
  /** Its terminal ended before the spawn answered: there is nothing to show. */
  goneWhileStarting: boolean;
  endListeners: Set<() => void>;
  stopHearingGone: (() => void) | null;
}

function notStarted(): AppError {
  return new AppError({
    code: "NOT_FOUND",
    message: "No sign-in was started by this viewer",
    userMessage: "That sign-in isn't running any more.",
  });
}

function ended(): AppError {
  return new AppError({
    code: "CANCELLED",
    message: "The sign-in ended before its terminal started",
    userMessage: "That sign-in was closed before it started.",
  });
}

/**
 * The agent CLI sign-ins this host runs for Shells (#18196). Each is one
 * viewer's: started by it, watched and typed into only through it, and ended
 * with it, whether its dialog closed, its link dropped or the host stopped
 * serving viewers. A terminal still starting when its viewer goes is ended as
 * soon as it exists. Nothing here reads what the CLI prints or saves.
 */
export class HostSignIns {
  private readonly runs = new Map<CanopyViewer, Run>();

  constructor(private readonly deps: HostSignInDeps) {}

  /** How many sign-ins are running or starting here. */
  get size(): number {
    return this.runs.size;
  }

  async handle(viewer: CanopyViewer, payload: CanopySignInPayload): Promise<unknown> {
    switch (payload.op) {
      case "start":
        return this.start(viewer, payload.agentId);
      case "watch":
        return this.watch(viewer);
      case "input": {
        const run = this.require(viewer);
        if (this.deps.watched(run.target, payload.watchId) !== run.terminalId) throw notStarted();
        this.deps.write(run.terminalId, payload.data);
        return null;
      }
      case "resize": {
        const run = this.require(viewer);
        if (this.deps.watched(run.target, payload.watchId) !== run.terminalId) return null;
        this.deps.resize(run.target, payload.watchId, payload.cols, payload.rows);
        return null;
      }
      case "unwatch": {
        const run = this.runs.get(viewer);
        if (run) this.deps.unwatch(run.target, payload.watchId);
        return null;
      }
    }
  }

  /** Every sign-in ends: the host stopped serving them. */
  dispose(): void {
    for (const viewer of [...this.runs.keys()]) this.end(viewer);
  }

  private async start(
    viewer: CanopyViewer,
    agentId: string
  ): Promise<{ terminalId: string; spawnedAt: number }> {
    if (this.runs.has(viewer)) {
      throw new AppError({
        code: "VALIDATION",
        message: "A sign-in viewer starts one sign-in",
      });
    }
    if (this.runs.size >= MAX_HOST_SIGN_INS) {
      throw new AppError({
        code: "RATE_LIMITED",
        message: `This host already runs ${MAX_HOST_SIGN_INS} sign-ins`,
        userMessage: "This host already has several sign-ins open. Close one and try again.",
      });
    }
    const run: Run = {
      terminalId: `${HOST_SIGN_IN_TERMINAL_PREFIX}${this.deps.newId()}`,
      agentId,
      spawnedAt: null,
      target: {
        id: viewer.handle,
        isDestroyed: () => viewer.isClosed(),
        send: (channel, ...args) => viewer.send({ type: "event", channel, args }),
      },
      ended: false,
      goneWhileStarting: false,
      endListeners: new Set(),
      stopHearingGone: null,
    };
    this.runs.set(viewer, run);
    // Held before the spawn is awaited, so a viewer gone meanwhile ends it.
    viewer.onClose(() => this.end(viewer));
    if (viewer.isClosed()) {
      this.end(viewer);
      throw ended();
    }
    // Heard from before the spawn, so an exit or a pty-host restart that lands
    // while the spawn is answered isn't missed.
    run.stopHearingGone = this.deps.onGone(run.terminalId, () => {
      if (run.spawnedAt === null) run.goneWhileStarting = true;
      else this.end(viewer);
    });
    let started: { spawnedAt: number };
    try {
      started = await this.deps.spawn({
        terminalId: run.terminalId,
        agentId,
        cancelled: () => run.ended,
      });
    } catch (error) {
      this.settleStart(viewer, run);
      throw error;
    }
    if (run.ended) {
      // Its viewer went while it started: it started for nobody.
      this.settleStart(viewer, run);
      throw ended();
    }
    if (run.goneWhileStarting) {
      this.settleStart(viewer, run);
      throw new AppError({
        code: "INTERNAL",
        message: "The sign-in's terminal ended as it started",
        userMessage:
          "The sign-in's terminal ended as soon as it started. Retry, or open a terminal on this host to run it.",
      });
    }
    run.spawnedAt = started.spawnedAt;
    return { terminalId: run.terminalId, spawnedAt: started.spawnedAt };
  }

  private watch(viewer: CanopyViewer): Promise<CanopyTerminalView> {
    const run = this.require(viewer);
    if (run.spawnedAt === null) {
      throw new AppError({
        code: "VALIDATION",
        message: "The sign-in's terminal hasn't started yet",
      });
    }
    return this.deps.watch(
      run.target,
      run.terminalId,
      run.spawnedAt,
      () => run.ended,
      (end) => {
        run.endListeners.add(end);
        return () => run.endListeners.delete(end);
      }
    );
  }

  private require(viewer: CanopyViewer): Run {
    const run = this.runs.get(viewer);
    if (!run || run.ended) throw notStarted();
    return run;
  }

  /**
   * A start that won't run: its place is let go only now, so sign-ins closed
   * while starting can't let more start than the cap allows, and whatever the
   * spawn made is ended.
   */
  private settleStart(viewer: CanopyViewer, run: Run): void {
    run.ended = true;
    run.stopHearingGone?.();
    if (this.runs.get(viewer) === run) this.runs.delete(viewer);
    this.deps.kill(run.terminalId);
  }

  private end(viewer: CanopyViewer): void {
    const run = this.runs.get(viewer);
    if (!run || run.ended) return;
    run.ended = true;
    for (const listener of [...run.endListeners]) listener();
    run.endListeners.clear();
    this.deps.release(run.target);
    // Still starting: the start keeps its place until the spawn answers.
    if (run.spawnedAt === null) return;
    this.runs.delete(viewer);
    run.stopHearingGone?.();
    this.deps.kill(run.terminalId);
  }
}
