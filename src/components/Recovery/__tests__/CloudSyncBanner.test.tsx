// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import {
  render,
  renderHook,
  screen,
  within,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";

vi.mock("@/lib/platform", () => ({
  isMac: () => true,
  isLinux: () => false,
  isWindows: () => false,
}));

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
import { useCloudSyncWarning } from "@/hooks/app/useCloudSyncWarning";
import { useCloudSyncBannerStore } from "@/store/cloudSyncBannerStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useProjectStore } from "@/store/projectStore";

function setProject(id: string | null) {
  useProjectStore.setState({
    currentProject: id ? ({ id, path: "/x" } as never) : null,
  });
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

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
    const region = screen.getByRole("status");
    expect(region.hasAttribute("aria-live")).toBe(false);
    expect(region.textContent).toContain("Dropbox");
    expect(screen.getByRole("button", { name: /Don.*t warn for this project/i })).toBeTruthy();
  });

  it("hedges the sync claim instead of asserting the folder is syncing", () => {
    useCloudSyncBannerStore.setState({ service: "Dropbox", projectId: "p1" });
    render(<CloudSyncBanner />);
    const text = screen.getByRole("status").textContent ?? "";

    // Detection is a path-prefix match, so it establishes the location but
    // never that sync is running (#11767).
    expect(text).not.toMatch(/-synced folder/i);
    expect(text).toMatch(/\bmay\b/i);
  });

  it("renders the same title and message the inbox entry receives", () => {
    // The hook routes the inbox entry, the banner renders the live surface;
    // #11767 requires the two agree. Drive the real hook, then assert the
    // banner renders exactly the strings the notification was given — no
    // literals here, so this survives future rewording but catches drift.
    useProjectStore.setState({
      currentProject: {
        id: "p1",
        path: "/Users/foo/Library/CloudStorage/OneDrive-Personal/work",
      } as never,
    });

    renderHook(() => useCloudSyncWarning("/Users/foo"));

    const payload = notifyMock.mock.calls
      .map(([p]) => p as { title?: string; message?: string; supersedeKey?: string })
      .find((p) => p?.supersedeKey === "cloud-sync:p1");
    const title = payload?.title ?? "";
    const message = payload?.message ?? "";
    expect(title).not.toBe("");
    expect(message).toContain("OneDrive");
    // The inbox surface must hedge too, not just the banner (#11767).
    expect(message).not.toMatch(/-synced folder/i);
    expect(message).toMatch(/\bmay\b/i);

    render(<CloudSyncBanner />);
    const region = screen.getByRole("status");
    const titleEl = within(region).getByText(title);
    const descEl = within(region).getByText(message);

    // Compare raw textContent in the matching slots: getByText normalises
    // whitespace and would also pass if the two fields were swapped.
    expect(titleEl.textContent).toBe(title);
    expect(descEl.textContent).toBe(message);
    expect(descEl).toBe(region.querySelector("p"));
    expect(titleEl).not.toBe(descEl);
  });

  it("persists dismiss preference and clears the banner", async () => {
    useCloudSyncBannerStore.setState({ service: "iCloud Drive", projectId: "p1" });
    render(<CloudSyncBanner />);

    fireEvent.click(screen.getByRole("button", { name: /Don.*t warn for this project/i }));

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

    fireEvent.click(screen.getByRole("button", { name: /Don.*t warn for this project/i }));

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

    fireEvent.click(screen.getByRole("button", { name: /Don.*t warn for this project/i }));

    await waitFor(() => {
      expect(useCloudSyncBannerStore.getState().service).toBeNull();
    });
    expect(saveSettingsMock).not.toHaveBeenCalled();
  });

  it("surfaces a toast when saving the dismiss preference fails", async () => {
    saveSettingsMock.mockRejectedValueOnce(new Error("disk full"));
    useCloudSyncBannerStore.setState({ service: "OneDrive", projectId: "p1" });
    render(<CloudSyncBanner />);

    fireEvent.click(screen.getByRole("button", { name: /Don.*t warn for this project/i }));

    await waitFor(() => {
      expect(notifyMock).toHaveBeenCalled();
    });
    expect(useCloudSyncBannerStore.getState().service).toBe("OneDrive");
  });
});
