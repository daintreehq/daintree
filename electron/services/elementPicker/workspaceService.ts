import path from "node:path";
import fs from "node:fs/promises";
import type { FileRevision } from "../../../shared/elementPicker/resolution.js";
import type { ProjectContextOutcome } from "../../../shared/elementPicker/projectContext.js";
import type { ResolveResponse } from "../../../shared/elementPicker/resolver.js";
import {
  ELEMENT_PICKER_WORKSPACE_CLOSED,
  type ElementPickerSourceChangedPush,
  type ElementPickerSourceRevisionsResult,
  type ElementPickerWorkspaceOpenRequest,
  type ElementPickerWorkspaceOpenResult,
} from "../../../shared/types/ipc/elementPicker.js";
import type { ProjectStatus } from "../../../shared/types/project.js";
import { CHANNELS } from "../../ipc/channels.js";
import type { ClientEndpoint, Disposable } from "../../ipc/endpoint.js";
import { AppError } from "../../utils/errorTypes.js";
import { logWarn } from "../../utils/logger.js";
import { AdmissionGate } from "./admissionGate.js";
import { hasControlCharacter, isStrictlyInside } from "./containment.js";
import type { ElementPickerHost } from "./ElementPickerHost.js";
import { ElementPickerHostError } from "./errors.js";
import { getElementPickerHost } from "./index.js";

/**
 * The renderer's hold on Element Picker source workspaces. A view never names
 * a path: it names one of its own project's worktrees, main reads where that
 * worktree is, and the workspace is leased to the view that opened it. Every
 * later call re-checks the lease against the caller, so a workspace id that
 * leaks to another view, or another project, reads nothing on its behalf.
 */

const P = "[ElementPickerWorkspaces]";

/**
 * Workspaces one view may hold. A panel holds one; past this the oldest goes,
 * so a view that never closes what it opens spends its own leases rather than
 * crowding the host's shared registry and evicting another view's.
 */
export const MAX_LEASES_PER_ENDPOINT = 8;

/** App searches running at once across worktrees; each walks a tree on disk. */
const DISCOVERY_LIMITS = { concurrent: 2, queued: 16 };

/** The caller as main proved it: the sender's project and its endpoint. */
export interface ElementPickerWorkspaceOwner {
  projectId: string;
  endpoint: ClientEndpoint;
}

export interface ElementPickerLease {
  /** The host's workspace id, which is also the id the view names. */
  readonly workspaceId: string;
  readonly projectId: string;
  readonly endpointId: string;
  readonly panelId: string;
  readonly worktreeId: string;
  /** Canonical, absolute. */
  readonly appRoot: string;
}

type WorkspaceHost = Pick<
  ElementPickerHost,
  | "registerWorkspace"
  | "releaseWorkspace"
  | "resolve"
  | "describeProject"
  | "sourceRevisions"
  | "holdSources"
>;

/** What an app search found: canonical or not, inside the worktree or not; the service checks. */
export interface AppDiscovery {
  appRoots: string[];
  complete: boolean;
}

export interface ElementPickerWorkspaceServiceDeps {
  getProject(projectId: string): { path: string; status?: ProjectStatus } | null | undefined;
  /** The worktrees main knows for a project; null when it cannot say. */
  listWorktrees(
    projectPath: string,
    projectId: string
  ): Promise<ReadonlyArray<{ id: string; path: string }> | null>;
  getHost?: () => Promise<WorkspaceHost>;
  discoverApps?: (worktreeRoot: string, signal: AbortSignal) => Promise<AppDiscovery>;
}

interface LeaseRecord extends ElementPickerLease {
  readonly endpoint: ClientEndpoint;
}

interface EndpointRecord {
  readonly closed: Disposable;
  /** Oldest first. */
  readonly workspaceIds: Set<string>;
}

// Behind dynamic imports: the reader and the walk load on the first open, not
// with the service. The project adapters' own discovery is the one app search
// there is; an app no adapter knows is found from where its server runs.
async function discoverAdapterApps(
  worktreeRoot: string,
  signal: AbortSignal
): Promise<AppDiscovery> {
  const [{ discoverSvelteKitApps }, { createWorkspaceReader }] = await Promise.all([
    import("./projectAdapters/sveltekit/discovery.js"),
    import("./projectAdapters/reader.js"),
  ]);
  const result = await discoverSvelteKitApps(
    createWorkspaceReader(worktreeRoot, signal),
    worktreeRoot,
    { signal }
  );
  return { appRoots: result.apps.map((app) => app.appRoot), complete: result.complete };
}

export function workspaceClosedError(): AppError {
  return new AppError({ code: "NOT_FOUND", message: ELEMENT_PICKER_WORKSPACE_CLOSED });
}

function cancelledError(): AppError {
  return new AppError({
    code: "CANCELLED",
    message: "The Element Picker workspace was closed before it opened",
  });
}

function sentence(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/** A host failure as the view can act on it: reopen, fix the request, or give up. */
export function toElementPickerAppError(error: unknown): unknown {
  if (!(error instanceof ElementPickerHostError)) return error;
  const detail = sentence(error.message.replace(`${error.code}: `, ""));
  switch (error.code) {
    case "UNKNOWN_WORKSPACE":
      return workspaceClosedError();
    case "INVALID_REQUEST":
      return new AppError({ code: "VALIDATION", message: detail, cause: error });
    case "HOST_DISPOSED":
      return new AppError({ code: "CANCELLED", message: detail, cause: error });
    default:
      return new AppError({
        code: "INTERNAL",
        message: detail,
        context: { hostCode: error.code },
        cause: error,
      });
  }
}

function within(root: string, candidate: string): boolean {
  return candidate === root || isStrictlyInside(root, candidate);
}

function toRelative(worktreeRoot: string, absolute: string): string {
  const relative = path.relative(worktreeRoot, absolute);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

async function canonicalDirectory(target: string): Promise<string | null> {
  try {
    const real = await fs.realpath(target);
    return (await fs.stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** A canonical directory equal to or inside the worktree, or null. */
async function containedDirectory(worktreeRoot: string, target: string): Promise<string | null> {
  const real = await canonicalDirectory(target);
  return real !== null && within(worktreeRoot, real) ? real : null;
}

/** Where a picked app lands: worktree-relative POSIX, `.` for the worktree, nothing that climbs out. */
function appPathTarget(worktreeRoot: string, appPath: string): string | null {
  if (appPath === ".") return worktreeRoot;
  if (
    appPath.length === 0 ||
    appPath.length > 1024 ||
    hasControlCharacter(appPath) ||
    appPath.startsWith("/") ||
    appPath.includes("\\") ||
    /^[A-Za-z]:/.test(appPath)
  ) {
    return null;
  }
  const segments = appPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return path.join(worktreeRoot, ...segments);
}

/**
 * The page's origin when it is this machine's own dev server: HTTP(S) on a
 * loopback host, no credentials. Source maps are fetched from it, so anything
 * else opens a workspace that fetches none rather than one that would reach
 * out to wherever the page says it came from.
 */
export function loopbackPreviewOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  return loopback ? url.origin : undefined;
}

export class ElementPickerWorkspaceService {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly endpoints = new Map<string, EndpointRecord>();
  private readonly discoveries = new Map<string, Promise<AppDiscovery>>();
  /**
   * One registration at a time per view: making room in its own leases and
   * registering the replacement are one step, or two opens from one view could
   * both find room and overfill the host's shared registry together.
   */
  private readonly registering = new Map<string, Promise<void>>();
  private readonly gate = new AdmissionGate(DISCOVERY_LIMITS);
  /** Aborted on dispose: ends every app search, including ones several opens share. */
  private readonly lifetime = new AbortController();
  private readonly getHost: () => Promise<WorkspaceHost>;
  private readonly discoverApps: (
    worktreeRoot: string,
    signal: AbortSignal
  ) => Promise<AppDiscovery>;
  private disposed = false;

  constructor(private readonly deps: ElementPickerWorkspaceServiceDeps) {
    this.getHost = deps.getHost ?? getElementPickerHost;
    this.discoverApps = deps.discoverApps ?? discoverAdapterApps;
  }

  async open(
    owner: ElementPickerWorkspaceOwner,
    request: ElementPickerWorkspaceOpenRequest
  ): Promise<ElementPickerWorkspaceOpenResult> {
    this.assertLive(owner);
    const worktreePath = await this.worktreePathOf(owner.projectId, request.worktreeId);
    const worktreeRoot = worktreePath === null ? null : await canonicalDirectory(worktreePath);
    if (worktreeRoot === null) return { status: "unavailable", reason: "unknown-worktree" };

    let explicitApp: string | null = null;
    if (request.appPath !== undefined) {
      const target = appPathTarget(worktreeRoot, request.appPath);
      explicitApp = target === null ? null : await containedDirectory(worktreeRoot, target);
      if (explicitApp === null) return { status: "unavailable", reason: "invalid-app" };
    }
    // Where the dev server runs chooses among the apps; it is a hint, so one
    // outside the worktree is ignored rather than refused.
    const cwd =
      request.serverCwd !== undefined &&
      path.isAbsolute(request.serverCwd) &&
      !hasControlCharacter(request.serverCwd)
        ? await containedDirectory(worktreeRoot, request.serverCwd)
        : null;

    const discovery = await this.discover(worktreeRoot);
    this.assertLive(owner);
    const apps = await this.canonicalApps(worktreeRoot, discovery.appRoots);
    const scanComplete = discovery.complete;
    const appPaths = apps.map((app) => toRelative(worktreeRoot, app));

    const choice = explicitApp ?? (await this.chooseApp(worktreeRoot, cwd, apps));
    if (typeof choice !== "string") {
      return {
        status: "ambiguous",
        appPaths: choice.ambiguous.map((app) => toRelative(worktreeRoot, app)),
        scanComplete,
      };
    }

    const lease = await this.registerInTurn(owner, request, worktreeRoot, choice);
    return {
      status: "ready",
      workspaceId: lease.workspaceId,
      appPath: toRelative(worktreeRoot, lease.appRoot),
      appPaths,
      scanComplete,
    };
  }

  close(owner: ElementPickerWorkspaceOwner, workspaceId: string): { closed: boolean } {
    const lease = this.owned(owner, workspaceId);
    if (lease === null) return { closed: false };
    this.release(lease);
    return { closed: true };
  }

  /** The caller's own lease, or NOT_FOUND: an id that is closed and one that is someone else's read the same. */
  get(owner: ElementPickerWorkspaceOwner, workspaceId: string): ElementPickerLease {
    return this.require(owner, workspaceId);
  }

  async resolve(
    owner: ElementPickerWorkspaceOwner,
    request: { workspaceId: string }
  ): Promise<ResolveResponse> {
    const lease = this.require(owner, request.workspaceId);
    return this.withHost(lease, (host) => host.resolve(request, { projectId: owner.projectId }));
  }

  async describeProject(
    owner: ElementPickerWorkspaceOwner,
    workspaceId: string,
    url: string
  ): Promise<ProjectContextOutcome> {
    const lease = this.require(owner, workspaceId);
    const outcome = await this.withHost(lease, (host) => host.describeProject(workspaceId, url));
    // Every workspace call says the workspace is gone the same way, so the view reopens once.
    if (outcome.status === "unavailable" && outcome.reason === "unknown-workspace") {
      this.drop(lease);
      throw workspaceClosedError();
    }
    return outcome;
  }

  async sourceRevisions(
    owner: ElementPickerWorkspaceOwner,
    workspaceId: string,
    paths: string[]
  ): Promise<ElementPickerSourceRevisionsResult> {
    const lease = this.require(owner, workspaceId);
    const revisions: Array<{ path: string; revision: FileRevision | null }> = await this.withHost(
      lease,
      (host) => host.sourceRevisions(workspaceId, paths)
    );
    return { revisions };
  }

  async holdSources(
    owner: ElementPickerWorkspaceOwner,
    workspaceId: string,
    paths: string[]
  ): Promise<void> {
    const lease = this.require(owner, workspaceId);
    await this.withHost(lease, (host) => host.holdSources(workspaceId, paths));
  }

  /** For handler teardown: every lease goes, and nothing opens after. */
  async disposeAll(): Promise<void> {
    this.disposed = true;
    this.lifetime.abort();
    for (const lease of [...this.leases.values()]) this.release(lease);
    for (const record of this.endpoints.values()) record.closed.dispose();
    this.endpoints.clear();
  }

  private assertLive(owner: ElementPickerWorkspaceOwner): void {
    if (this.disposed || owner.endpoint.isClosed()) throw cancelledError();
  }

  private async worktreePathOf(projectId: string, worktreeId: string): Promise<string | null> {
    const project = this.deps.getProject(projectId);
    if (!project || project.status === "closed") return null;
    let worktrees: ReadonlyArray<{ id: string; path: string }> | null;
    try {
      worktrees = await this.deps.listWorktrees(project.path, projectId);
    } catch (error) {
      logWarn(`${P} Could not list the project's worktrees`, { projectId, error: String(error) });
      return null;
    }
    return worktrees?.find((worktree) => worktree.id === worktreeId)?.path ?? null;
  }

  /** One search per worktree at a time, shared by every open that asks for it meanwhile. */
  private discover(worktreeRoot: string): Promise<AppDiscovery> {
    const pending = this.discoveries.get(worktreeRoot);
    if (pending) return pending;
    const search = this.runDiscovery(worktreeRoot).finally(() => {
      if (this.discoveries.get(worktreeRoot) === search) this.discoveries.delete(worktreeRoot);
    });
    this.discoveries.set(worktreeRoot, search);
    return search;
  }

  private async runDiscovery(worktreeRoot: string): Promise<AppDiscovery> {
    const signal = this.lifetime.signal;
    let release: () => void;
    try {
      release = await this.gate.acquire(signal);
    } catch (error) {
      if (signal.aborted) throw cancelledError();
      throw toElementPickerAppError(error);
    }
    try {
      return await this.discoverApps(worktreeRoot, signal);
    } catch (error) {
      if (signal.aborted) throw cancelledError();
      // A search that failed found nothing it can vouch for; the picker still
      // works against the worktree, and the view is told the list is short.
      logWarn(`${P} App search failed`, { error: String(error) });
      return { appRoots: [], complete: false };
    } finally {
      release();
    }
  }

  /** Each app at its real path, inside the worktree, once. */
  private async canonicalApps(worktreeRoot: string, appRoots: string[]): Promise<string[]> {
    const real = await Promise.all(
      appRoots.map((appRoot) => containedDirectory(worktreeRoot, appRoot))
    );
    return [...new Set(real.filter((app): app is string => app !== null))].sort();
  }

  private async chooseApp(
    worktreeRoot: string,
    cwd: string | null,
    apps: string[]
  ): Promise<string | { ambiguous: string[] }> {
    if (cwd === null) {
      if (apps.length === 1) return apps[0]!;
      if (apps.length > 1) return { ambiguous: apps };
      return worktreeRoot;
    }
    // The server runs in an app, or somewhere inside one: that app, the
    // innermost when apps nest.
    const containing = apps.filter((app) => within(app, cwd));
    if (containing.length > 0) {
      return containing.reduce((deepest, app) => (app.length > deepest.length ? app : deepest));
    }
    // The server runs above the apps, as a workspace script does: the one
    // below it, or the user picks.
    const below = apps.filter((app) => isStrictlyInside(cwd, app));
    if (below.length === 1) return below[0]!;
    if (below.length > 1) return { ambiguous: below };
    // None of the apps found is involved: the package the server runs from.
    return (await this.packageRootOf(worktreeRoot, cwd)) ?? cwd;
  }

  private async packageRootOf(worktreeRoot: string, cwd: string): Promise<string | null> {
    const { createWorkspaceReader } = await import("./projectAdapters/reader.js");
    const reader = createWorkspaceReader(worktreeRoot, this.lifetime.signal);
    for (let dir = cwd; within(worktreeRoot, dir); dir = path.dirname(dir)) {
      try {
        if ((await reader.stat(path.join(dir, "package.json"))).isFile) return dir;
      } catch {
        // Absent, or not ours to read; keep climbing.
      }
      if (dir === worktreeRoot) break;
    }
    return null;
  }

  private async registerInTurn(
    owner: ElementPickerWorkspaceOwner,
    request: ElementPickerWorkspaceOpenRequest,
    worktreeRoot: string,
    appRoot: string
  ): Promise<LeaseRecord> {
    const endpointId = owner.endpoint.endpointId;
    const previous = this.registering.get(endpointId) ?? Promise.resolve();
    let finish!: () => void;
    const released = new Promise<void>((resolve) => (finish = resolve));
    const turn = previous.then(() => released);
    this.registering.set(endpointId, turn);
    await previous;
    try {
      this.assertLive(owner);
      return await this.register(owner, request, worktreeRoot, appRoot);
    } finally {
      finish();
      if (this.registering.get(endpointId) === turn) this.registering.delete(endpointId);
    }
  }

  private async register(
    owner: ElementPickerWorkspaceOwner,
    request: ElementPickerWorkspaceOpenRequest,
    worktreeRoot: string,
    appRoot: string
  ): Promise<LeaseRecord> {
    const { endpoint, projectId } = owner;
    let lease: LeaseRecord | null = null;
    const host = await this.hostOrThrow();
    // Room first, out of this view's own leases: the host's registry is shared,
    // and filling it would evict another view's workspace before the cap took
    // one of this view's.
    const held = this.endpoints.get(endpoint.endpointId);
    while (held !== undefined && held.workspaceIds.size >= MAX_LEASES_PER_ENDPOINT) {
      let oldestId: string | undefined;
      for (const id of held.workspaceIds) {
        oldestId = id;
        break;
      }
      if (oldestId === undefined) break;
      const oldest = this.leases.get(oldestId);
      if (oldest && this.drop(oldest)) host.releaseWorkspace(oldestId);
      else held.workspaceIds.delete(oldestId);
    }
    let workspaceId: string;
    try {
      workspaceId = await host.registerWorkspace({
        worktreePath: worktreeRoot,
        appRoot,
        previewOrigin: loopbackPreviewOrigin(request.previewOrigin),
        onSourceChanged: (change) => {
          const current = lease;
          if (current === null || this.leases.get(current.workspaceId) !== current) return;
          // Pushed to the view that holds the lease and nowhere else, and not
          // to it either once it shows another project.
          if (endpoint.isClosed() || endpoint.projectId !== current.projectId) return;
          const payload: ElementPickerSourceChangedPush = {
            workspaceId: current.workspaceId,
            panelId: current.panelId,
            file: change.file,
            revision: change.revision,
          };
          try {
            endpoint.send({
              type: "event",
              channel: CHANNELS.ELEMENT_PICKER_SOURCE_CHANGED,
              args: [payload],
            });
          } catch {
            // A view going away; its close releases the lease.
          }
        },
      });
    } catch (error) {
      throw toElementPickerAppError(error);
    }
    // The view went while the host was opening: nobody is left to close it.
    if (this.disposed || endpoint.isClosed()) {
      host.releaseWorkspace(workspaceId);
      throw cancelledError();
    }
    lease = {
      workspaceId,
      projectId,
      endpointId: endpoint.endpointId,
      panelId: request.panelId,
      worktreeId: request.worktreeId,
      appRoot,
      endpoint,
    };
    this.leases.set(workspaceId, lease);
    this.track(lease);
    return lease;
  }

  private track(lease: LeaseRecord): void {
    let record = this.endpoints.get(lease.endpointId);
    if (!record) {
      const endpointId = lease.endpointId;
      record = {
        closed: lease.endpoint.onClose(() => this.releaseEndpoint(endpointId)),
        workspaceIds: new Set(),
      };
      this.endpoints.set(endpointId, record);
    }
    record.workspaceIds.add(lease.workspaceId);
    for (const workspaceId of record.workspaceIds) {
      if (record.workspaceIds.size <= MAX_LEASES_PER_ENDPOINT) break;
      const oldest = this.leases.get(workspaceId);
      if (oldest) this.release(oldest);
      else record.workspaceIds.delete(workspaceId);
    }
  }

  private releaseEndpoint(endpointId: string): void {
    const record = this.endpoints.get(endpointId);
    if (!record) return;
    for (const workspaceId of [...record.workspaceIds]) {
      const lease = this.leases.get(workspaceId);
      if (lease) this.release(lease);
    }
    this.endpoints.delete(endpointId);
  }

  private require(owner: ElementPickerWorkspaceOwner, workspaceId: string): LeaseRecord {
    const lease = this.owned(owner, workspaceId);
    if (lease === null) throw workspaceClosedError();
    return lease;
  }

  private owned(owner: ElementPickerWorkspaceOwner, workspaceId: string): LeaseRecord | null {
    const lease = this.leases.get(workspaceId);
    if (
      !lease ||
      lease.projectId !== owner.projectId ||
      lease.endpointId !== owner.endpoint.endpointId
    ) {
      return null;
    }
    return lease;
  }

  private release(lease: LeaseRecord): void {
    if (!this.drop(lease)) return;
    // The host is loaded by the time any lease exists; a host that has since
    // shut down released the workspace itself.
    void this.getHost().then(
      (host) => host.releaseWorkspace(lease.workspaceId),
      () => undefined
    );
  }

  /** Forgets a lease without asking the host, for one the host has already let go of. */
  private drop(lease: LeaseRecord): boolean {
    if (this.leases.get(lease.workspaceId) !== lease) return false;
    this.leases.delete(lease.workspaceId);
    const record = this.endpoints.get(lease.endpointId);
    if (record) {
      record.workspaceIds.delete(lease.workspaceId);
      if (record.workspaceIds.size === 0) {
        record.closed.dispose();
        this.endpoints.delete(lease.endpointId);
      }
    }
    return true;
  }

  private async hostOrThrow(): Promise<WorkspaceHost> {
    try {
      return await this.getHost();
    } catch (error) {
      throw toElementPickerAppError(error);
    }
  }

  private async withHost<T>(
    lease: LeaseRecord,
    call: (host: WorkspaceHost) => Promise<T>
  ): Promise<T> {
    const host = await this.hostOrThrow();
    let result: T;
    try {
      result = await call(host);
    } catch (error) {
      // The host let the workspace go (its registry's bound, or a shutdown):
      // so does the lease, and the view reopens.
      if (error instanceof ElementPickerHostError && error.code === "UNKNOWN_WORKSPACE") {
        this.drop(lease);
      }
      throw toElementPickerAppError(error);
    }
    // Released while the call was out: what came back is the release cancelling
    // it, not an answer, and the view hears the workspace is gone.
    if (this.leases.get(lease.workspaceId) !== lease) throw workspaceClosedError();
    return result;
  }
}
