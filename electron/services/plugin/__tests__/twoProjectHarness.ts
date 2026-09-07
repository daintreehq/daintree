import { vi, type Mock } from "vitest";
import path from "path";

/**
 * A two-project fixture for the confused-deputy suite: two registered projects
 * (A and B), each with its own renderer, with B focused. Everything a plugin
 * host or dispatcher consults to answer "which renderer?" — the app-global
 * `webContents.id → projectId` map, the focused-view lookup, and the project
 * store — is served from this one state, so a test can say "B is focused, A is
 * evicted" in one line and then assert where a call actually landed.
 *
 * Deliberately free of `vi.mock` itself: the mock factories in the test file
 * import this module, so it must not depend on anything it mocks.
 */

export const PROJECT_A = "project-a";
export const PROJECT_B = "project-b";

/** The minimum of `Electron.WebContents` the plugin main-process code touches. */
export interface FakeWebContents {
  readonly id: number;
  isDestroyed(): boolean;
  send: Mock;
  once(event: string, handler: () => void): void;
  removeListener(event: string, handler: () => void): void;
  /** Fire `destroyed`, as an evicted-and-torn-down view would. */
  destroy(): void;
}

interface ViewRecord {
  webContents: FakeWebContents;
  projectId: string;
  cached: boolean;
}

const views = new Map<number, ViewRecord>();
const projectRoots = new Map<string, string>();
let focusedProjectId: string | null = null;
let nextWebContentsId = 1;

function makeWebContents(id: number): FakeWebContents {
  const destroyedHandlers = new Set<() => void>();
  let destroyed = false;
  return {
    id,
    isDestroyed: () => destroyed,
    send: vi.fn(),
    once(event: string, handler: () => void) {
      if (event === "destroyed") destroyedHandlers.add(handler);
    },
    removeListener(event: string, handler: () => void) {
      if (event === "destroyed") destroyedHandlers.delete(handler);
    },
    destroy() {
      destroyed = true;
      // `once`, so a handler fires at most one time — matching Electron, and
      // keeping a re-destroy from re-resolving a settled round-trip.
      const handlers = [...destroyedHandlers];
      destroyedHandlers.clear();
      for (const handler of handlers) handler();
    },
  };
}

/** Clear every project, view and focus. Call from `beforeEach`. */
export function resetTwoProjectFixture(): void {
  views.clear();
  projectRoots.clear();
  focusedProjectId = null;
  nextWebContentsId = 1;
}

/**
 * Register a project with a live renderer. `cached: true` marks the view as
 * evicted-but-retained — still a live renderer, just not the visible one.
 */
export function openProject(
  projectId: string,
  options: { root?: string; cached?: boolean } = {}
): FakeWebContents {
  const webContents = makeWebContents(nextWebContentsId++);
  views.set(webContents.id, { webContents, projectId, cached: options.cached ?? false });
  projectRoots.set(projectId, options.root ?? path.join(path.sep, "repos", projectId));
  return webContents;
}

/**
 * Drop a project's views — the renderer is gone (evicted and torn down, or the
 * project was closed). The project itself stays registered, because the
 * interesting failure is "the plugin's project is still loaded, its view is
 * not".
 */
export function closeProjectViews(projectId: string): void {
  for (const [id, record] of [...views]) {
    if (record.projectId !== projectId) continue;
    record.webContents.destroy();
    views.delete(id);
  }
}

/** Point the focused-window lookup at a project (or at nothing). */
export function focusProject(projectId: string | null): void {
  focusedProjectId = projectId;
}

/** The absolute root registered for a project. */
export function projectRootOf(projectId: string): string {
  const root = projectRoots.get(projectId);
  if (!root) throw new Error(`twoProjectHarness: project "${projectId}" is not open`);
  return root;
}

/**
 * The ids of every live view that received `channel`, across both projects.
 * One call answers both halves of a confused-deputy assertion: who got it, and
 * — because every view in the fixture is scanned — who did not.
 */
export function recipientIdsOf(channel: string): number[] {
  const ids: number[] = [];
  for (const record of views.values()) {
    if (record.webContents.send.mock.calls.some((call) => call[0] === channel)) {
      ids.push(record.webContents.id);
    }
  }
  return ids.sort((a, b) => a - b);
}

/** The payload of the last `channel` send to a view, for reading a request id. */
export function lastPayloadTo(
  webContents: FakeWebContents,
  channel: string
): Record<string, unknown> {
  const calls = webContents.send.mock.calls.filter((call) => call[0] === channel);
  const payload = calls[calls.length - 1]?.[1];
  if (!payload || typeof payload !== "object") {
    throw new Error(`twoProjectHarness: no ${channel} send recorded for wc ${webContents.id}`);
  }
  return payload as Record<string, unknown>;
}

function liveViews(): ViewRecord[] {
  return [...views.values()].filter((record) => !record.webContents.isDestroyed());
}

/** `electron`'s `webContents.fromId`, for the prompt dispatcher's cancel path. */
export function webContentsFromId(id: number): FakeWebContents | undefined {
  const record = views.get(id);
  return record && !record.webContents.isDestroyed() ? record.webContents : undefined;
}

/** The subset of `window/webContentsRegistry.js` this suite's code under test reads. */
export function webContentsRegistryMock(): Record<string, unknown> {
  return {
    getWebContentsForProject: (projectId: string) =>
      liveViews()
        .filter((record) => record.projectId === projectId)
        .map((record) => record.webContents),
    isCachedViewWebContents: (id: number) => views.get(id)?.cached === true,
    hasRegisteredProjectViews: () => liveViews().length > 0,
    getAllAppWebContents: () => liveViews().map((record) => record.webContents),
    getProjectForWebContents: (id: number) => views.get(id)?.projectId ?? null,
    getWindowForWebContents: () => null,
    getAppWebContents: () => undefined,
  };
}

function focusedWebContents(): FakeWebContents | null {
  if (focusedProjectId === null) return null;
  const record = liveViews().find((r) => r.projectId === focusedProjectId);
  return record?.webContents ?? null;
}

/** The subset of `window/windowRef.js` the ambient (unbound) path reads. */
export function windowRefMock(): Record<string, unknown> {
  const context = {
    browserWindow: { isDestroyed: () => false },
    services: {
      projectViewManager: {
        getActiveView: () => {
          const webContents = focusedWebContents();
          return webContents ? { webContents } : null;
        },
      },
    },
  };
  return {
    getWindowRegistry: () => ({ getPrimary: () => context, all: () => [context] }),
    getProjectViewManager: () => null,
    setWindowRegistry: () => {},
    setProjectViewManager: () => {},
    setMainWindow: () => {},
    getMainWindow: () => null,
  };
}

/**
 * The app-global "current project" — the focused one, which is exactly the
 * ambient answer a bound host must never take. A single instance so a test can
 * assert the ambient lookup was never consulted.
 */
export const projectStoreMock = {
  getCurrentProject: vi.fn(() =>
    focusedProjectId === null
      ? null
      : { id: focusedProjectId, path: projectRootOf(focusedProjectId) }
  ),
  getProjectById: vi.fn((id: string) =>
    projectRoots.has(id) ? { id, path: projectRootOf(id) } : null
  ),
};
