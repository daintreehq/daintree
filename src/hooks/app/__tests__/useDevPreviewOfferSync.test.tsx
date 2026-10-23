// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@shared/types/project";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import type { StoreApi, UseBoundStore } from "zustand";

interface PanelMockState {
  panelIds: string[];
  panelsById: Record<string, { kind: string; location: string }>;
}

const observability = vi.hoisted(() => {
  const state: { listener: ((observable: boolean) => void) | null } = { listener: null };
  return state;
});

const panelMock = vi.hoisted(() => {
  const holder: { store: UseBoundStore<StoreApi<PanelMockState>> | null } = { store: null };
  return holder;
});

vi.mock("@/store/panelStore", async () => {
  const { create } = await import("zustand");
  panelMock.store = create<PanelMockState>(() => ({ panelIds: [], panelsById: {} }));
  return { usePanelStore: panelMock.store };
});

function panels(): UseBoundStore<StoreApi<PanelMockState>> {
  if (panelMock.store === null) throw new Error("the panel store mock was never created");
  return panelMock.store;
}

vi.mock("@/lib/viewCacheState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/viewCacheState")>();
  return {
    ...actual,
    subscribeProjectViewObservability: (listener: (observable: boolean) => void) => {
      observability.listener = listener;
      return () => {
        observability.listener = null;
      };
    },
  };
});

import { useDevPreviewOfferSync } from "../useDevPreviewOfferSync";
import {
  devPreviewOfferReason,
  useDevPreviewOfferStore,
  type DevPreviewOfferFacts,
} from "@/store/devPreviewOfferStore";
import { useProjectStore } from "@/store/projectStore";
import {
  _resetProjectPresentationStoreForTest,
  useProjectPresentationStore,
} from "@/store/projectPresentationStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { useWorktreeDevServerStore } from "@/store/worktreeDevServerStore";

const PROJECT = "a".repeat(64);
const OTHER = "b".repeat(64);

const NOTHING: DevPreviewOfferFacts = {
  alwaysShow: false,
  pinned: false,
  inUse: false,
  commandConfigured: false,
  webProject: false,
};

describe("devPreviewOfferReason", () => {
  it("offers it when anything says the project wants it, the strongest reason first", () => {
    expect(devPreviewOfferReason(NOTHING)).toBeNull();
    expect(devPreviewOfferReason({ ...NOTHING, webProject: null })).toBe("unknown");
    expect(devPreviewOfferReason({ ...NOTHING, webProject: true })).toBe("web-project");
    expect(devPreviewOfferReason({ ...NOTHING, commandConfigured: true, webProject: true })).toBe(
      "command"
    );
    expect(devPreviewOfferReason({ ...NOTHING, inUse: true, commandConfigured: true })).toBe(
      "in-use"
    );
    expect(devPreviewOfferReason({ ...NOTHING, pinned: true, inUse: true })).toBe("pinned");
    expect(devPreviewOfferReason({ ...NOTHING, alwaysShow: true, pinned: true })).toBe("always");
  });
});

const initialToolbar = useToolbarPreferencesStore.getState();
const initialSettings = useProjectSettingsStore.getState();
const initialRefresh = useProjectPresentationStore.getState().refresh;
const loadSettings = vi.fn<(projectId: string) => Promise<void>>(() => Promise.resolve());

function project(id: string): Project {
  return { id, name: "Repo", path: "/repo", emoji: "", lastOpened: 0, gitBacked: true };
}

function session(over: Partial<DevPreviewSessionState>): DevPreviewSessionState {
  return {
    panelId: "panel-1",
    projectId: PROJECT,
    worktreeId: "wt-1",
    status: "running",
    url: null,
    predictedUrl: null,
    error: null,
    terminalId: null,
    isRestarting: false,
    generation: 1,
    updatedAt: 1,
    ...over,
  };
}

function presentationSays(webProject: boolean | null, projectId = PROJECT) {
  useProjectPresentationStore.setState({ loaded: true, projectId, webProject });
}

const reason = () => useDevPreviewOfferStore.getState().reason;

beforeEach(() => {
  _resetProjectPresentationStoreForTest();
  useDevPreviewOfferStore.setState({ reason: "unknown" });
  useProjectStore.setState({ currentProject: project(PROJECT), projects: [project(PROJECT)] });
  useProjectSettingsStore.setState({
    projectId: PROJECT,
    settings: { runCommands: [] },
    isLoading: false,
    loadSettings,
  });
  loadSettings.mockClear();
});

afterEach(() => {
  cleanup();
  panels().setState({ panelIds: [], panelsById: {} });
  useToolbarPreferencesStore.setState(initialToolbar, true);
  useProjectSettingsStore.setState(initialSettings, true);
  useWorktreeDevServerStore.getState().reset();
  useProjectPresentationStore.setState({ refresh: initialRefresh });
  _resetProjectPresentationStoreForTest();
});

describe("useDevPreviewOfferSync", () => {
  it("withdraws the offer only once main says the files aren't a web project", () => {
    renderHook(() => useDevPreviewOfferSync());
    expect(reason()).toBe("unknown");

    act(() => presentationSays(false));
    expect(reason()).toBeNull();

    act(() => presentationSays(true));
    expect(reason()).toBe("web-project");
  });

  it("ignores an answer about another project", () => {
    renderHook(() => useDevPreviewOfferSync());
    act(() => presentationSays(false, OTHER));
    expect(reason()).toBe("unknown");
  });

  it("keeps it offered while a preview is open, but not once it is in the trash", () => {
    renderHook(() => useDevPreviewOfferSync());
    act(() => presentationSays(false));

    act(() =>
      panels().setState({
        panelIds: ["p1", "p2"],
        panelsById: {
          p1: { kind: "browser", location: "grid" },
          p2: { kind: "dev-preview", location: "dock" },
        },
      })
    );
    expect(reason()).toBe("in-use");

    act(() =>
      panels().setState({
        panelsById: {
          p1: { kind: "browser", location: "grid" },
          p2: { kind: "dev-preview", location: "trash" },
        },
      })
    );
    expect(reason()).toBeNull();
  });

  it("keeps it offered while this project's dev server runs", () => {
    renderHook(() => useDevPreviewOfferSync());
    act(() => presentationSays(false));

    act(() =>
      useWorktreeDevServerStore.getState().setSession("wt-other", session({ projectId: OTHER }))
    );
    expect(reason()).toBeNull();

    act(() => useWorktreeDevServerStore.getState().setSession("wt-1", session({})));
    expect(reason()).toBe("in-use");

    act(() =>
      useWorktreeDevServerStore
        .getState()
        .setSession("wt-1", session({ status: "stopped", updatedAt: 2 }))
    );
    expect(reason()).toBeNull();
  });

  it("keeps it offered where a dev server command is set", () => {
    renderHook(() => useDevPreviewOfferSync());
    act(() => presentationSays(false));
    act(() =>
      useProjectSettingsStore.setState({ settings: { runCommands: [], devServerCommand: " " } })
    );
    expect(reason()).toBeNull();
    act(() =>
      useProjectSettingsStore.setState({
        settings: { runCommands: [], devServerCommand: "npm run dev" },
      })
    );
    expect(reason()).toBe("command");
  });

  it("follows the app-wide switch and an explicit toolbar pin", () => {
    renderHook(() => useDevPreviewOfferSync());
    act(() => presentationSays(false));

    act(() => {
      useToolbarPreferencesStore.setState({
        layout: { ...initialToolbar.layout, pinnedButtons: { "dev-server": true } },
      });
    });
    expect(reason()).toBe("pinned");

    act(() => {
      useToolbarPreferencesStore.setState({
        layout: { ...initialToolbar.layout, pinnedButtons: { "dev-server": false } },
        launcher: { ...initialToolbar.launcher, alwaysShowDevServer: true },
      });
    });
    expect(reason()).toBe("always");
  });

  it("loads this project's settings when nothing else has", () => {
    useProjectSettingsStore.setState({ projectId: null, settings: null });
    renderHook(() => useDevPreviewOfferSync());
    expect(loadSettings).toHaveBeenCalledWith(PROJECT);
  });

  it("reads the project's files again when the view comes back into sight", () => {
    const refresh = vi.fn();
    useProjectPresentationStore.setState({ loaded: true, projectId: PROJECT, refresh });
    renderHook(() => useDevPreviewOfferSync());

    act(() => observability.listener?.(false));
    expect(refresh).not.toHaveBeenCalled();
    act(() => observability.listener?.(true));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
