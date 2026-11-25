import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientEndpoint } from "../../endpoint.js";

/** This machine's views by WebContents id, as `webContents.fromId` finds them. */
const views = vi.hoisted(
  () => new Map<number, { loading: boolean; crashed: boolean; destroyed: boolean }>()
);
vi.mock("electron", () => ({
  webContents: {
    fromId: (id: number) => {
      const view = views.get(id);
      return view
        ? {
            isDestroyed: () => view.destroyed,
            isCrashed: () => view.crashed,
            isLoadingMainFrame: () => view.loading,
          }
        : undefined;
    },
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  app: { getPath: () => "/tmp", isPackaged: false, on: vi.fn() },
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: () => ({ id: 7 }),
}));

/**
 * The help-session service, reduced to the lanes it holds with no view and
 * the take-overs asked of it. Its own suite covers the take-over itself.
 */
const lanes = vi.hoisted(() => ({
  detached: new Map<string, number[]>(),
  detachedListeners: new Set<(projectId: string) => void>(),
  adopt: vi.fn(),
}));
vi.mock("../../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    detachedProjectIds: () => [...lanes.detached].filter(([, s]) => s.length > 0).map(([p]) => p),
    detachedSlots: (projectId: string) => lanes.detached.get(projectId) ?? [],
    addLaneDetachedListener: (listener: (projectId: string) => void) => {
      lanes.detachedListeners.add(listener);
      return () => lanes.detachedListeners.delete(listener);
    },
    adoptDetachedSession: lanes.adopt,
    revokeByWebContentsId: vi.fn(async () => {}),
    revokeSession: vi.fn(async () => {}),
  },
}));

const { registerHelpHandlers } = await import("../help.js");
const { getEndpointRegistry, _resetEndpointRegistryForTesting } = await import(
  "../../endpointRegistry.js"
);
const { setMcpDriveTargetResolver } = await import(
  "../../../services/mcp-server/driveTarget.js"
);
const { publishHelpSessionService, resetHelpSessionRuntimeForTests } = await import(
  "../../../services/helpSessionRuntime.js"
);

function localView(handle: number, projectId: string) {
  views.set(handle, { loading: false, crashed: false, destroyed: false });
  let closed = false;
  const closeListeners = new Set<() => void>();
  const endpoint = {
    endpointId: `local-${handle}`,
    clientId: "local",
    projectId,
    kind: "local-view",
    handle,
    send: () => {},
    request: async () => undefined,
    onClose: (cb: () => void) => {
      closeListeners.add(cb);
      return { dispose: () => closeListeners.delete(cb) };
    },
    isClosed: () => closed,
  } as unknown as ClientEndpoint;
  return {
    endpoint,
    close: () => {
      closed = true;
      for (const cb of [...closeListeners]) cb();
    },
  };
}

function laneDetached(projectId: string, slots: number[]): void {
  lanes.detached.set(projectId, slots);
  for (const listener of [...lanes.detachedListeners]) listener(projectId);
}

const adoptedLane = (sessionId: string) => ({
  status: "adopted" as const,
  lane: {
    sessionId,
    terminalId: `t-${sessionId}`,
    agentId: "claude",
    cwd: null,
    title: null,
    agentState: null,
    waitingReason: null,
    lastStateChange: null,
    cols: null,
    rows: null,
  },
});

/** Lets every queued pass, and the take-overs it awaits, run to the end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a window here taking over its project's assistant left with no view (#18165)", () => {
  const cleanups: Array<() => void> = [];

  beforeEach(async () => {
    resetHelpSessionRuntimeForTests();
    _resetEndpointRegistryForTesting();
    const { helpSessionService } = await import("../../../services/HelpSessionService.js");
    publishHelpSessionService(helpSessionService as never);
    lanes.adopt.mockImplementation(async (_projectId: string, slot: number) =>
      adoptedLane(`s${slot}`)
    );
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    views.clear();
    lanes.detached.clear();
    lanes.detachedListeners.clear();
    lanes.adopt.mockReset();
  });

  it("takes it over with Host mode off as soon as it is left with no view, panel closed", async () => {
    const view = localView(42, "proj");
    getEndpointRegistry().add(view.endpoint);
    cleanups.push(registerHelpHandlers());

    laneDetached("proj", [0]);
    await vi.waitFor(() => expect(lanes.adopt).toHaveBeenCalledTimes(1));
    expect(lanes.adopt).toHaveBeenCalledWith("proj", 0, 42, expect.any(Function), {
      keepRestoreIntent: true,
      windowId: 7,
    });
  });

  it("waits for a window that is still loading, and takes it over once that view is ready", async () => {
    const view = localView(42, "proj");
    views.get(42)!.loading = true;
    getEndpointRegistry().add(view.endpoint);
    cleanups.push(registerHelpHandlers());

    laneDetached("proj", [0]);
    await settle();
    expect(lanes.adopt).not.toHaveBeenCalled();

    // As `noteViewReady` announces each project with an assistant left with no view.
    views.get(42)!.loading = false;
    laneDetached("proj", [0]);
    await vi.waitFor(() => expect(lanes.adopt).toHaveBeenCalledTimes(1));
  });

  it("leaves it alone while Host-mode routing finds nobody driving, and takes it over once routing is off", async () => {
    const view = localView(42, "proj");
    getEndpointRegistry().add(view.endpoint);
    const offRouting = setMcpDriveTargetResolver(() => ({ state: "vacant" }));
    cleanups.push(offRouting);
    cleanups.push(registerHelpHandlers());

    laneDetached("proj", [0]);
    await settle();
    expect(lanes.adopt).not.toHaveBeenCalled();

    // Nothing else moves: turning routing off alone must start the pass.
    offRouting();
    await vi.waitFor(() => expect(lanes.adopt).toHaveBeenCalledTimes(1));
    expect(lanes.adopt.mock.calls[0]!.slice(0, 3)).toEqual(["proj", 0, 42]);
  });

  it("takes it over when the project's window opens after it was left with no view", async () => {
    cleanups.push(registerHelpHandlers());
    laneDetached("proj", [0, 1]);
    await settle();
    expect(lanes.adopt).not.toHaveBeenCalled();

    getEndpointRegistry().add(localView(42, "proj").endpoint);
    await vi.waitFor(() => expect(lanes.adopt).toHaveBeenCalledTimes(2));
    expect(lanes.adopt.mock.calls.map(([projectId, slot, handle]) => [projectId, slot, handle])).toEqual(
      [
        ["proj", 0, 42],
        ["proj", 1, 42],
      ]
    );
  });

  it("never hands it to another project's window, and stops taking over once unregistered", async () => {
    getEndpointRegistry().add(localView(41, "other").endpoint);
    const unregister = registerHelpHandlers();
    laneDetached("proj", [0]);
    await settle();
    expect(lanes.adopt).not.toHaveBeenCalled();

    unregister();
    getEndpointRegistry().add(localView(42, "proj").endpoint);
    laneDetached("proj", [0]);
    await settle();
    expect(lanes.adopt).not.toHaveBeenCalled();
  });
});
