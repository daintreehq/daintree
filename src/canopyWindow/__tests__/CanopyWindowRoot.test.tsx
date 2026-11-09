// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";
import type { CanopyFrame } from "@/components/Canopy/canopyFrame";
import { useCanopyStore } from "@/store/canopyStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

const stops = vi.hoisted(() => ({
  terminalConfig: vi.fn(),
  keybindings: vi.fn(),
  fleet: vi.fn(),
  hostProjects: vi.fn(),
  keys: vi.fn(),
}));
const shownFrames = vi.hoisted(() => [] as CanopyFrame[]);
const notifyMock = vi.hoisted(() => vi.fn());
const loadProjects = vi.hoisted(() => vi.fn(async () => {}));
const loadScratches = vi.hoisted(() => vi.fn(async () => {}));
const loadOverrides = vi.hoisted(() => vi.fn(async () => {}));
const projectShell = vi.hoisted(() => vi.fn());
const hydrateNotifications = vi.hoisted(() => vi.fn(async () => {}));
const toasterProps = vi.hoisted(() => [] as Array<{ standalone: boolean | undefined }>);
const switchToHost = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/components/Canopy/CanopyView", () => ({
  CanopyView: ({ frame }: { frame: CanopyFrame }) => {
    shownFrames.push(frame);
    return <div data-testid="inbox" />;
  },
}));
vi.mock("@/components/ui/toaster", () => ({
  Toaster: ({ standalone }: { standalone?: boolean }) => {
    toasterProps.push({ standalone });
    return null;
  },
}));
vi.mock("../CanopyPluginSupport", () => ({
  CanopyPluginSupport: () => <div data-testid="plugin-support" />,
}));
vi.mock("@/hooks/useAppThemeConfig", () => ({ useAppThemeConfig: vi.fn() }));
vi.mock("@/hooks/useTerminalConfig", () => ({ useTerminalConfig: vi.fn() }));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/components/Hosts/hostSwitching", () => ({ switchToHost }));
vi.mock("@/services/terminalConfigSync", () => ({
  initTerminalConfigSync: () => stops.terminalConfig,
}));
vi.mock("@/services/keybindingOverridesSync", () => ({
  initKeybindingOverridesSync: () => stops.keybindings,
}));
vi.mock("@/services/KeybindingService", () => ({ keybindingService: { loadOverrides } }));
vi.mock("@/components/Hosts/installHostProjectsLoader", () => ({
  installHostProjectsLoader: () => stops.hostProjects,
}));
const returnToLastProjectWindow = vi.hoisted(() => vi.fn());
vi.mock("../canopyWindowKeys", () => ({
  startCanopyWindowKeys: () => stops.keys,
  returnToLastProjectWindow,
}));
const useCanopyDoubleShift = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/app/useCanopyDoubleShift", () => ({ useCanopyDoubleShift }));
vi.mock("@/store/fleetSnapshotStore", () => ({
  setupFleetSnapshotListeners: () => stops.fleet,
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => ({ loadProjects }) },
}));
vi.mock("@/store/scratchStore", () => ({
  useScratchStore: { getState: () => ({ loadScratches }) },
}));
vi.mock("@/store/rendererStoreOrchestrator", () => ({ initStoreOrchestrator: projectShell }));
vi.mock("@/store/notificationSettingsStore", () => ({
  useNotificationSettingsStore: { getState: () => ({ hydrate: hydrateNotifications }) },
}));

import {
  _resetPluginHostedViewsStoreForTest,
  usePluginHostedViewsStore,
} from "@/store/pluginHostedViewsStore";
import { CanopyWindowRoot } from "../CanopyWindowRoot";
import { CANOPY_WINDOW_FRAME } from "../canopyWindowFrame";

let pushSnapshot: (snapshot: CanopySnapshot) => void = () => {};
const offSnapshot = vi.fn();
const closeWindow = vi.fn(async () => {});
const goToRun = vi.fn(async (_target: { workspaceId: string; runId: string }) => {});

function snapshot(mode: CanopySnapshot["mode"]): CanopySnapshot {
  return {
    mode,
    activated: mode === "on",
    dispositions: [],
    seen: [],
    reads: [],
    scope: null,
    active: false,
    busy: false,
    refreshedAt: null,
    cards: [],
    lastError: null,
    failedRuns: [],
    glances: [],
  };
}

beforeEach(() => {
  shownFrames.length = 0;
  toasterProps.length = 0;
  vi.clearAllMocks();
  useCanopyStore.setState({ snapshot: null, mode: "unset" });
  Object.defineProperty(window, "electron", {
    value: {
      canopy: {
        onSnapshotUpdated: (listener: (next: CanopySnapshot) => void) => {
          pushSnapshot = listener;
          return offSnapshot;
        },
        getSnapshot: vi.fn(async () => snapshot("on")),
      },
      window: { close: closeWindow },
      canopyWindow: { goToRun },
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  _resetPluginHostedViewsStoreForTest();
});

describe("CanopyWindowRoot", () => {
  it("shows the inbox in the window's own frame, with no project shell", async () => {
    const view = render(<CanopyWindowRoot />);
    await act(async () => {});

    expect(view.getByTestId("inbox")).toBeTruthy();
    expect(shownFrames[0]).toBe(CANOPY_WINDOW_FRAME);
    expect(projectShell).not.toHaveBeenCalled();
  });

  it("sends double-Shift back to the last project window, as Canopy's key goes (#16578)", async () => {
    render(<CanopyWindowRoot />);
    await act(async () => {});

    expect(useCanopyDoubleShift).toHaveBeenCalled();
    for (const [onDoubleShift] of useCanopyDoubleShift.mock.calls) {
      expect(onDoubleShift).toBe(returnToLastProjectWindow);
    }
  });

  it("takes Canopy's snapshots like any other view: the first read, then each push", async () => {
    render(<CanopyWindowRoot />);
    await act(async () => {});
    expect(useCanopyStore.getState().snapshot?.mode).toBe("on");

    const next = { ...snapshot("on"), busy: true };
    act(() => pushSnapshot(next));
    expect(useCanopyStore.getState().snapshot?.busy).toBe(true);
  });

  it("reads what labels the rows and the shortcuts it shows", async () => {
    render(<CanopyWindowRoot />);
    await act(async () => {});

    expect(loadProjects).toHaveBeenCalled();
    expect(loadScratches).toHaveBeenCalled();
    expect(loadOverrides).toHaveBeenCalled();
  });

  it("keeps the user's notification settings, and offers no toast control it can't run", async () => {
    render(<CanopyWindowRoot />);
    await act(async () => {});

    expect(hydrateNotifications).toHaveBeenCalled();
    expect(toasterProps.every((props) => props.standalone === true)).toBe(true);
    expect(toasterProps.length).toBeGreaterThan(0);
  });

  it("leans on plugin support only while some plugin offers Canopy a view (#16344)", async () => {
    const view = render(<CanopyWindowRoot />);
    await act(async () => {});
    expect(view.queryByTestId("plugin-support")).toBeNull();

    const base = {
      pluginId: "acme.beads",
      viewId: "triage",
      componentPath: "plugin://acme.beads/__dtv-1/triage.js",
    };
    act(() =>
      usePluginHostedViewsStore.setState({
        views: [
          { ...base, id: "plugin-view:acme.beads/prefs", location: "settings", name: "Beads" },
        ],
      })
    );
    expect(view.queryByTestId("plugin-support")).toBeNull();

    act(() =>
      usePluginHostedViewsStore.setState({
        views: [
          {
            ...base,
            id: "plugin-view:acme.beads/triage",
            location: "canopy",
            name: "Beads Triage",
            title: "Triage",
            pluginName: "Beads",
          },
        ],
      })
    );
    expect(view.queryByTestId("plugin-support")).not.toBeNull();

    act(() => usePluginHostedViewsStore.setState({ views: [] }));
    expect(view.queryByTestId("plugin-support")).toBeNull();
  });

  it("says what the voice service announces, such as why the dictation key started nothing", async () => {
    const said = "Select an agent in Canopy to dictate a reply to it.";
    const frames: FrameRequestCallback[] = [];
    const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const view = render(<CanopyWindowRoot />);
    try {
      await act(async () => {});

      act(() => useVoiceRecordingStore.getState().announce(said));
      act(() => {
        for (const frame of frames.splice(0)) frame(performance.now());
      });

      const regions = Array.from(view.baseElement.querySelectorAll('[role="status"]'));
      expect(regions.map((region) => region.textContent)).toContain(said);
    } finally {
      view.unmount();
      request.mockRestore();
      cancel.mockRestore();
      useVoiceRecordingStore.setState({ announcement: null });
    }
  });

  it("stops everything it started when it goes", async () => {
    const view = render(<CanopyWindowRoot />);
    await act(async () => {});

    view.unmount();

    expect(offSnapshot).toHaveBeenCalledTimes(1);
    for (const stop of Object.values(stops)) expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("the Canopy window's frame", () => {
  describe("Go to pane (#16337)", () => {
    const go = (
      place: { hostId: string | null; runId: string; workspaceId: string },
      newWindow = false
    ) => CANOPY_WINDOW_FRAME.goToRun!({ place, newWindow });

    it.each([false, true])(
      "asks main for a run on this machine, and stays open on it (new window: %s)",
      async (newWindow) => {
        go({ hostId: null, runId: "agent-1", workspaceId: "project-a" }, newWindow);
        await act(async () => {});

        expect(goToRun).toHaveBeenCalledWith({ workspaceId: "project-a", runId: "agent-1" });
        expect(switchToHost).not.toHaveBeenCalled();
        expect(closeWindow).not.toHaveBeenCalled();
      }
    );

    it("sends another host's run to a window on that host, never this one", async () => {
      go({ hostId: "host-1", runId: "agent-2", workspaceId: "project-b" });
      await act(async () => {});

      expect(switchToHost).toHaveBeenCalledWith("host-1", true, "project-b", {
        focusIntent: { intent: "focus-panel", panelId: "agent-2" },
        standalone: true,
      });
      expect(goToRun).not.toHaveBeenCalled();
      expect(closeWindow).not.toHaveBeenCalled();
    });

    it("says why a run on this machine wasn't reached, and tries again from there", async () => {
      goToRun.mockRejectedValueOnce(new Error("The window for Alpha didn't come up in time."));

      go({ hostId: null, runId: "agent-1", workspaceId: "project-a" });
      await act(async () => {});

      expect(notifyMock).toHaveBeenCalledTimes(1);
      const toast = notifyMock.mock.calls[0]![0] as {
        type: string;
        title: string;
        message: string;
        actions: Array<{ label: string; onClick: () => void }>;
      };
      expect(toast).toMatchObject({
        type: "error",
        title: "Couldn't open agent",
        message: "The window for Alpha didn't come up in time.",
      });
      expect(toast.actions.map((action) => action.label)).toEqual(["Try again"]);

      toast.actions[0]!.onClick();
      await act(async () => {});
      expect(goToRun).toHaveBeenCalledTimes(2);
      expect(goToRun.mock.calls[1]![0]).toEqual({ workspaceId: "project-a", runId: "agent-1" });
    });

    it("offers no retry for a run whose workspace is gone, as main says it over IPC", async () => {
      // What reaches a renderer: the code and words survive only in the message prefix.
      goToRun.mockRejectedValueOnce(
        new Error(
          `[AppError|NOT_FOUND|${encodeURIComponent("Its project or scratch has been removed.")}] gone`
        )
      );

      go({ hostId: null, runId: "agent-1", workspaceId: "project-a" });
      await act(async () => {});

      const toast = notifyMock.mock.calls[0]![0] as { message: string; actions?: unknown };
      expect(toast.message).toBe("Its project or scratch has been removed.");
      expect(toast.actions).toBeUndefined();
    });
  });
});
