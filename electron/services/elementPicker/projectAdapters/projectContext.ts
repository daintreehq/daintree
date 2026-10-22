import {
  ProjectContextSchema,
  type ProjectContextOutcome,
} from "../../../../shared/elementPicker/projectContext.js";
import { logWarn } from "../../../utils/logger.js";
import { AdmissionGate } from "../admissionGate.js";
import { ElementPickerHostError } from "../errors.js";
import type { PickerWorkspace } from "../workspaceRegistry.js";
import { PROJECT_ADAPTERS } from "./catalog.js";
import { joinPath, readJsonFile } from "./fs.js";
import { createWorkspaceReader } from "./reader.js";
import type { ProjectAdapter, ProjectAdapterRegistration } from "./types.js";

const P = "[ElementPickerProjectContext]";

/**
 * From the request to its answer, queueing and loading the adapter included.
 * The legacy picker waited this long for the same reading before giving up on
 * it; a route walk that has not finished by now is answering a page the user
 * has already looked at.
 */
export const PROJECT_CONTEXT_DEADLINE_MS = 3_000;

/**
 * Its own limits, not the resolver gate's: a slow walk of a large tree must
 * never hold up a selection's resolve, and a burst of route lookups must never
 * take resolve slots.
 */
export const PROJECT_CONTEXT_ADMISSION = { concurrent: 2, queued: 16 } as const;

export interface ProjectContextServiceOptions {
  adapters?: readonly ProjectAdapterRegistration[];
  deadlineMs?: number;
}

type Unavailable = Extract<ProjectContextOutcome, { status: "unavailable" }>["reason"];

const unavailable = (reason: Unavailable): ProjectContextOutcome => ({
  status: "unavailable",
  reason,
});

/** Settles when `work` does or `signal` aborts, whichever is first; a late result is dropped. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Project context for the core picker: optional, bounded, and on no selection's
 * path. Every request settles within its deadline with an outcome and never
 * rejects, whatever an adapter does, including never answering at all: an
 * adapter that hangs is abandoned, and its slot freed, when the deadline
 * passes. Nothing is cached between requests, because routes are exactly what
 * an agent adds while the preview is open.
 */
export class ProjectContextService {
  private readonly adapters: readonly ProjectAdapterRegistration[];
  private readonly deadlineMs: number;
  private readonly gate = new AdmissionGate(PROJECT_CONTEXT_ADMISSION);
  private readonly loaded = new Map<string, Promise<ProjectAdapter>>();

  constructor(options: ProjectContextServiceOptions = {}) {
    this.adapters = options.adapters ?? PROJECT_ADAPTERS;
    this.deadlineMs = options.deadlineMs ?? PROJECT_CONTEXT_DEADLINE_MS;
  }

  async describe(
    workspace: PickerWorkspace,
    url: string,
    signal?: AbortSignal
  ): Promise<ProjectContextOutcome> {
    const controller = new AbortController();
    let expired = false;
    const deadline = setTimeout(() => {
      if (controller.signal.aborted) return;
      expired = true;
      controller.abort();
    }, this.deadlineMs);
    const sources = [signal, workspace.lifetime.signal].filter(
      (source): source is AbortSignal => source !== undefined
    );
    const onAbort = () => controller.abort();
    for (const source of sources) {
      if (source.aborted) controller.abort();
      else source.addEventListener("abort", onAbort, { once: true });
    }

    let release: (() => void) | undefined;
    try {
      let pathname: string;
      try {
        pathname = new URL(url, "http://localhost").pathname;
      } catch {
        return unavailable("failed");
      }
      release = await this.gate.acquire(controller.signal);
      return await untilAborted(
        this.read(workspace, pathname, controller.signal),
        controller.signal
      );
    } catch (error) {
      if (controller.signal.aborted) return unavailable(expired ? "budget-exhausted" : "cancelled");
      if (error instanceof ElementPickerHostError && error.code === "HOST_BUSY") {
        return unavailable("busy");
      }
      logWarn(`${P} Project context failed`, { workspaceId: workspace.id, error: String(error) });
      return unavailable("failed");
    } finally {
      release?.();
      clearTimeout(deadline);
      for (const source of sources) source.removeEventListener("abort", onAbort);
      // However it settled, nothing still reading for this request is wanted.
      controller.abort();
    }
  }

  private async read(
    workspace: PickerWorkspace,
    pathname: string,
    signal: AbortSignal
  ): Promise<ProjectContextOutcome> {
    const { roots } = workspace;
    const reader = createWorkspaceReader(roots.worktreePath, signal);
    const manifest = await readJsonFile(reader, joinPath(roots.appRoot, "package.json"), {
      signal,
    });
    if (!manifest) return { status: "none" };
    const registration = this.adapters.find((candidate) => candidate.detects(manifest));
    if (!registration) return { status: "none" };
    const adapter = await this.load(registration);
    signal.throwIfAborted();
    const context = await adapter.describe({
      workspaceId: workspace.id,
      roots,
      pathname,
      reader,
      signal,
    });
    const parsed = ProjectContextSchema.safeParse(context);
    if (!parsed.success) {
      logWarn(`${P} An adapter described a project outside the contract`, {
        workspaceId: workspace.id,
        adapter: registration.id,
      });
      return unavailable("failed");
    }
    return { status: "described", context: parsed.data };
  }

  /** One load per adapter for the service's life. A failed load is not kept, so the next request tries again. */
  private load(registration: ProjectAdapterRegistration): Promise<ProjectAdapter> {
    const existing = this.loaded.get(registration.id);
    if (existing) return existing;
    const pending = Promise.resolve().then(() => registration.load());
    this.loaded.set(registration.id, pending);
    pending.catch(() => {
      if (this.loaded.get(registration.id) === pending) this.loaded.delete(registration.id);
    });
    return pending;
  }
}
