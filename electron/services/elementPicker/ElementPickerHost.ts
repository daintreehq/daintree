import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { utilityProcess } from "electron";
import {
  RESOLVE_BUDGET_CEILINGS,
  ResolveRequestSchema,
  type ResolveRequest,
  type ResolveResponse,
} from "../../../shared/elementPicker/resolver.js";
import type { UnavailableReason } from "../../../shared/elementPicker/resolution.js";
import type { ProjectContextOutcome } from "../../../shared/elementPicker/projectContext.js";
import { logError, logInfo, logWarn } from "../../utils/logger.js";
import { minimalSpawnEnv } from "../../utils/minimalSpawnEnv.js";
import { watchShared } from "../FileObservationService.js";
import { noteTerminationIntent } from "../processTerminationIntent.js";
import { AdmissionGate } from "./admissionGate.js";
import { checkResolveResponse, relabelCancelled } from "./checkResponse.js";
import { ElementPickerHostError, type ElementPickerHostErrorCode } from "./errors.js";
import { HostOutboundSchema, type HostInbound } from "./hostProtocol.js";
import { unavailableResponse } from "./outcomes.js";
import { isStrictlyInside } from "./containment.js";
import { nextDevServer } from "./nextDevServer.js";
import { ProjectContextService } from "./projectAdapters/projectContext.js";
import type { ProjectAdapterRegistration } from "./projectAdapters/types.js";
import {
  JobSourceAccess,
  readSourceRevision,
  type NextSourceMapProvider,
  type SourceMapProvider,
  type SourceRoots,
} from "./sourceAccess.js";
import { createNextSourceMapProvider, createSourceMapProvider } from "./sourceMapFetcher.js";
import { SourceTracker, type SourceChange, type SourceTrackerOptions } from "./sourceTracker.js";
import { WorkspaceRegistry, type PickerWorkspace } from "./workspaceRegistry.js";

const P = "[ElementPickerHost]";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const HOST_SERVICE_NAME = "daintree-element-picker";

/**
 * How long a host with nothing to do is kept before it is retired. Resolves
 * come in bursts while someone is picking; between bursts the resolvers it
 * loaded are memory nobody is using, and exiting is the only way to get it back.
 */
export const HOST_IDLE_MS = 30_000;

/** From fork to `ready`. Past this the process is retired and its jobs fail. */
export const HOST_START_TIMEOUT_MS = 10_000;

/**
 * How long a cancelled job's resolver gets to answer with what it has. A host
 * that cannot answer a cancel in this long is stuck, not slow, and is retired.
 */
export const HOST_CANCEL_GRACE_MS = 1_000;

/** How long a retired host gets to exit before it is sent SIGKILL. */
export const HOST_DISPOSE_KILL_MS = 1_000;

/**
 * Resolves the compiled bootstrap. This module lands in a shared chunk under
 * `dist-electron/electron/chunks/`, so step up to the electron root first.
 * Mirrors `resolveVadWorkerPath()`.
 */
function resolveHostEntryPath(): string {
  const electronDir = path.basename(__dirname) === "chunks" ? path.dirname(__dirname) : __dirname;
  return path.join(electronDir, "services", "elementPicker", "host-bootstrap.js");
}

/** The slice of Electron's `UtilityProcess` the host uses. */
export interface HostChild {
  readonly pid: number | undefined;
  postMessage(message: HostInbound): void;
  on(event: "spawn", listener: () => void): unknown;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  on(event: "error", listener: (...args: unknown[]) => void): unknown;
}

export interface ElementPickerHostOptions {
  fork?: () => HostChild;
  kill?: (pid: number) => void;
  watch?: SourceTrackerOptions["watch"];
  sourceMaps?: SourceMapProvider;
  nextSourceMaps?: NextSourceMapProvider;
  idleMs?: number;
  startTimeoutMs?: number;
  cancelGraceMs?: number;
  disposeKillMs?: number;
  /** The project adapters context is read with; the core catalog when omitted. */
  projectAdapters?: readonly ProjectAdapterRegistration[];
  projectContextDeadlineMs?: number;
}

export interface RegisterWorkspaceOptions {
  /** The worktree `SourceFileRef` paths are relative to. */
  worktreePath: string;
  /**
   * The app inside it that reads are contained to; the worktree when omitted.
   * Also the directory the preview's dev server serves from, which is what a
   * root-relative source in a map is read against.
   */
  appRoot?: string;
  /**
   * The dev server's origin. Source maps are fetched from here and nowhere
   * else, redirects included; without one, nothing is fetched at all.
   */
  previewOrigin?: string;
  /** A file a resolve read changed on disk. */
  onSourceChanged: (change: SourceChange) => void;
}

/** An HTTP(S) origin with no credentials in it, or null when there is none to authorise. */
function previewOriginOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw hostError("INVALID_REQUEST", "the preview origin is not a URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw hostError("INVALID_REQUEST", "the preview origin is not a plain HTTP(S) origin");
  }
  return url.origin;
}

function defaultFork(): HostChild {
  return utilityProcess.fork(resolveHostEntryPath(), [], {
    serviceName: HOST_SERVICE_NAME,
    // Resolvers need no secrets; keep main's environment out of the host.
    env: minimalSpawnEnv(),
    // Not "inherit": main's fd 2 can be a dead pty on AppImage launches (#5588).
    stdio: "ignore",
  }) as unknown as HostChild;
}

function defaultKill(pid: number): void {
  // Not `child.kill()`: Electron's UtilityProcess.kill() blocks main on macOS
  // until the child is gone (#11069). A raw SIGKILL does not.
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "ESRCH") logWarn(`${P} Failed to kill the host`, { pid });
  }
}

type AccessResult = Extract<HostInbound, { type: "access-result" }>["result"];

type JobOutcome = { ok: true; response: ResolveResponse } | { ok: false; error: Error };

interface Job {
  readonly id: number;
  readonly request: ResolveRequest;
  readonly roots: SourceRoots;
  readonly signal: AbortSignal;
  readonly access: JobSourceAccess;
  readonly expired: () => boolean;
  generation: Generation | null;
  posted: boolean;
  graceTimer: ReturnType<typeof setTimeout> | null;
  settle(outcome: JobOutcome): void;
}

interface Generation {
  readonly id: number;
  readonly child: HostChild;
  readonly forkedAt: number;
  state: "starting" | "ready" | "retiring" | "exited";
  readonly jobs: Map<number, Job>;
  startTimer: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
  /** The kill window closed before the child had a pid to signal. */
  killDue: boolean;
  readonly exited: Promise<void>;
  markExited(): void;
}

function hostError(code: ElementPickerHostErrorCode, message: string): ElementPickerHostError {
  return new ElementPickerHostError(code, message);
}

/**
 * Element Picker source resolution, run out of main. The process that runs
 * resolvers does not exist until the first resolve, and is retired once it has
 * been idle for {@link HOST_IDLE_MS}; the next resolve forks a fresh one. A
 * crash fails the jobs it held and nothing else: there is no restart until a
 * resolve needs one, and no job is replayed.
 *
 * Main keeps every authority: which workspaces exist and what their roots
 * are, what a job may read and how much, and when it has run out of time. The
 * process is sent bytes, never a path.
 */
export class ElementPickerHost {
  private readonly workspaces = new WorkspaceRegistry();
  private readonly gate = new AdmissionGate();
  private readonly retiring = new Set<Generation>();
  private readonly fork: () => HostChild;
  private readonly kill: (pid: number) => void;
  private readonly watch: SourceTrackerOptions["watch"];
  private readonly sourceMaps: SourceMapProvider;
  private readonly nextSourceMaps: NextSourceMapProvider;
  private readonly idleMs: number;
  private readonly startTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly disposeKillMs: number;
  private readonly projectAdapters: readonly ProjectAdapterRegistration[] | undefined;
  private readonly projectContextDeadlineMs: number | undefined;
  private projectContext: ProjectContextService | null = null;
  private current: Generation | null = null;
  private generations = 0;
  private nextJobId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: ElementPickerHostOptions = {}) {
    this.fork = options.fork ?? defaultFork;
    this.kill = options.kill ?? defaultKill;
    this.watch = options.watch ?? ((directory, onChange) => watchShared(directory, onChange));
    this.sourceMaps = options.sourceMaps ?? createSourceMapProvider();
    this.nextSourceMaps = options.nextSourceMaps ?? createNextSourceMapProvider();
    this.idleMs = options.idleMs ?? HOST_IDLE_MS;
    this.startTimeoutMs = options.startTimeoutMs ?? HOST_START_TIMEOUT_MS;
    this.cancelGraceMs = options.cancelGraceMs ?? HOST_CANCEL_GRACE_MS;
    this.disposeKillMs = options.disposeKillMs ?? HOST_DISPOSE_KILL_MS;
    this.projectAdapters = options.projectAdapters;
    this.projectContextDeadlineMs = options.projectContextDeadlineMs;
  }

  /** Whether a host process is running or starting. Registering a workspace never starts one. */
  get running(): boolean {
    return this.current !== null;
  }

  /**
   * Opens a workspace and returns the id every request in it names. Both roots
   * are resolved on disk now, so a later symlink swap of either cannot widen
   * what the workspace may read.
   */
  async registerWorkspace(options: RegisterWorkspaceOptions): Promise<string> {
    if (this.disposed) throw hostError("HOST_DISPOSED", "the source host is shutting down");
    const previewOrigin = previewOriginOf(options.previewOrigin);
    let worktreePath: string;
    let appRoot: string;
    try {
      worktreePath = await fs.realpath(options.worktreePath);
      appRoot = await fs.realpath(options.appRoot ?? options.worktreePath);
      const [worktree, app] = await Promise.all([fs.stat(worktreePath), fs.stat(appRoot)]);
      if (!worktree.isDirectory() || !app.isDirectory()) throw new Error("not a directory");
    } catch {
      throw hostError("INVALID_REQUEST", "the workspace roots are not readable directories");
    }
    if (appRoot !== worktreePath && !isStrictlyInside(worktreePath, appRoot)) {
      throw hostError("INVALID_REQUEST", "the app root is not inside the worktree");
    }
    if (this.disposed) throw hostError("HOST_DISPOSED", "the source host is shutting down");

    const id = randomUUID();
    const tracker = new SourceTracker({
      watch: this.watch,
      readRevision: (absolute) =>
        readSourceRevision(absolute, RESOLVE_BUDGET_CEILINGS.maxFileBytes),
      push: options.onSourceChanged,
      warn: (message, detail) => logWarn(`${P} ${message}`, { workspaceId: id, ...detail }),
    });
    this.workspaces.add({
      id,
      roots: { worktreePath, appRoot },
      previewOrigin,
      lifetime: new AbortController(),
      tracker,
    });
    return id;
  }

  /** Cancels the workspace's resolves and stops its watches. */
  releaseWorkspace(workspaceId: string): boolean {
    return this.workspaces.close(workspaceId);
  }

  /**
   * Resolves one selection. A request withdrawn by `signal`, by its workspace
   * closing, or by running past its deadline still settles with a response,
   * every candidate the host had not answered reporting `cancelled` or
   * `budget-exhausted`. Rejects with {@link ElementPickerHostError} when there
   * is no response to give.
   */
  async resolve(input: unknown, options: { signal?: AbortSignal } = {}): Promise<ResolveResponse> {
    if (this.disposed) throw hostError("HOST_DISPOSED", "the source host is shutting down");
    const parsed = ResolveRequestSchema.safeParse(input);
    if (!parsed.success) throw hostError("INVALID_REQUEST", "the request is malformed");
    const request = parsed.data;
    // Results are matched to observations by element id, so one id must name one observation.
    const elementIds = new Set(request.observations.map((observation) => observation.elementId));
    if (elementIds.size !== request.observations.length) {
      throw hostError("INVALID_REQUEST", "two observations share an element id");
    }
    const workspace = this.workspaces.get(request.workspaceId);
    if (!workspace) throw hostError("UNKNOWN_WORKSPACE", "no open workspace has this id");

    // The deadline runs from admission: queueing and a cold start spend it too.
    const controller = new AbortController();
    let expired = false;
    const deadline = setTimeout(() => {
      // The first cause stands: a deadline passing after a cancel does not relabel it.
      if (controller.signal.aborted) return;
      expired = true;
      controller.abort();
    }, request.budget.deadlineMs);
    const sources = [options.signal, workspace.lifetime.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined
    );
    const onAbort = () => controller.abort();
    for (const signal of sources) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      let release: () => void;
      try {
        release = await this.gate.acquire(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        return this.withdrawnResponse(request, expired);
      }
      try {
        return await this.runJob(request, workspace, controller.signal, () => expired);
      } finally {
        release();
      }
    } finally {
      clearTimeout(deadline);
      for (const signal of sources) signal.removeEventListener("abort", onAbort);
      // However it settled, nothing main is still doing for this job is wanted.
      controller.abort();
    }
  }

  /**
   * What the app's project layout says about the page at `url`: the route
   * files that render it and the toolchain installed. Context beside a
   * selection, never on its path: `resolve()` neither waits for it nor depends
   * on it, and it never starts the resolver process. It settles within its own
   * deadline and never rejects, `unavailable` being the worst it can say.
   */
  async describeProject(
    workspaceId: string,
    url: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<ProjectContextOutcome> {
    if (this.disposed) return { status: "unavailable", reason: "cancelled" };
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return { status: "unavailable", reason: "unknown-workspace" };
    // The service is small and loads with the host; what each adapter brings
    // loads behind its registration, only for an app that adapter detects.
    this.projectContext ??= new ProjectContextService({
      adapters: this.projectAdapters,
      deadlineMs: this.projectContextDeadlineMs,
    });
    return this.projectContext.describe(workspace, url, options.signal);
  }

  /**
   * Stops for good: fails what is in flight, releases every workspace, retires
   * the process and waits, briefly, for it to exit.
   */
  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.clearIdle();
      if (this.current)
        this.fail(this.current, "HOST_DISPOSED", "the source host is shutting down");
      this.workspaces.closeAll();
    }
    const exits = [...this.retiring].map((generation) => generation.exited);
    if (exits.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(exits),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.disposeKillMs + 1_000);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }

  private withdrawnResponse(request: ResolveRequest, expired: boolean): ResolveResponse {
    if (this.disposed) throw hostError("HOST_DISPOSED", "the source host is shutting down");
    return unavailableResponse(request, expired ? "budget-exhausted" : "cancelled");
  }

  private runJob(
    request: ResolveRequest,
    workspace: PickerWorkspace,
    signal: AbortSignal,
    expired: () => boolean
  ): Promise<ResolveResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const job: Job = {
        id: this.nextJobId++,
        request,
        roots: workspace.roots,
        signal,
        expired,
        access: new JobSourceAccess({
          workspaceId: workspace.id,
          roots: workspace.roots,
          budget: request.budget,
          signal,
          expired,
          previewOrigin: workspace.previewOrigin,
          sourceMaps: this.sourceMaps,
          // The page's word for which release it runs; at most it decides a fixed route is asked.
          next: nextDevServer(request.observations),
          nextSourceMaps: this.nextSourceMaps,
          onRead: (absolute, file, revision) => workspace.tracker.observe(absolute, file, revision),
        }),
        generation: null,
        posted: false,
        graceTimer: null,
        settle: (outcome) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          if (job.graceTimer) clearTimeout(job.graceTimer);
          const generation = job.generation;
          if (generation) {
            generation.jobs.delete(job.id);
            this.armIdle(generation);
          }
          if (outcome.ok) resolve(outcome.response);
          else reject(outcome.error);
        },
      };
      const onAbort = () => this.withdraw(job);

      if (this.disposed) {
        job.settle({
          ok: false,
          error: hostError("HOST_DISPOSED", "the source host is shutting down"),
        });
        return;
      }
      if (signal.aborted) {
        this.withdraw(job);
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      let generation: Generation;
      try {
        generation = this.ensureGeneration();
      } catch (error) {
        job.settle({ ok: false, error: error as Error });
        return;
      }
      this.clearIdle();
      job.generation = generation;
      generation.jobs.set(job.id, job);
      if (generation.state === "ready") this.post(job);
    });
  }

  private post(job: Job): void {
    const generation = job.generation;
    if (!generation || job.posted) return;
    job.posted = true;
    try {
      generation.child.postMessage({ type: "resolve", jobId: job.id, request: job.request });
    } catch {
      this.fail(generation, "HOST_CRASHED", "the source host could not be reached");
    }
  }

  /**
   * A job the caller no longer wants, that ran out of time, or whose workspace
   * closed. One the host never saw settles now; one it is running gets a
   * cancel and {@link HOST_CANCEL_GRACE_MS} to answer with what it has.
   */
  private withdraw(job: Job): void {
    const reason: UnavailableReason = job.expired() ? "budget-exhausted" : "cancelled";
    const fallback = () =>
      job.settle({ ok: true, response: unavailableResponse(job.request, reason) });
    const generation = job.generation;
    if (!job.posted || !generation || generation.state !== "ready") {
      fallback();
      return;
    }
    if (job.graceTimer) return;
    try {
      generation.child.postMessage({ type: "cancel", jobId: job.id });
    } catch {
      // The exit that follows fails the generation's other jobs.
    }
    job.graceTimer = setTimeout(() => {
      job.graceTimer = null;
      fallback();
      logWarn(`${P} Host did not answer a cancel; retiring it`, { generation: generation.id });
      this.fail(generation, "HOST_CRASHED", "the source host stopped answering");
    }, this.cancelGraceMs);
  }

  private ensureGeneration(): Generation {
    if (this.current) return this.current;
    if (this.disposed) throw hostError("HOST_DISPOSED", "the source host is shutting down");
    let child: HostChild;
    try {
      child = this.fork();
    } catch (error) {
      logError(`${P} Host fork failed`, error);
      throw hostError("HOST_START_FAILED", "the source host could not be started");
    }
    let markExited!: () => void;
    const generation: Generation = {
      id: ++this.generations,
      child,
      forkedAt: performance.now(),
      state: "starting",
      jobs: new Map(),
      startTimer: null,
      killTimer: null,
      killDue: false,
      exited: new Promise<void>((resolve) => {
        markExited = resolve;
      }),
      markExited: () => markExited(),
    };
    this.current = generation;

    child.on("spawn", () => {
      logInfo(`${P} Host spawned`, { generation: generation.id, pid: child.pid });
      if (generation.killDue) this.killUnexited(generation);
    });
    child.on("message", (message) => this.handleMessage(generation, message));
    // A fatal V8 error in the child. UtilityProcess is an EventEmitter, so with
    // no listener this would throw in main. The exit that follows fails the jobs.
    child.on("error", (type, location) => {
      logWarn(`${P} Host fatal error`, { generation: generation.id, type, location });
    });
    child.on("exit", (code) => this.handleExit(generation, code));

    generation.startTimer = setTimeout(() => {
      generation.startTimer = null;
      if (generation.state !== "starting") return;
      logWarn(`${P} Host did not start in time`, { generation: generation.id });
      this.fail(generation, "HOST_START_FAILED", "the source host did not start in time");
    }, this.startTimeoutMs);
    generation.startTimer.unref?.();
    return generation;
  }

  private handleMessage(generation: Generation, raw: unknown): void {
    if (generation !== this.current) return;
    const parsed = HostOutboundSchema.safeParse(raw);
    if (!parsed.success) {
      logWarn(`${P} Host sent a malformed message; retiring it`, { generation: generation.id });
      this.fail(generation, "HOST_CRASHED", "the source host sent a malformed message");
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "ready": {
        if (generation.state !== "starting") return;
        generation.state = "ready";
        if (generation.startTimer) clearTimeout(generation.startTimer);
        generation.startTimer = null;
        logInfo(`${P} Host ready`, {
          generation: generation.id,
          msSinceFork: Math.round(performance.now() - generation.forkedAt),
        });
        for (const job of [...generation.jobs.values()]) this.post(job);
        this.armIdle(generation);
        return;
      }
      case "resolved": {
        const job = generation.jobs.get(message.jobId);
        if (!job) return;
        const response = checkResolveResponse(job.request, message.response, {
          roots: job.roots,
          servedRevision: (file) => job.access.servedRevision(file),
          servedMap: (mapUrl, revision) => job.access.servedMap(mapUrl, revision),
        });
        job.settle(
          response
            ? { ok: true, response: job.expired() ? relabelCancelled(response) : response }
            : {
                ok: false,
                error: hostError("RESOLVER_FAILED", "a resolver returned an invalid response"),
              }
        );
        return;
      }
      case "failed":
        generation.jobs
          .get(message.jobId)
          ?.settle({ ok: false, error: hostError("RESOLVER_FAILED", message.message) });
        return;
      case "read-source":
      case "fetch-source-map":
      case "locate-source":
      case "locate-file": {
        const job = generation.jobs.get(message.jobId);
        // A job already settled still gets an answer, so the host's read never hangs.
        const result: Promise<AccessResult> = !job
          ? Promise.resolve({ ok: false as const, reason: "cancelled" as const })
          : message.type === "read-source"
            ? job.access.readSource(message.file)
            : message.type === "fetch-source-map"
              ? job.access.fetchSourceMap(message.generatedUrl)
              : message.type === "locate-source"
                ? job.access.locateSource(message.generatedUrl, message.source, message.sourceRoot)
                : Promise.resolve(job.access.locateFile(message.reported));
        const unreadable: UnavailableReason =
          message.type === "read-source"
            ? "file-missing"
            : message.type === "fetch-source-map"
              ? "map-missing"
              : message.type === "locate-source"
                ? "unsupported"
                : "outside-workspace";
        void result
          .catch((error: unknown) => {
            logWarn(`${P} Source access failed`, {
              generation: generation.id,
              error: String(error),
            });
            return { ok: false as const, reason: unreadable };
          })
          .then((value) => {
            if (generation.state !== "ready") return;
            try {
              generation.child.postMessage({
                type: "access-result",
                jobId: message.jobId,
                accessId: message.accessId,
                result: value,
              });
            } catch {
              // Gone; its exit fails the job.
            }
          });
        return;
      }
      case "fatal":
        logWarn(`${P} Host reported a fatal error`, {
          generation: generation.id,
          message: message.message.slice(0, 2_000),
        });
        return;
    }
  }

  private handleExit(generation: Generation, code: number): void {
    const wasStarting = generation.state === "starting";
    generation.state = "exited";
    if (generation.startTimer) clearTimeout(generation.startTimer);
    if (generation.killTimer) clearTimeout(generation.killTimer);
    generation.startTimer = null;
    generation.killTimer = null;
    this.retiring.delete(generation);
    generation.markExited();
    const context = {
      generation: generation.id,
      code,
      msSinceFork: Math.round(performance.now() - generation.forkedAt),
    };
    if (this.current === generation) {
      this.current = null;
      this.clearIdle();
      logError(`${P} Host exited unexpectedly`, undefined, context);
    } else {
      logInfo(`${P} Host exited`, context);
    }
    const error = wasStarting
      ? hostError("HOST_START_FAILED", "the source host exited before it was ready")
      : hostError("HOST_CRASHED", "the source host exited before it answered");
    for (const job of [...generation.jobs.values()]) job.settle({ ok: false, error });
  }

  /** Fails every job the generation holds, then retires it. */
  private fail(generation: Generation, code: ElementPickerHostErrorCode, message: string): void {
    const jobs = [...generation.jobs.values()];
    this.retire(generation);
    const error = hostError(code, message);
    for (const job of jobs) job.settle({ ok: false, error });
  }

  /** Asks the process to exit and arms the kill backstop. Idempotent. */
  private retire(generation: Generation): void {
    if (generation.state === "retiring" || generation.state === "exited") return;
    if (this.current === generation) {
      this.current = null;
      this.clearIdle();
    }
    if (generation.startTimer) clearTimeout(generation.startTimer);
    generation.startTimer = null;
    generation.state = "retiring";
    this.retiring.add(generation);
    try {
      generation.child.postMessage({ type: "dispose" });
    } catch {
      // Already gone; its exit settles the retirement.
    }
    generation.killTimer = setTimeout(() => this.killUnexited(generation), this.disposeKillMs);
    // Never hold the app open for a retiring host.
    generation.killTimer.unref?.();
  }

  private killUnexited(generation: Generation): void {
    generation.killTimer = null;
    if (generation.state === "exited") return;
    const pid = generation.child.pid;
    if (pid === undefined) {
      // Not spawned yet; the spawn handler finishes the job.
      generation.killDue = true;
      return;
    }
    generation.killDue = false;
    noteTerminationIntent({ serviceName: HOST_SERVICE_NAME }, "retired");
    this.kill(pid);
  }

  private armIdle(generation: Generation): void {
    if (generation !== this.current || generation.jobs.size > 0 || this.disposed) return;
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.current !== generation || generation.jobs.size > 0) return;
      logInfo(`${P} Retiring idle host`, { generation: generation.id });
      this.retire(generation);
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
