// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@/lib/platform", () => ({
  isMac: () => true,
  isLinux: () => false,
  isWindows: () => false,
}));

const notify = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notify(...args),
}));

import { useCloudSyncWarning } from "../useCloudSyncWarning";
import { useCloudSyncBannerStore } from "@/store/cloudSyncBannerStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useProjectStore } from "@/store";
import type { ProjectSettings } from "@/types";

function setupProject(opts: {
  projectId: string;
  projectPath: string;
  settings: ProjectSettings | null;
  settingsProjectId?: string | null;
}) {
  useProjectStore.setState({
    currentProject: {
      id: opts.projectId,
      path: opts.projectPath,
      // Minimum viable Project shape — extra fields not used by the hook
    } as never,
  });
  useProjectSettingsStore.setState({
    settings: opts.settings,
    projectId: opts.settingsProjectId ?? opts.projectId,
  });
}

describe("useCloudSyncWarning", () => {
  beforeEach(() => {
    notify.mockClear();
    useCloudSyncBannerStore.setState({ service: null });
    useProjectStore.setState({ currentProject: null });
    useProjectSettingsStore.setState({ settings: null, projectId: null });
  });

  it("does nothing when homeDir is missing", () => {
    setupProject({
      projectId: "p1",
      projectPath: "/Users/foo/Library/CloudStorage/Dropbox/work",
      settings: { runCommands: [] },
    });
    renderHook(() => useCloudSyncWarning(undefined));
    expect(useCloudSyncBannerStore.getState().service).toBeNull();
  });

  it("clears banner when project is not in a cloud-synced folder", () => {
    setupProject({
      projectId: "p1",
      projectPath: "/Users/foo/Code/project",
      settings: { runCommands: [] },
    });
    useCloudSyncBannerStore.setState({ service: "Dropbox" });
    renderHook(() => useCloudSyncWarning("/Users/foo"));
    expect(useCloudSyncBannerStore.getState().service).toBeNull();
  });

  it("sets banner when project is in a cloud-synced folder", () => {
    setupProject({
      projectId: "p1",
      projectPath: "/Users/foo/Library/CloudStorage/Dropbox-Personal/work",
      settings: { runCommands: [] },
    });
    renderHook(() => useCloudSyncWarning("/Users/foo"));
    expect(useCloudSyncBannerStore.getState().service).toBe("Dropbox");
  });

  it("respects cloudSyncWarningDismissed flag in project settings", () => {
    setupProject({
      projectId: "p1",
      projectPath: "/Users/foo/Library/CloudStorage/Dropbox-Personal/work",
      settings: { runCommands: [], cloudSyncWarningDismissed: true },
    });
    renderHook(() => useCloudSyncWarning("/Users/foo"));
    expect(useCloudSyncBannerStore.getState().service).toBeNull();
  });

  it("does not run when settings belong to a different project", () => {
    setupProject({
      projectId: "p1",
      projectPath: "/Users/foo/Library/CloudStorage/Dropbox-Personal/work",
      settings: { runCommands: [] },
      settingsProjectId: "p2",
    });
    renderHook(() => useCloudSyncWarning("/Users/foo"));
    expect(useCloudSyncBannerStore.getState().service).toBeNull();
  });

  it("routes an inbox notification once per project when banner is shown", () => {
    setupProject({
      projectId: "p1",
      projectPath: "/Users/foo/Library/CloudStorage/Dropbox-Personal/work",
      settings: { runCommands: [] },
    });
    const { rerender } = renderHook(({ home }: { home: string }) => useCloudSyncWarning(home), {
      initialProps: { home: "/Users/foo" },
    });
    rerender({ home: "/Users/foo" });
    rerender({ home: "/Users/foo" });

    const cloudSyncCalls = notify.mock.calls.filter(
      ([payload]) => payload?.supersedeKey === "cloud-sync:p1"
    );
    expect(cloudSyncCalls).toHaveLength(1);
    expect(cloudSyncCalls[0]?.[0]).toMatchObject({
      type: "warning",
      priority: "low",
      supersedeKey: "cloud-sync:p1",
      countable: false,
      context: { eventKind: "host" },
    });
  });

  it("populates the banner store with the project id alongside the service", () => {
    setupProject({
      projectId: "alpha",
      projectPath: "/Users/foo/Library/CloudStorage/Dropbox-Personal/work",
      settings: { runCommands: [] },
    });
    renderHook(() => useCloudSyncWarning("/Users/foo"));

    const state = useCloudSyncBannerStore.getState();
    expect(state.service).toBe("Dropbox");
    expect(state.projectId).toBe("alpha");
  });
});
