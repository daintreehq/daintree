// @vitest-environment jsdom
/**
 * The full-screen notice for agent panes (#16357): it follows the pane's screen
 * from the terminal service, belongs only to agent panes, and once closed stays
 * closed for the pane's lifetime, through the unmount a worktree switch causes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
  },
  agentSettingsClient: { get: vi.fn().mockResolvedValue({}) },
  systemClient: { getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }) },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  createTerminalPaintPlane: () => ({
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
  }),
}));

const saveNormalized = vi.hoisted(() => vi.fn());
vi.mock("../../../store/slices/panelRegistry/persistence", async () => {
  const actual = await vi.importActual<
    typeof import("../../../store/slices/panelRegistry/persistence")
  >("../../../store/slices/panelRegistry/persistence");
  return { ...actual, saveNormalized };
});

const { usePanelStore } = await import("@/store/panelStore");
const accessor = await import("@/services/terminal/terminalInstanceServiceAccessor");
const { altScreenNoticeAgentId, useAgentAltScreenBanner } =
  await import("../useAgentAltScreenBanner");
const { deriveTerminalChrome } = await import("@/utils/terminalChrome");
const { makeSurface } = await import("@/services/terminal/paintFabric/__tests__/fakePaintPlane");

/** The slice of the terminal service the notice reads, with real listener semantics. */
function makeService() {
  const { surface, plane } = makeSurface("alt-screen-notice");
  const created = new Set<string>();
  const screen = new Map<string, boolean>();
  const listeners = new Map<string, Set<(isAltBuffer: boolean) => void>>();
  plane.addAltBufferListener.mockImplementation((id, callback) => {
    // Like the real service: no instance, nothing to attach to.
    if (!created.has(id)) return () => {};
    const set = listeners.get(id) ?? new Set<(isAltBuffer: boolean) => void>();
    listeners.set(id, set);
    set.add(callback);
    callback(screen.get(id) ?? false);
    return () => {
      set.delete(callback);
    };
  });
  plane.getAltBufferState.mockImplementation((id) => screen.get(id) ?? false);
  const destroyedCallbacks = new Set<(id: string) => void>();
  plane.addInstanceDestroyedListener.mockImplementation((callback) => {
    destroyedCallbacks.add(callback);
    return () => {
      destroyedCallbacks.delete(callback);
    };
  });
  return {
    paintPlane: surface.plane,
    addAltBufferListener: plane.addAltBufferListener,
    create(id: string) {
      created.add(id);
    },
    setScreen(id: string, isAltBuffer: boolean) {
      screen.set(id, isAltBuffer);
      for (const callback of [...(listeners.get(id) ?? [])]) callback(isAltBuffer);
    },
    /** Teardown as the service does it: listeners dropped without a last report. */
    destroy(id: string) {
      created.delete(id);
      screen.delete(id);
      listeners.delete(id);
      for (const callback of [...destroyedCallbacks]) callback(id);
    },
    listenerCount(id: string) {
      return listeners.get(id)?.size ?? 0;
    },
    destroyListenerCount() {
      return destroyedCallbacks.size;
    },
  };
}

function panel(id: string, overrides: Partial<PtyPanelData> = {}): PanelInstance {
  return {
    id,
    kind: "terminal",
    title: id,
    cwd: "/repo",
    cols: 80,
    rows: 24,
    location: "grid",
    ...overrides,
  } as PanelInstance;
}

function seed(...panels: PanelInstance[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
  });
}

let service: ReturnType<typeof makeService>;

function installService(...ids: string[]) {
  service = makeService();
  for (const id of ids) service.create(id);
  act(() => {
    accessor.register(service.paintPlane);
  });
}

beforeEach(() => {
  accessor.__testing.reset();
  saveNormalized.mockClear();
  seed(panel("t-1"), panel("t-2"));
});

afterEach(() => {
  accessor.__testing.reset();
});

describe("useAgentAltScreenBanner", () => {
  it("shows on entry to the alternate screen and hides on return to the main screen", () => {
    installService("t-1");
    const { result } = renderHook(() => useAgentAltScreenBanner("t-1", "claude", 0));
    expect(result.current.visible).toBe(false);

    act(() => service.setScreen("t-1", true));
    expect(result.current.visible).toBe(true);

    act(() => service.setScreen("t-1", false));
    expect(result.current.visible).toBe(false);
  });

  it("shows straight away for a pane that mounts while already full-screen", () => {
    installService("t-1");
    service.setScreen("t-1", true);

    const { result } = renderHook(() => useAgentAltScreenBanner("t-1", "crush", 0));

    expect(result.current.visible).toBe(true);
  });

  it("never watches a pane with no agent, however full-screen it gets", () => {
    installService("t-1");
    const { result } = renderHook(() => useAgentAltScreenBanner("t-1", undefined, 0));

    act(() => service.setScreen("t-1", true));

    expect(result.current.visible).toBe(false);
    expect(service.addAltBufferListener).not.toHaveBeenCalled();
  });

  it("follows the pane's agent identity appearing and going", () => {
    installService("t-1");
    service.setScreen("t-1", true);
    const { result, rerender } = renderHook(
      ({ agentId }: { agentId: string | undefined }) => useAgentAltScreenBanner("t-1", agentId, 0),
      { initialProps: { agentId: undefined as string | undefined } }
    );
    expect(result.current.visible).toBe(false);

    rerender({ agentId: "claude" });
    expect(result.current.visible).toBe(true);

    rerender({ agentId: undefined });
    expect(result.current.visible).toBe(false);
    expect(service.listenerCount("t-1")).toBe(0);
  });

  it("stays hidden once dismissed, even when the agent goes full-screen again", () => {
    installService("t-1");
    const { result } = renderHook(() => useAgentAltScreenBanner("t-1", "claude", 0));
    act(() => service.setScreen("t-1", true));
    expect(result.current.visible).toBe(true);

    act(() => result.current.dismiss());
    expect(result.current.visible).toBe(false);

    act(() => service.setScreen("t-1", false));
    act(() => service.setScreen("t-1", true));
    expect(result.current.visible).toBe(false);
  });

  it("keeps the dismissal across an unmount and remount", () => {
    installService("t-1");
    service.setScreen("t-1", true);
    const first = renderHook(() => useAgentAltScreenBanner("t-1", "claude", 0));
    act(() => first.result.current.dismiss());
    first.unmount();

    const second = renderHook(() => useAgentAltScreenBanner("t-1", "claude", 0));

    expect(second.result.current.visible).toBe(false);
  });

  it("dismisses only its own pane", () => {
    installService("t-1", "t-2");
    service.setScreen("t-1", true);
    service.setScreen("t-2", true);
    const one = renderHook(() => useAgentAltScreenBanner("t-1", "claude", 0));
    const two = renderHook(() => useAgentAltScreenBanner("t-2", "claude", 0));

    act(() => one.result.current.dismiss());

    expect(one.result.current.visible).toBe(false);
    expect(two.result.current.visible).toBe(true);
  });

  it("subscribes once the terminal service has loaded", () => {
    const { result } = renderHook(() => useAgentAltScreenBanner("t-1", "claude", 0));
    expect(result.current.visible).toBe(false);

    installService("t-1");
    act(() => service.setScreen("t-1", true));

    expect(result.current.visible).toBe(true);
  });

  it("subscribes again after the terminal attaches", () => {
    installService();
    const { result, rerender } = renderHook(
      ({ epoch }: { epoch: number }) => useAgentAltScreenBanner("t-1", "claude", epoch),
      { initialProps: { epoch: 0 } }
    );

    // The first attempt found no terminal: nothing was attached.
    service.create("t-1");
    service.setScreen("t-1", true);
    expect(result.current.visible).toBe(false);

    rerender({ epoch: 1 });
    expect(result.current.visible).toBe(true);
    expect(service.listenerCount("t-1")).toBe(1);
  });

  it("stops listening when the pane unmounts", () => {
    installService("t-1");
    const { unmount } = renderHook(() => useAgentAltScreenBanner("t-1", "claude", 0));
    expect(service.listenerCount("t-1")).toBe(1);
    expect(service.destroyListenerCount()).toBe(1);

    unmount();

    expect(service.listenerCount("t-1")).toBe(0);
    expect(service.destroyListenerCount()).toBe(0);
  });

  it("stops claiming full-screen when its terminal is torn down, until a new one attaches", () => {
    installService("t-1");
    const { result, rerender } = renderHook(
      ({ epoch }: { epoch: number }) => useAgentAltScreenBanner("t-1", "claude", epoch),
      { initialProps: { epoch: 0 } }
    );
    act(() => service.setScreen("t-1", true));
    expect(result.current.visible).toBe(true);

    // A restart destroys the old terminal before the new one exists.
    act(() => service.destroy("t-1"));
    expect(result.current.visible).toBe(false);

    service.create("t-1");
    service.setScreen("t-1", true);
    rerender({ epoch: 1 });
    expect(result.current.visible).toBe(true);
  });

  it("ignores the teardown of another pane's terminal", () => {
    installService("t-1", "t-2");
    service.setScreen("t-1", true);
    const { result } = renderHook(() => useAgentAltScreenBanner("t-1", "claude", 0));

    act(() => service.destroy("t-2"));

    expect(result.current.visible).toBe(true);
  });
});

describe("dismissAltScreenNotice", () => {
  const flagOf = (id: string) => {
    const found = usePanelStore.getState().panelsById[id];
    return found && "altScreenNoticeDismissed" in found
      ? found.altScreenNoticeDismissed
      : undefined;
  };

  it("marks only the named panel and leaves the others untouched", () => {
    const before = usePanelStore.getState().panelsById["t-2"];

    usePanelStore.getState().dismissAltScreenNotice("t-1");

    expect(flagOf("t-1")).toBe(true);
    expect(usePanelStore.getState().panelsById["t-2"]).toBe(before);
  });

  it("keeps the same state on a repeat dismissal", () => {
    usePanelStore.getState().dismissAltScreenNotice("t-1");
    const afterFirst = usePanelStore.getState().panelsById;

    usePanelStore.getState().dismissAltScreenNotice("t-1");

    expect(usePanelStore.getState().panelsById).toBe(afterFirst);
  });

  it("ignores a panel that is gone or has no terminal", () => {
    const browser: PanelInstance = { id: "b-1", kind: "browser", title: "b", location: "grid" };
    seed(panel("t-1"), browser);
    const before = usePanelStore.getState().panelsById;

    usePanelStore.getState().dismissAltScreenNotice("missing");
    usePanelStore.getState().dismissAltScreenNotice("b-1");

    expect(usePanelStore.getState().panelsById).toBe(before);
  });

  it("is not saved with the project", () => {
    usePanelStore.getState().dismissAltScreenNotice("t-1");

    expect(saveNormalized).not.toHaveBeenCalled();
  });
});

describe("altScreenNoticeAgentId", () => {
  it("names the agent of a pane running one", () => {
    expect(altScreenNoticeAgentId(deriveTerminalChrome({ launchAgentId: "claude" }))).toBe(
      "claude"
    );
  });

  it("names an agent detected in a shell the user started it from", () => {
    expect(altScreenNoticeAgentId(deriveTerminalChrome({ detectedAgentId: "codex" }))).toBe(
      "codex"
    );
  });

  it("names nothing for a plain shell", () => {
    expect(altScreenNoticeAgentId(deriveTerminalChrome({ kind: "terminal" }))).toBeUndefined();
  });

  it("names nothing for a shell running a full-screen program", () => {
    expect(
      altScreenNoticeAgentId(deriveTerminalChrome({ detectedProcessId: "vim" }))
    ).toBeUndefined();
  });

  it("names nothing once the agent has exited, whether launched or detected", () => {
    expect(
      altScreenNoticeAgentId(
        deriveTerminalChrome({ launchAgentId: "claude", runtimeStatus: "exited" })
      )
    ).toBeUndefined();
    expect(
      altScreenNoticeAgentId(deriveTerminalChrome({ detectedAgentId: "claude", exitCode: 0 }))
    ).toBeUndefined();
  });
});
