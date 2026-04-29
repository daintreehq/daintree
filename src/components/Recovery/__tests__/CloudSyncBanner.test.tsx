// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const saveSettingsMock = vi.fn(() => Promise.resolve());
vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    saveSettings: saveSettingsMock,
  }),
}));

const notifyMock = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: (payload: unknown) => notifyMock(payload),
}));

import { CloudSyncBanner } from "../CloudSyncBanner";
import { useCloudSyncBannerStore } from "@/store/cloudSyncBannerStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useProjectStore } from "@/store/projectStore";

function setProject(id: string | null) {
  useProjectStore.setState({
    currentProject: id ? ({ id, path: "/x" } as never) : null,
  });
}

describe("CloudSyncBanner", () => {
  beforeEach(() => {
    useCloudSyncBannerStore.setState({ service: null, projectId: null });
    useProjectSettingsStore.setState({
      settings: { runCommands: [], cloudSyncWarningDismissed: false },
      projectId: "p1",
    });
    setProject("p1");
    saveSettingsMock.mockReset().mockResolvedValue(undefined);
    notifyMock.mockReset();
    cleanup();
  });

  it("renders nothing when no service detected", () => {
    const { container } = render(<CloudSyncBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders banner with detected service name", () => {
    useCloudSyncBannerStore.setState({ service: "Dropbox", projectId: "p1" });
    render(<CloudSyncBanner />);
    expect(screen.getByText(/Dropbox-synced folder/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Don.+t show again/i })).toBeTruthy();
  });

  it("persists dismiss preference and clears the banner", async () => {
    useCloudSyncBannerStore.setState({ service: "iCloud Drive", projectId: "p1" });
    render(<CloudSyncBanner />);

    fireEvent.click(screen.getByRole("button", { name: /Don.+t show again/i }));

    await waitFor(() => {
      expect(saveSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({ cloudSyncWarningDismissed: true })
      );
    });
    await waitFor(() => {
      expect(useCloudSyncBannerStore.getState().service).toBeNull();
    });
  });

  it("preserves all existing project settings fields when persisting dismiss", async () => {
    useProjectSettingsStore.setState({
      settings: {
        runCommands: [{ command: "npm start", label: "Start" }],
        cloudSyncWarningDismissed: false,
        projectIconSvg: "<svg/>",
      } as never,
      projectId: "p1",
    });
    useCloudSyncBannerStore.setState({ service: "OneDrive", projectId: "p1" });
    render(<CloudSyncBanner />);

    fireEvent.click(screen.getByRole("button", { name: /Don.+t show again/i }));

    await waitFor(() => {
      expect(saveSettingsMock).toHaveBeenCalledOnce();
    });
    const saved = (saveSettingsMock.mock.calls[0] as unknown[])?.[0] as Record<string, unknown>;
    expect(saved).toEqual({
      runCommands: [{ command: "npm start", label: "Start" }],
      cloudSyncWarningDismissed: true,
      projectIconSvg: "<svg/>",
    });
  });

  it("does not save to a different project after a switch race", async () => {
    useCloudSyncBannerStore.setState({ service: "Dropbox", projectId: "p1" });
    render(<CloudSyncBanner />);

    // Simulate the race: live project flips to p2 before the click handler runs.
    setProject("p2");

    fireEvent.click(screen.getByRole("button", { name: /Don.+t show again/i }));

    await waitFor(() => {
      expect(useCloudSyncBannerStore.getState().service).toBeNull();
    });
    expect(saveSettingsMock).not.toHaveBeenCalled();
  });

  it("surfaces a toast when saving the dismiss preference fails", async () => {
    saveSettingsMock.mockRejectedValueOnce(new Error("disk full"));
    useCloudSyncBannerStore.setState({ service: "OneDrive", projectId: "p1" });
    render(<CloudSyncBanner />);

    fireEvent.click(screen.getByRole("button", { name: /Don.+t show again/i }));

    await waitFor(() => {
      expect(notifyMock).toHaveBeenCalled();
    });
    expect(useCloudSyncBannerStore.getState().service).toBe("OneDrive");
  });
});
