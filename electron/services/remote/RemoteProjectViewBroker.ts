import type { Project } from "../../../shared/types/project.js";
import type { ProjectViewManager } from "../../window/ProjectViewManager.js";
import type { WindowContext } from "../../window/WindowRegistry.js";
import type {
  RemoteRendererBinding,
  RemoteRendererPanelRegistry,
} from "./RemoteRendererPanelRegistry.js";

const DEFAULT_REMOTE_VIEW_READY_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CONCURRENT_MATERIALIZATIONS = 2;

export type RemoteProjectViewErrorCode =
  | "NOT_FOUND"
  | "HOST_UI_UNAVAILABLE"
  | "HOST_RESOURCE_PRESSURE"
  | "CANCELLED"
  | "TIMEOUT"
  | "VIEW_INVALIDATED"
  | "HOST_SHUTDOWN";

export class RemoteProjectViewError extends Error {
  constructor(
    readonly code: RemoteProjectViewErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RemoteProjectViewError";
  }
}

export interface RemoteProjectViewBinding {
  webContentsId: number;
  projectId: string;
  generation: number;
}

export interface RemoteProjectViewLease extends RemoteProjectViewBinding {
  release(): void;
}

interface ProjectSource {
  getProjectById(projectId: string): Project | null;
}

type WindowSource = () => WindowContext[];

interface PendingMaterialization {
  owner: WindowContext;
  manager: ProjectViewManager;
  controller: AbortController;
  promise: Promise<RemoteProjectViewBinding>;
  waiters: number;
}

export class RemoteProjectViewBroker {
  private readonly pending = new Map<string, PendingMaterialization>();
  private readonly activeReleases = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly projects: ProjectSource,
    private readonly windows: WindowSource,
    private readonly rendererBindings: Pick<
      RemoteRendererPanelRegistry,
      "getBinding" | "subscribe"
    >,
    private readonly readyTimeoutMs = DEFAULT_REMOTE_VIEW_READY_TIMEOUT_MS,
    private readonly maxConcurrentMaterializations = DEFAULT_MAX_CONCURRENT_MATERIALIZATIONS
  ) {}

  async ensureBackgroundView(
    projectId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<RemoteProjectViewLease> {
    if (this.disposed) throw this.error("HOST_SHUTDOWN", "Remote view broker is stopped");
    const project = this.projects.getProjectById(projectId);
    if (!project) throw this.error("NOT_FOUND", "Project was not found");
    if (options.signal?.aborted) throw this.error("CANCELLED", "Remote view request cancelled");

    let pending = this.pending.get(projectId);
    if (!pending) {
      if (this.pending.size >= this.maxConcurrentMaterializations) {
        throw this.error("HOST_RESOURCE_PRESSURE", "Remote view capacity is busy");
      }
      const owner = this.selectOwner(projectId);
      const manager = owner.services.projectViewManager!;
      const controller = new AbortController();
      const created: PendingMaterialization = {
        owner,
        manager,
        controller,
        promise: Promise.resolve({ webContentsId: -1, projectId, generation: -1 }),
        waiters: 0,
      };
      created.promise = this.materialize(owner, manager, project, controller.signal).finally(() => {
        if (this.pending.get(projectId) === created) this.pending.delete(projectId);
      });
      this.pending.set(projectId, created);
      pending = created;
    }

    pending.waiters += 1;
    const releaseHold = pending.manager.acquireBackgroundViewHold(projectId);
    let keepHold = false;
    try {
      const binding = await this.awaitCaller(pending.promise, options.signal);
      if (this.disposed) throw this.error("HOST_SHUTDOWN", "Remote view broker is stopped");
      this.assertCurrentOwner(pending.owner, pending.manager);
      this.assertCurrentBinding(pending.manager, {
        ...binding,
        status: "available",
      });
      const release = this.trackLeaseRelease(releaseHold);
      keepHold = true;
      return { ...binding, release };
    } finally {
      pending.waiters -= 1;
      if (!keepHold) releaseHold();
      if (pending.waiters === 0 && options.signal?.aborted) {
        pending.controller.abort();
        if (this.pending.get(projectId) === pending) this.pending.delete(projectId);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) pending.controller.abort();
    this.pending.clear();
    for (const release of [...this.activeReleases]) release();
  }

  private selectOwner(projectId: string): WindowContext {
    const candidates = this.windows().filter(
      (context) =>
        !context.abortController.signal.aborted &&
        !context.browserWindow.isDestroyed() &&
        context.services.projectViewManager &&
        !context.services.projectViewManager.disposed
    );
    if (candidates.length === 0) {
      throw this.error("HOST_UI_UNAVAILABLE", "Open a Daintree window to launch an agent");
    }
    const currentBinding = this.rendererBindings.getBinding(projectId);
    const bound = currentBinding
      ? candidates.find(
          (context) =>
            context.services.projectViewManager!.getProjectIdForWebContents(
              currentBinding.webContentsId
            ) === projectId
        )
      : undefined;
    if (bound) return bound;
    const active = candidates.find(
      (context) => context.services.projectViewManager!.getActiveProjectId() === projectId
    );
    if (active) return active;
    const cached = candidates.find((context) =>
      context.services
        .projectViewManager!.getAllViews()
        .some((entry) => entry.projectId === projectId)
    );
    if (cached) return cached;
    const available = candidates.find((context) =>
      context.services.projectViewManager!.canMaterializeBackgroundView(projectId)
    );
    if (available) return available;
    throw this.error(
      "HOST_RESOURCE_PRESSURE",
      "Not enough memory is available to prepare the project view"
    );
  }

  private async materialize(
    owner: WindowContext,
    manager: ProjectViewManager,
    project: Project,
    signal: AbortSignal
  ): Promise<RemoteProjectViewBinding> {
    let createdWebContentsId: number | null = null;
    const operationController = new AbortController();
    let interrupt!: (error: RemoteProjectViewError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      interrupt = reject;
    });
    const onAbort = () => {
      operationController.abort();
      interrupt(this.error("CANCELLED", "Remote view request cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      interrupt(this.error("TIMEOUT", "Project view did not become ready in time"));
      operationController.abort();
    }, this.readyTimeoutMs);
    timer.unref?.();
    try {
      if (signal.aborted) onAbort();
      const result = await Promise.race([
        manager.ensureBackgroundView(project.id, project.path, operationController.signal),
        interrupted,
      ]);
      const webContentsId = result.view.webContents.id;
      if (result.isNew) createdWebContentsId = webContentsId;
      this.assertCurrentOwner(owner, manager);
      if (result.isNew && !manager.canCreateBackgroundView()) {
        throw this.error(
          "HOST_RESOURCE_PRESSURE",
          "Not enough memory is available to prepare the project view"
        );
      }
      const binding = await Promise.race([
        this.waitForRendererBinding(manager, project.id, webContentsId, operationController.signal),
        interrupted,
      ]);
      this.assertCurrentOwner(owner, manager);
      this.assertCurrentBinding(manager, binding);
      manager.finalizeBackgroundView(project.id, webContentsId);
      this.assertCurrentOwner(owner, manager);
      this.assertCurrentBinding(manager, binding);
      return {
        webContentsId,
        projectId: project.id,
        generation: binding.generation,
      };
    } catch (error) {
      if (createdWebContentsId !== null) {
        manager.destroyBackgroundView(project.id, createdWebContentsId);
      }
      if (error instanceof RemoteProjectViewError) throw error;
      if (signal.aborted) throw this.error("CANCELLED", "Remote view request cancelled");
      throw this.error("VIEW_INVALIDATED", "Project view became unavailable");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private waitForRendererBinding(
    manager: ProjectViewManager,
    projectId: string,
    webContentsId: number,
    signal: AbortSignal
  ): Promise<RemoteRendererBinding> {
    if (signal.aborted) {
      return Promise.reject(this.error("CANCELLED", "Remote view request cancelled"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        unsubscribe();
        unsubscribeInvalidated();
        signal.removeEventListener("abort", onAbort);
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const inspect = (binding: RemoteRendererBinding | null) => {
        if (!binding || binding.projectId !== projectId) return;
        if (binding.webContentsId !== webContentsId) {
          if (binding.status === "evicted") return;
          settle(() => reject(this.error("VIEW_INVALIDATED", "Project view binding changed")));
          return;
        }
        if (binding.status === "evicted") {
          settle(() => reject(this.error("VIEW_INVALIDATED", "Project view binding changed")));
          return;
        }
        if (binding.status === "available") settle(() => resolve(binding));
      };
      const onAbort = () =>
        settle(() => reject(this.error("CANCELLED", "Remote view request cancelled")));
      const unsubscribe = this.rendererBindings.subscribe(inspect);
      const unsubscribeInvalidated = manager.onViewInvalidated((invalidProjectId, invalidWcId) => {
        if (invalidProjectId !== projectId || invalidWcId !== webContentsId) return;
        settle(() => reject(this.error("VIEW_INVALIDATED", "Project view was evicted")));
      });
      signal.addEventListener("abort", onAbort, { once: true });
      inspect(this.rendererBindings.getBinding(projectId));
    });
  }

  private assertCurrentOwner(owner: WindowContext, manager: ProjectViewManager): void {
    if (
      !this.windows().includes(owner) ||
      owner.abortController.signal.aborted ||
      owner.browserWindow.isDestroyed() ||
      owner.services.projectViewManager !== manager ||
      manager.disposed ||
      manager.win.isDestroyed()
    ) {
      throw this.error("VIEW_INVALIDATED", "Project view owner is unavailable");
    }
  }

  private assertCurrentBinding(manager: ProjectViewManager, binding: RemoteRendererBinding): void {
    if (
      manager.getProjectIdForWebContents(binding.webContentsId) !== binding.projectId ||
      binding.status !== "available"
    ) {
      throw this.error("VIEW_INVALIDATED", "Project view binding changed");
    }
    const current = this.rendererBindings.getBinding(binding.projectId);
    if (
      !current ||
      current.webContentsId !== binding.webContentsId ||
      current.generation !== binding.generation ||
      current.status !== "available"
    ) {
      throw this.error("VIEW_INVALIDATED", "Project view generation changed");
    }
  }

  private awaitCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) {
      return Promise.reject(this.error("CANCELLED", "Remote view request cancelled"));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(this.error("CANCELLED", "Remote view request cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      void promise.then(
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

  private trackLeaseRelease(releaseHold: () => void): () => void {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeReleases.delete(release);
      releaseHold();
    };
    this.activeReleases.add(release);
    return release;
  }

  private error(code: RemoteProjectViewErrorCode, message: string): RemoteProjectViewError {
    return new RemoteProjectViewError(code, message);
  }
}
