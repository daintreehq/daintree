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
import {
  SourceFileRefSchema,
  type FileRevision,
  type UnavailableReason,
} from "../../../shared/elementPicker/resolution.js";
import type { ProjectContextOutcome } from "../../../shared/elementPicker/projectContext.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { ELEMENT_PICKER_MAX_HELD_SOURCES } from "../../../shared/types/ipc/elementPicker.js";
import { logError, logInfo, logWarn } from "../../utils/logger.js";
import { minimalSpawnEnv } from "../../utils/minimalSpawnEnv.js";
import { watchShared } from "../FileObservationService.js";
import { noteTerminationIntent } from "../processTerminationIntent.js";
import { AdmissionGate, MAX_CONCURRENT_RESOLVES } from "./admissionGate.js";
import {
  checkResolveResponse,
  checkResolveResponseByProvider,
  relabelCancelled,
} from "./checkResponse.js";
import {
  getElementPickerProvider,
  isElementPickerProviderAuthorized,
  isElementPickerProviderCurrent,
  onElementPickerProvidersChanged,
} from "../elementPickerProviderRegistry.js";
import type { RegisteredElementPickerProvider } from "../../../shared/elementPicker/providers.js";
import { isCoreFramework, type SourceCandidate } from "../../../shared/elementPicker/source.js";
import { ElementPickerHostError, type ElementPickerHostErrorCode } from "./errors.js";
import { HostOutboundSchema, type PluginHostInbound } from "./hostProtocol.js";
import {
  mergeAnswers,
  observationCandidates,
  requestFor,
  unavailableResponse,
  unavailableResult,
} from "./outcomes.js";
import { isStrictlyInside } from "./containment.js";
import { nextDevServer } from "./nextDevServer.js";
import { ProjectContextService } from "./projectAdapters/projectContext.js";
import type { ProjectAdapterRegistration } from "./projectAdapters/types.js";
import {
  JobSourceAccess,
  containSourcePath,
  createResolveUsage,
  type ResolveUsage,
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

/** A plugin's resolver host: one process per plugin instance, apart from the core host and each other. */
export const PLUGIN_HOST_SERVICE_NAME = "daintree-element-picker-plugin";

/**
 * Plugin resolver hosts alive at once, retiring ones included until they
 * exit. Each resolve dispatch holds an admission slot, so with the gate full a
 * dispatch waiting on a process finds one idle to evict, or one already
 * leaving.
 */
export const MAX_PLUGIN_HOSTS = MAX_CONCURRENT_RESOLVES;

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

/** Paths one revision check may name: a view checks what it holds, which is a selection's files, not a tree. */
export const MAX_SOURCE_REVISION_PATHS = 128;

/** Reads a revision check runs at once; enough to overlap the opens, few enough not to crowd a resolve's. */
const SOURCE_REVISION_CONCURRENCY = 4;

/** Checks running at once across every workspace, and waiting behind them. */
const SOURCE_REVISION_ADMISSION = { concurrent: 2, queued: 16 } as const;

/**
 * Resolves the compiled bootstrap. This module lands in a shared chunk under
 * `dist-electron/electron/chunks/`, so step up to the electron root first.
 * Mirrors `resolveVadWorkerPath()`.
 */
function resolveHostEntryPath(entry = "host-bootstrap.js"): string {
  const electronDir = path.basename(__dirname) === "chunks" ? path.dirname(__dirname) : __dirname;
  return path.join(electronDir, "services", "elementPicker", entry);
}

/** The slice of Electron's `UtilityProcess` the host uses. */
export interface HostChild {
  readonly pid: number | undefined;
  postMessage(message: PluginHostInbound): void;
  on(event: "spawn", listener: () => void): unknown;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  on(event: "error", listener: (...args: unknown[]) => void): unknown;
}

export interface ElementPickerHostOptions {
  fork?: () => HostChild;
  /** Forks the resolver host for one plugin instance. */
  pluginFork?: (pluginId: string) => HostChild;
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

function defaultPluginFork(): HostChild {
  return utilityProcess.fork(resolveHostEntryPath("plugin-resolver-bootstrap.js"), [], {
    serviceName: PLUGIN_HOST_SERVICE_NAME,
    // A plugin's resolver is sent bytes through main like a core one; it gets
    // none of main's environment either.
    env: minimalSpawnEnv(),
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

type AccessResult = Extract<PluginHostInbound, { type: "access-result" }>["result"];

const CORE_KEY = "core";

/** What one slice of a selection came back with: an answer, a failure of its own, or nothing because it was withdrawn. */
type DispatchAnswer = ResolveResponse | "failed" | "withdrawn";

/** `work`'s result, or null as soon as `signal` aborts; a late result is dropped. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) {
    // Nobody waits on it now, so its failure must not surface as unhandled.
    work.catch(() => {});
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/** A plugin's providers in one dispatch, each with the entry main located for it. */
interface PluginTarget {
  readonly pluginId: string;
  readonly providers: ReadonlyArray<{
    readonly provider: RegisteredElementPickerProvider;
    readonly entryUrl: string;
  }>;
}

/** Where a slice of a selection runs: the core host, or one plugin's. */
type DispatchTarget =
  | { readonly kind: "core" }
  | {
      readonly kind: "plugin";
      readonly pluginId: string;
      readonly providers: readonly RegisteredElementPickerProvider[];
    };

/** Where a job runs, a plugin's with its entries located. */
type JobTarget = { readonly kind: "core" } | ({ readonly kind: "plugin" } & PluginTarget);

type JobOutcome = { ok: true; response: ResolveResponse } | { ok: false; error: Error };

interface Job {
  readonly id: number;
  readonly request: ResolveRequest;
  readonly roots: SourceRoots;
  readonly signal: AbortSignal;
  readonly access: JobSourceAccess;
  readonly expired: () => boolean;
  readonly target: JobTarget;
  generation: Generation | null;
  posted: boolean;
  settled: boolean;
  graceTimer: ReturnType<typeof setTimeout> | null;
  settle(outcome: JobOutcome): void;
}

interface Generation {
  readonly id: number;
  /** `core`, or the plugin instance id the process resolves for. */
  readonly key: string;
  readonly plugin: boolean;
  readonly child: HostChild;
  readonly forkedAt: number;
  state: "starting" | "ready" | "retiring" | "exited";
  readonly jobs: Map<number, Job>;
  startTimer: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
  /** The kill window closed before the child had a pid to signal. */
  killDue: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** When its last job settled, for choosing which idle plugin host makes room. */
  idleSince: number;
  /**
   * Every provider a job on this plugin host has named, as the registration
   * that named it, from the moment the job attached: a host still starting is
   * retired on an unload as surely as one running.
   */
  readonly providers: Map<string, RegisteredElementPickerProvider>;
  /** The providers the process has been told where to load from. */
  readonly sent: Set<string>;
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
/** Every framework or provider id a request's observations name, wherever the page put one. */
function requestedProviderIds(request: ResolveRequest): Set<string> {
  const ids = new Set<string>();
  for (const observation of request.observations) {
    for (const candidate of observationCandidates(observation)) ids.add(candidate.framework);
    for (const record of observation.componentChain.components) ids.add(record.framework);
    for (const detection of observation.detections) ids.add(detection.framework);
    for (const evidence of observation.frameworkEvidence) {
      if (evidence.kind === "generic") ids.add(evidence.framework);
    }
  }
  return ids;
}

export class ElementPickerHost {
  private readonly workspaces = new WorkspaceRegistry();
  private readonly gate = new AdmissionGate();
  /**
   * Its own bound, not the resolve gate's: a burst of revision checks must
   * neither take resolve slots nor schedule every file it names at once.
   */
  private readonly revisionGate = new AdmissionGate(SOURCE_REVISION_ADMISSION);
  private readonly retiring = new Set<Generation>();
  private readonly fork: () => HostChild;
  private readonly pluginFork: (pluginId: string) => HostChild;
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
  /** The live process for each key: the core host, and one per plugin instance resolving now. */
  private readonly live = new Map<string, Generation>();
  private generations = 0;
  private nextJobId = 1;
  /** Woken whenever a plugin host exits, for dispatches waiting on room for theirs. */
  private pluginRoom: { promise: Promise<void>; wake: () => void } | null = null;
  private unsubscribeProviders: (() => void) | null = null;
  private disposed = false;

  constructor(options: ElementPickerHostOptions = {}) {
    this.fork = options.fork ?? defaultFork;
    this.pluginFork = options.pluginFork ?? defaultPluginFork;
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

  /** Whether the core host process is running or starting. Registering a workspace never starts one. */
  get running(): boolean {
    return this.live.has(CORE_KEY);
  }

  /** Plugin resolver hosts alive now, retiring ones included until they exit. */
  get pluginHosts(): number {
    let count = 0;
    for (const generation of this.live.values()) if (generation.plugin) count += 1;
    for (const generation of this.retiring) if (generation.plugin) count += 1;
    return count;
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
  async resolve(
    input: unknown,
    options: { signal?: AbortSignal; projectId?: string | null } = {}
  ): Promise<ResolveResponse> {
    if (this.disposed) throw hostError("HOST_DISPOSED", "the source host is shutting down");
    const parsed = ResolveRequestSchema.safeParse(input);
    if (!parsed.success) throw hostError("INVALID_REQUEST", "the request is malformed");
    const request = parsed.data;
    // Well formed is not registered: the page may name only a core framework or
    // a provider an enabled plugin declared for this project.
    for (const id of requestedProviderIds(request)) {
      if (!isElementPickerProviderAuthorized(id, options.projectId ?? null)) {
        throw hostError("INVALID_REQUEST", "the request names a provider that isn't registered");
      }
    }
    // Results are matched to observations by element id, so one id must name one observation.
    const elementIds = new Set(request.observations.map((observation) => observation.elementId));
    if (elementIds.size !== request.observations.length) {
      throw hostError("INVALID_REQUEST", "two observations share an element id");
    }
    const workspace = this.workspaces.get(request.workspaceId);
    if (!workspace) throw hostError("UNKNOWN_WORKSPACE", "no open workspace has this id");
    // A selection whose page named no source has nothing for a resolver to read:
    // the answer is the host's empty one, without starting the host for it.
    if (
      request.observations.every((observation) => observationCandidates(observation).length === 0)
    ) {
      return {
        requestId: request.requestId,
        documentEpoch: request.documentEpoch,
        outcomes: request.observations.map(({ elementId }) => ({ elementId, results: [] })),
      };
    }

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
      const dispatches = this.dispatchesFor(request, options.projectId ?? null);
      const answers = new Map<DispatchTarget, DispatchAnswer>();
      const usage = createResolveUsage();
      await Promise.all(
        dispatches.map(async ({ target, slice }) => {
          answers.set(
            target,
            await this.dispatch(target, slice, workspace, controller.signal, () => expired, usage)
          );
        })
      );
      if (this.disposed) throw hostError("HOST_DISPOSED", "the source host is shutting down");
      const targetOf = new Map<SourceCandidate, DispatchTarget>();
      for (const { target, candidates } of dispatches) {
        for (const candidate of candidates) targetOf.set(candidate, target);
      }
      const stopped: UnavailableReason | null = controller.signal.aborted
        ? expired
          ? "budget-exhausted"
          : "cancelled"
        : null;
      const answerOf = (candidate: SourceCandidate): DispatchAnswer => {
        const target = targetOf.get(candidate);
        return target ? (answers.get(target) ?? "failed") : "failed";
      };
      return mergeAnswers(
        request,
        (candidate) => {
          const answer = answerOf(candidate);
          return typeof answer === "object" ? answer : null;
        },
        // A slice that failed stays failed, whatever stopped the selection after it.
        (candidate) =>
          unavailableResult(
            candidate,
            answerOf(candidate) !== "failed" && stopped !== null ? stopped : "unsupported"
          )
      );
    } finally {
      clearTimeout(deadline);
      for (const signal of sources) signal.removeEventListener("abort", onAbort);
      // However it settled, nothing main is still doing for this job is wanted.
      controller.abort();
    }
  }

  /**
   * Splits a selection by who resolves it: every core candidate to the core
   * host, and each plugin's to that plugin's own host. A plugin provider that
   * declared no resolver gets no dispatch, so its candidates answer
   * `unsupported` without a process.
   */
  private dispatchesFor(
    request: ResolveRequest,
    projectId: string | null
  ): Array<{ target: DispatchTarget; slice: ResolveRequest; candidates: SourceCandidate[] }> {
    const core: DispatchTarget = { kind: "core" };
    const plugins = new Map<string, RegisteredElementPickerProvider[]>();
    const owner = new Map<string, DispatchTarget | string | null>();
    const ownerOf = (framework: string): DispatchTarget | string | null => {
      if (owner.has(framework)) return owner.get(framework)!;
      let found: DispatchTarget | string | null = null;
      if (isCoreFramework(framework)) {
        found = core;
      } else {
        const provider = getElementPickerProvider(framework, projectId);
        if (provider?.resolverEntry !== undefined) {
          const providers = plugins.get(provider.pluginId) ?? [];
          providers.push(provider);
          plugins.set(provider.pluginId, providers);
          found = provider.pluginId;
        }
      }
      owner.set(framework, found);
      return found;
    };
    const byKey = new Map<string, SourceCandidate[]>();
    for (const observation of request.observations) {
      for (const candidate of observationCandidates(observation)) {
        const found = ownerOf(candidate.framework);
        if (found === null) continue;
        const key = typeof found === "string" ? found : CORE_KEY;
        const list = byKey.get(key) ?? [];
        list.push(candidate);
        byKey.set(key, list);
      }
    }
    return [...byKey].map(([key, candidates]) => {
      const owned = new Set(candidates);
      const target: DispatchTarget =
        key === CORE_KEY ? core : { kind: "plugin", pluginId: key, providers: plugins.get(key)! };
      return {
        target,
        slice: requestFor(request, (candidate) => owned.has(candidate)),
        candidates,
      };
    });
  }

  /**
   * Runs one slice under its own admission slot, with its own reads under the
   * request's budget, so what one resolver read never stands as authority for
   * another's answer. Null is no answer: withdrawn before it ran, or a plugin
   * that failed. A plugin's failure is its own candidates' alone; the core
   * host's still fails the selection, as it always has.
   */
  private async dispatch(
    target: DispatchTarget,
    slice: ResolveRequest,
    workspace: PickerWorkspace,
    selection: AbortSignal,
    expired: () => boolean,
    usage: ResolveUsage
  ): Promise<DispatchAnswer> {
    // Its own signal, so a slice that settles stops its reads in main without
    // waiting for the rest of the selection.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (selection.aborted) controller.abort();
    else selection.addEventListener("abort", onAbort, { once: true });
    const signal = controller.signal;
    let release: (() => void) | null = null;
    try {
      try {
        release = await this.gate.acquire(signal);
      } catch (error) {
        if (!signal.aborted) throw error;
        return "withdrawn";
      }
      if (target.kind === "core") {
        return await this.runJob(slice, workspace, signal, expired, target, usage);
      }
      const located = await untilAborted(this.locateEntries(target), signal);
      if (signal.aborted) return "withdrawn";
      if (located === null) return "failed";
      // Only the providers whose entries were located run; a warm host may
      // still hold a loader for one that has since lost its entry.
      const runnable = new Set(located.providers.map(({ provider }) => provider.id));
      return await this.runJob(
        requestFor(slice, (candidate) => runnable.has(candidate.framework)),
        workspace,
        signal,
        expired,
        located,
        usage
      );
    } catch (error) {
      if (target.kind === "core") throw error;
      // A job that rejects has failed, whatever aborted after it: a withdrawn
      // one settles with an answer instead.
      logWarn(`${P} A plugin's resolver failed; its candidates answer unsupported`, {
        plugin: target.pluginId,
        error: formatErrorMessage(error, "resolver failed"),
      });
      return "failed";
    } finally {
      release?.();
      selection.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }

  /**
   * The plugin target with each provider's entry located, or null when none
   * could be. A provider whose entry is gone or refused is left out, so its
   * candidates answer `unsupported` while its siblings' still resolve.
   */
  private async locateEntries(
    target: Extract<DispatchTarget, { kind: "plugin" }>
  ): Promise<Extract<JobTarget, { kind: "plugin" }> | null> {
    // Behind its own import: only a selection a plugin resolver answers needs it.
    const { locatePluginResolverEntry } = await import("./pluginResolverAssets.js");
    const located = await Promise.all(
      target.providers.map(async (provider) => ({
        provider,
        entryUrl: await locatePluginResolverEntry(provider),
      }))
    );
    const providers: Array<{ provider: RegisteredElementPickerProvider; entryUrl: string }> = [];
    for (const { provider, entryUrl } of located) {
      if (entryUrl !== null && isElementPickerProviderCurrent(provider)) {
        providers.push({ provider, entryUrl });
      } else {
        logWarn(`${P} A provider's resolver entry could not be loaded`, { provider: provider.id });
      }
    }
    return providers.length > 0 ? { kind: "plugin", pluginId: target.pluginId, providers } : null;
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
   * What each file holds on disk now, for a view deciding whether what it
   * holds from a resolve is stale. Read in main under the same containment and
   * size cap as a resolve's reads, and never starts the resolver process. A
   * path that is not a workspace-relative ref, lands outside the app, is gone,
   * unreadable or past the cap reads as null. Each path is read once and
   * answered once, in the order it was first named.
   */
  async sourceRevisions(
    workspaceId: string,
    paths: readonly string[]
  ): Promise<Array<{ path: string; revision: FileRevision | null }>> {
    if (this.disposed) throw hostError("HOST_DISPOSED", "the source host is shutting down");
    if (
      !Array.isArray(paths) ||
      paths.length > MAX_SOURCE_REVISION_PATHS ||
      !paths.every((entry) => typeof entry === "string")
    ) {
      throw hostError("INVALID_REQUEST", "the paths are malformed");
    }
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw hostError("UNKNOWN_WORKSPACE", "no open workspace has this id");
    const signal = workspace.lifetime.signal;
    const unique = [...new Set(paths)];
    const revisions: Array<FileRevision | null> = unique.map(() => null);
    let release: () => void;
    try {
      release = await this.revisionGate.acquire(signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      throw hostError("UNKNOWN_WORKSPACE", "the workspace was released");
    }
    try {
      let next = 0;
      const drain = async () => {
        while (next < unique.length && !signal.aborted) {
          const index = next++;
          revisions[index] = await this.currentRevision(workspace, unique[index]!, signal);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(SOURCE_REVISION_CONCURRENCY, unique.length) }, drain)
      );
    } finally {
      release();
    }
    // A workspace released mid-check answers nothing: its reads were cut short,
    // and a null for a file that is there would read as a deletion.
    if (this.disposed) throw hostError("HOST_DISPOSED", "the source host is shutting down");
    if (signal.aborted) throw hostError("UNKNOWN_WORKSPACE", "the workspace was released");
    return unique.map((path, index) => ({ path, revision: revisions[index] ?? null }));
  }

  /**
   * The files the view holds a selection on, most important first, for the
   * workspace's source tracker to keep ahead of whatever else a resolve read.
   * Advisory: it reads nothing here, never starts the resolver process, and a
   * path no resolve in the workspace has read stays untracked.
   */
  async holdSources(workspaceId: string, paths: readonly string[]): Promise<void> {
    if (this.disposed) throw hostError("HOST_DISPOSED", "the source host is shutting down");
    if (
      !Array.isArray(paths) ||
      paths.length > ELEMENT_PICKER_MAX_HELD_SOURCES ||
      !paths.every((entry) => typeof entry === "string")
    ) {
      throw hostError("INVALID_REQUEST", "the paths are malformed");
    }
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw hostError("UNKNOWN_WORKSPACE", "no open workspace has this id");
    workspace.tracker.hold(paths);
  }

  private async currentRevision(
    workspace: PickerWorkspace,
    relative: string,
    signal: AbortSignal
  ): Promise<FileRevision | null> {
    const ref = SourceFileRefSchema.safeParse({ workspaceId: workspace.id, path: relative });
    if (!ref.success) return null;
    try {
      const contained = await containSourcePath(workspace.roots, ref.data.path);
      if (!contained.ok || signal.aborted) return null;
      return await readSourceRevision(
        contained.absolute,
        RESOLVE_BUDGET_CEILINGS.maxFileBytes,
        signal
      );
    } catch {
      return null;
    }
  }

  /**
   * Stops for good: fails what is in flight, releases every workspace, retires
   * every process and waits, briefly, for them to exit.
   */
  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.unsubscribeProviders?.();
      this.unsubscribeProviders = null;
      for (const generation of [...this.live.values()]) {
        this.fail(generation, "HOST_DISPOSED", "the source host is shutting down");
      }
      this.wakePluginWaiters();
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

  private runJob(
    request: ResolveRequest,
    workspace: PickerWorkspace,
    signal: AbortSignal,
    expired: () => boolean,
    target: JobTarget,
    usage: ResolveUsage
  ): Promise<ResolveResponse> {
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: this.nextJobId++,
        request,
        roots: workspace.roots,
        signal,
        expired,
        target,
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
          usage,
        }),
        generation: null,
        posted: false,
        settled: false,
        graceTimer: null,
        settle: (outcome) => {
          if (job.settled) return;
          job.settled = true;
          signal.removeEventListener("abort", onAbort);
          if (job.graceTimer) clearTimeout(job.graceTimer);
          const generation = job.generation;
          if (generation) {
            generation.jobs.delete(job.id);
            this.armIdle(generation);
            // An idle plugin host is room for a dispatch waiting on one.
            if (generation.plugin && generation.jobs.size === 0) this.wakePluginWaiters();
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

      if (target.kind === "plugin") {
        void this.attachPluginJob(job, target).catch((error: unknown) =>
          job.settle({ ok: false, error: error as Error })
        );
        return;
      }
      let generation: Generation;
      try {
        generation = this.ensureGeneration(CORE_KEY, null);
      } catch (error) {
        job.settle({ ok: false, error: error as Error });
        return;
      }
      this.attach(job, generation);
    });
  }

  private attach(job: Job, generation: Generation): void {
    this.clearIdle(generation);
    job.generation = generation;
    generation.jobs.set(job.id, job);
    if (job.target.kind === "plugin") {
      for (const { provider } of job.target.providers) {
        generation.providers.set(provider.id, provider);
      }
    }
    if (generation.state === "ready") this.post(job);
  }

  /**
   * Finds the plugin's host, or room to start one: at {@link MAX_PLUGIN_HOSTS}
   * the longest-idle host is retired and the job waits for a process to exit.
   * Finding and attaching happen in one turn, so nothing can retire the host
   * as idle between the two.
   */
  private async attachPluginJob(job: Job, target: PluginTarget): Promise<void> {
    for (;;) {
      if (job.settled) return;
      if (this.disposed) throw hostError("HOST_DISPOSED", "the source host is shutting down");
      // A provider unloaded while this waited must not get a process loading it.
      if (!target.providers.every(({ provider }) => isElementPickerProviderCurrent(provider))) {
        throw hostError("RESOLVER_FAILED", "the provider was unloaded");
      }
      const existing = this.live.get(target.pluginId);
      if (existing) {
        this.attach(job, existing);
        return;
      }
      if (this.pluginHosts < MAX_PLUGIN_HOSTS) {
        this.attach(job, this.ensureGeneration(target.pluginId, target));
        return;
      }
      const idle = [...this.live.values()]
        .filter((generation) => generation.plugin && generation.jobs.size === 0)
        .sort((a, b) => a.idleSince - b.idleSince)[0];
      if (idle) {
        logInfo(`${P} Retiring an idle plugin host to make room`, {
          generation: idle.id,
          plugin: idle.key,
        });
        this.retire(idle);
      }
      this.pluginRoom ??= (() => {
        let wake!: () => void;
        const promise = new Promise<void>((resolve) => {
          wake = resolve;
        });
        return { promise, wake };
      })();
      const room = this.pluginRoom.promise;
      await new Promise<void>((resolve) => {
        const done = () => {
          job.signal.removeEventListener("abort", done);
          resolve();
        };
        job.signal.addEventListener("abort", done, { once: true });
        void room.then(done);
      });
    }
  }

  private wakePluginWaiters(): void {
    const room = this.pluginRoom;
    this.pluginRoom = null;
    room?.wake();
  }

  private post(job: Job): void {
    const generation = job.generation;
    if (!generation || job.posted) return;
    if (
      job.target.kind === "plugin" &&
      !job.target.providers.every(({ provider }) => isElementPickerProviderCurrent(provider))
    ) {
      // Unloaded while the job waited for its host: nothing of it gets imported.
      job.settle({ ok: false, error: hostError("RESOLVER_FAILED", "the provider was unloaded") });
      return;
    }
    job.posted = true;
    try {
      if (job.target.kind === "plugin") {
        // Before the job that needs them, on the same ordered channel.
        for (const { provider, entryUrl } of job.target.providers) {
          if (generation.sent.has(provider.id)) continue;
          generation.sent.add(provider.id);
          generation.child.postMessage({ type: "provider", providerId: provider.id, entryUrl });
        }
      }
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
      logWarn(`${P} Host did not answer a cancel; retiring it`, {
        generation: generation.id,
        key: generation.key,
      });
      this.fail(generation, "HOST_CRASHED", "the source host stopped answering");
    }, this.cancelGraceMs);
  }

  private ensureGeneration(key: string, plugin: PluginTarget | null): Generation {
    const existing = this.live.get(key);
    if (existing) return existing;
    if (this.disposed) throw hostError("HOST_DISPOSED", "the source host is shutting down");
    let child: HostChild;
    try {
      child = plugin ? this.pluginFork(plugin.pluginId) : this.fork();
    } catch (error) {
      logError(`${P} Host fork failed`, error, { key });
      throw hostError("HOST_START_FAILED", "the source host could not be started");
    }
    let markExited!: () => void;
    const generation: Generation = {
      id: ++this.generations,
      key,
      plugin: plugin !== null,
      child,
      forkedAt: performance.now(),
      state: "starting",
      jobs: new Map(),
      startTimer: null,
      killTimer: null,
      killDue: false,
      idleTimer: null,
      idleSince: 0,
      providers: new Map(),
      sent: new Set(),
      exited: new Promise<void>((resolve) => {
        markExited = resolve;
      }),
      markExited: () => markExited(),
    };
    this.live.set(key, generation);
    // Subscribed with the first plugin host, so an install without one never listens.
    if (plugin) {
      this.unsubscribeProviders ??= onElementPickerProvidersChanged(() =>
        this.retireUnloadedPlugins()
      );
    }

    child.on("spawn", () => {
      logInfo(`${P} Host spawned`, { generation: generation.id, key, pid: child.pid });
      if (generation.killDue) this.killUnexited(generation);
    });
    child.on("message", (message) => this.handleMessage(generation, message));
    // A fatal V8 error in the child. UtilityProcess is an EventEmitter, so with
    // no listener this would throw in main. The exit that follows fails the jobs.
    child.on("error", (type, location) => {
      logWarn(`${P} Host fatal error`, { generation: generation.id, key, type, location });
    });
    child.on("exit", (code) => this.handleExit(generation, code));

    generation.startTimer = setTimeout(() => {
      generation.startTimer = null;
      if (generation.state !== "starting") return;
      logWarn(`${P} Host did not start in time`, { generation: generation.id, key });
      this.fail(generation, "HOST_START_FAILED", "the source host did not start in time");
    }, this.startTimeoutMs);
    generation.startTimer.unref?.();
    return generation;
  }

  /**
   * A plugin disabled, uninstalled or reloaded: its host is retired and the
   * jobs it held fail, so nothing keeps running code the registry let go of.
   */
  private retireUnloadedPlugins(): void {
    for (const generation of [...this.live.values()]) {
      if (!generation.plugin) continue;
      for (const provider of generation.providers.values()) {
        if (isElementPickerProviderCurrent(provider)) continue;
        logInfo(`${P} Retiring the host of an unloaded plugin`, {
          generation: generation.id,
          plugin: generation.key,
        });
        this.fail(generation, "RESOLVER_FAILED", "the provider was unloaded");
        break;
      }
    }
    // A dispatch waiting for room rechecks its own providers when it wakes.
    this.wakePluginWaiters();
  }

  private isLive(generation: Generation): boolean {
    return this.live.get(generation.key) === generation;
  }

  private handleMessage(generation: Generation, raw: unknown): void {
    if (!this.isLive(generation)) return;
    const parsed = HostOutboundSchema.safeParse(raw);
    if (!parsed.success) {
      logWarn(`${P} Host sent a malformed message; retiring it`, {
        generation: generation.id,
        key: generation.key,
      });
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
          key: generation.key,
          msSinceFork: Math.round(performance.now() - generation.forkedAt),
        });
        for (const job of [...generation.jobs.values()]) this.post(job);
        this.armIdle(generation);
        return;
      }
      case "resolved": {
        const job = generation.jobs.get(message.jobId);
        if (!job) return;
        const authority = {
          roots: job.roots,
          servedRevision: (file: string) => job.access.servedRevision(file),
          servedMap: (mapUrl: string | null, revision: FileRevision) =>
            job.access.servedMap(mapUrl, revision),
        };
        const response =
          job.target.kind === "plugin"
            ? checkResolveResponseByProvider(job.request, message.response, authority)
            : checkResolveResponse(job.request, message.response, authority);
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
          key: generation.key,
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
      key: generation.key,
      code,
      msSinceFork: Math.round(performance.now() - generation.forkedAt),
    };
    if (this.isLive(generation)) {
      this.live.delete(generation.key);
      this.clearIdle(generation);
      logError(`${P} Host exited unexpectedly`, undefined, context);
    } else {
      logInfo(`${P} Host exited`, context);
    }
    const error = wasStarting
      ? hostError("HOST_START_FAILED", "the source host exited before it was ready")
      : hostError("HOST_CRASHED", "the source host exited before it answered");
    for (const job of [...generation.jobs.values()]) job.settle({ ok: false, error });
    if (generation.plugin) this.wakePluginWaiters();
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
    if (this.isLive(generation)) this.live.delete(generation.key);
    this.clearIdle(generation);
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
    noteTerminationIntent(
      { serviceName: generation.plugin ? PLUGIN_HOST_SERVICE_NAME : HOST_SERVICE_NAME },
      "retired"
    );
    this.kill(pid);
  }

  private armIdle(generation: Generation): void {
    if (!this.isLive(generation) || generation.jobs.size > 0 || this.disposed) return;
    this.clearIdle(generation);
    generation.idleSince = performance.now();
    generation.idleTimer = setTimeout(() => {
      generation.idleTimer = null;
      if (!this.isLive(generation) || generation.jobs.size > 0) return;
      logInfo(`${P} Retiring idle host`, { generation: generation.id, key: generation.key });
      this.retire(generation);
    }, this.idleMs);
    generation.idleTimer.unref?.();
  }

  private clearIdle(generation: Generation): void {
    if (generation.idleTimer) clearTimeout(generation.idleTimer);
    generation.idleTimer = null;
  }
}
