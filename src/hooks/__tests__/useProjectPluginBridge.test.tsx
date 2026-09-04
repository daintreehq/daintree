/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useProjectPluginBridge } from "../useProjectPluginBridge";
import {
  __resetProjectPluginStoreForTesting,
  useProjectPluginStore,
} from "@/store/projectPluginStore";
import type { NotifyPayload } from "@/lib/notify";
import type { ProjectPluginInfo } from "@shared/types/plugin";

const notify = vi.fn<(payload: NotifyPayload) => void>();
vi.mock("@/lib/notify", () => ({ notify: (payload: NotifyPayload) => notify(payload) }));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) =>
    selector({ currentProject: { id: "proj-a" } }),
}));

function Harness() {
  useProjectPluginBridge();
  return null;
}

const listeners = new Map<string, (payload: unknown) => void>();
let getProjectPlugins: ReturnType<typeof vi.fn>;
let getProjectPluginVisibility: ReturnType<typeof vi.fn>;

function row(state: ProjectPluginInfo["state"]): ProjectPluginInfo {
  return {
    projectId: "proj-a",
    id: "acme.dashboard",
    displayName: "Acme Dashboard",
    version: "1.0.0",
    capabilities: [],
    dirName: "dashboard",
    state,
    muted: false,
    collidesWithGlobal: false,
  };
}

function emit(name: string, payload: unknown) {
  act(() => {
    listeners.get(name)?.(payload);
  });
}

beforeEach(() => {
  notify.mockReset();
  listeners.clear();
  getProjectPlugins = vi.fn(() => Promise.resolve([]));
  getProjectPluginVisibility = vi.fn(() => Promise.resolve({}));
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      events: {
        on: vi.fn((name: string, cb: (payload: unknown) => void) => {
          listeners.set(name, cb);
          return vi.fn();
        }),
      },
      plugin: { getProjectPlugins, getProjectPluginVisibility },
    },
  });
});

afterEach(() => {
  cleanup();
  __resetProjectPluginStoreForTesting();
});

describe("useProjectPluginBridge", () => {
  it("subscribes to exactly the four project-scoped pushes", () => {
    render(<Harness />);
    expect([...listeners.keys()].sort()).toEqual([
      "plugin:project-plugin-staged",
      "plugin:project-plugin-visibility-changed",
      "plugin:project-plugins-changed",
      "plugin:project-trust-prompt",
    ]);
  });

  it("pulls the visibility overlay on mount and applies later pushes", async () => {
    getProjectPluginVisibility.mockReturnValue(Promise.resolve({ "acme.tools": false }));
    render(<Harness />);

    await waitFor(() => {
      expect(useProjectPluginStore.getState().visibility).toEqual({ "acme.tools": false });
    });

    emit("plugin:project-plugin-visibility-changed", {
      projectId: "proj-a",
      visibility: { "acme.tools": true },
    });
    expect(useProjectPluginStore.getState().visibility).toEqual({ "acme.tools": true });
  });

  it("ignores a visibility push for a project this view is not showing", async () => {
    render(<Harness />);
    await waitFor(() => expect(getProjectPluginVisibility).toHaveBeenCalled());

    emit("plugin:project-plugin-visibility-changed", {
      projectId: "proj-b",
      visibility: { "acme.tools": false },
    });
    expect(useProjectPluginStore.getState().visibility).toEqual({});
  });

  it("raises the gate from the trust prompt and from nothing else", () => {
    render(<Harness />);

    emit("plugin:project-plugins-changed", {
      projectId: "proj-a",
      plugins: [row("blocked")],
      trust: { projectId: "proj-a", decision: null, enabled: false, persisted: false },
    });
    expect(useProjectPluginStore.getState().prompt).toBeNull();

    emit("plugin:project-plugin-staged", {
      projectId: "proj-a",
      pluginId: "acme.dashboard",
      displayName: "Acme Dashboard",
    });
    expect(useProjectPluginStore.getState().prompt).toBeNull();

    emit("plugin:project-trust-prompt", {
      projectId: "proj-a",
      plugins: [{ id: "acme.dashboard", displayName: "Acme Dashboard" }],
    });
    expect(useProjectPluginStore.getState().prompt?.projectId).toBe("proj-a");
  });

  it("renders the snapshot push without refetching", () => {
    render(<Harness />);
    emit("plugin:project-plugins-changed", {
      projectId: "proj-a",
      plugins: [row("staged")],
      trust: { projectId: "proj-a", decision: "enabled", enabled: true, persisted: true },
    });

    const state = useProjectPluginStore.getState();
    expect(state.plugins.map((p) => p.state)).toEqual(["staged"]);
    expect(state.trust?.enabled).toBe(true);
    // One cold-start backstop call on mount, and nothing after.
    expect(getProjectPlugins).toHaveBeenCalledTimes(1);
  });

  it("announces a staged plugin passively, with a way into the manager", () => {
    render(<Harness />);
    emit("plugin:project-plugin-staged", {
      projectId: "proj-a",
      pluginId: "acme.dashboard",
      displayName: "Acme Dashboard",
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]?.[0];
    expect(payload?.message).toContain("Acme Dashboard");
    expect(payload?.action?.label).toBe("Review");
    expect(payload?.context?.eventKind).toBe("settings");
  });

  it("keeps an unanswered prompt across a remount, because nothing will re-emit it", () => {
    // The preload replays a buffered prompt to its FIRST subscriber and drops
    // it, and main never re-emits once a decision is stored — so a remount that
    // cleared the store (a StrictMode double-mount is one) would destroy the
    // only prompt this project ever gets.
    const view = render(<Harness />);
    emit("plugin:project-trust-prompt", {
      projectId: "proj-a",
      plugins: [{ id: "acme.dashboard", displayName: "Acme Dashboard" }],
    });

    view.unmount();

    expect(useProjectPluginStore.getState().prompt?.projectId).toBe("proj-a");
  });

  it("does not let the cold-start fetch overwrite a snapshot that already landed", async () => {
    let resolveList: ((rows: ProjectPluginInfo[]) => void) | undefined;
    getProjectPlugins.mockImplementationOnce(
      () =>
        new Promise<ProjectPluginInfo[]>((resolve) => {
          resolveList = resolve;
        })
    );
    render(<Harness />);

    emit("plugin:project-plugins-changed", {
      projectId: "proj-a",
      plugins: [row("active")],
      trust: { projectId: "proj-a", decision: "enabled", enabled: true, persisted: true },
    });

    await act(async () => {
      resolveList?.([row("blocked")]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(useProjectPluginStore.getState().plugins.map((p) => p.state)).toEqual(["active"]);
      expect(useProjectPluginStore.getState().trust?.enabled).toBe(true);
    });
  });
});
