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

describe("CloudSyncBanner", () => {
  beforeEach(() => {
    useCloudSyncBannerStore.setState({ service: null });
    useProjectSettingsStore.setState({
      settings: { runCommands: [], cloudSyncWarningDismissed: false },
      projectId: "p1",
    });
    saveSettingsMock.mockReset().mockResolvedValue(undefined);
    notifyMock.mockReset();
    cleanup();
  });

  it("renders nothing when no service detected", () => {
    const { container } = render(<CloudSyncBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders banner with detected service name", () => {
    useCloudSyncBannerStore.setState({ service: "Dropbox" });
    render(<CloudSyncBanner />);
    expect(screen.getByText(/Dropbox-synced folder/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Don.+t show again/i })).toBeTruthy();
  });

  it("persists dismiss preference and clears the banner", async () => {
    useCloudSyncBannerStore.setState({ service: "iCloud Drive" });
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

  it("surfaces a toast when saving the dismiss preference fails", async () => {
    saveSettingsMock.mockRejectedValueOnce(new Error("disk full"));
    useCloudSyncBannerStore.setState({ service: "OneDrive" });
    render(<CloudSyncBanner />);

    fireEvent.click(screen.getByRole("button", { name: /Don.+t show again/i }));

    await waitFor(() => {
      expect(notifyMock).toHaveBeenCalled();
    });
    expect(useCloudSyncBannerStore.getState().service).toBe("OneDrive");
  });
});
