// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";
import type { CanopyFrame } from "@/components/Canopy/canopyFrame";
import { useCanopyStore } from "@/store/canopyStore";

const stops = vi.hoisted(() => ({
  terminalConfig: vi.fn(),
  keybindings: vi.fn(),
  fleet: vi.fn(),
  hostProjects: vi.fn(),
}));
const shownFrames = vi.hoisted(() => [] as CanopyFrame[]);
const notifyMock = vi.hoisted(() => vi.fn());
const loadProjects = vi.hoisted(() => vi.fn(async () => {}));
const loadScratches = vi.hoisted(() => vi.fn(async () => {}));
const loadOverrides = vi.hoisted(() => vi.fn(async () => {}));
const projectShell = vi.hoisted(() => vi.fn());

vi.mock("@/components/Canopy/CanopyView", () => ({
  CanopyView: ({ frame }: { frame: CanopyFrame }) => {
    shownFrames.push(frame);
    return <div data-testid="inbox" />;
  },
}));
vi.mock("@/components/ui/toaster", () => ({ Toaster: () => null }));
vi.mock("@/hooks/useAppThemeConfig", () => ({ useAppThemeConfig: vi.fn() }));
vi.mock("@/hooks/useTerminalConfig", () => ({ useTerminalConfig: vi.fn() }));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
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

import { CanopyWindowRoot } from "../CanopyWindowRoot";
import { CANOPY_WINDOW_FRAME } from "../canopyWindowFrame";

let pushSnapshot: (snapshot: CanopySnapshot) => void = () => {};
const offSnapshot = vi.fn();
const closeWindow = vi.fn(async () => {});

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
    },
    configurable: true,
    writable: true,
  });
});

afterEach(cleanup);

describe("CanopyWindowRoot", () => {
  it("shows the inbox in the window's own frame, with no project shell", async () => {
    const view = render(<CanopyWindowRoot />);
    await act(async () => {});

    expect(view.getByTestId("inbox")).toBeTruthy();
    expect(shownFrames[0]).toBe(CANOPY_WINDOW_FRAME);
    expect(CANOPY_WINDOW_FRAME.host).toBe("standalone");
    expect(CANOPY_WINDOW_FRAME.workspaceId()).toBeNull();
    expect(projectShell).not.toHaveBeenCalled();
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

  it("stops everything it started when it goes", async () => {
    const view = render(<CanopyWindowRoot />);
    await act(async () => {});

    view.unmount();

    expect(offSnapshot).toHaveBeenCalledTimes(1);
    for (const stop of Object.values(stops)) expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("the Canopy window's frame", () => {
  it("closes the window when the inbox is put away", () => {
    CANOPY_WINDOW_FRAME.close();
    expect(closeWindow).toHaveBeenCalledTimes(1);
  });

  it("offers no way to a pane until Go to pane lands", () => {
    expect(CANOPY_WINDOW_FRAME.goToRun).toBeNull();
  });

  it("says what a restore needs rather than moving anything", () => {
    const panel = { stillShows: vi.fn(() => true), closeForTerminal: vi.fn() };

    CANOPY_WINDOW_FRAME.restoreElsewhere({} as never, {} as never, panel);

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Project isn't open" })
    );
    expect(panel.closeForTerminal).not.toHaveBeenCalled();
  });

  it("refuses to open an assistant in words, for its pane to show", async () => {
    await expect(CANOPY_WINDOW_FRAME.openAssistant({} as never, () => true)).resolves.toMatch(
      /Assistant panel/
    );
  });
});
