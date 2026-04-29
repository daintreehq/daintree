// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@/lib/platform", () => ({
  isMac: () => true,
  isLinux: () => false,
}));

import { useCloudSyncWarning } from "../useCloudSyncWarning";
import { useCloudSyncBannerStore } from "@/store/cloudSyncBannerStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
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
    useCloudSyncBannerStore.setState({ service: null });
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
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

  it("adds an inbox entry once per project when banner is shown", () => {
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

    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries.filter((e) => e.title === "Cloud sync folder detected")).toHaveLength(1);
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
