// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { DriveLeaseView } from "@shared/types/ipc/driveLease";

const dispatch = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

const takeControl = vi.hoisted(() => vi.fn(async (_projectId: string, _panelId?: string) => {}));
vi.mock("@/components/Recovery/takeControl", () => ({
  takeControl,
  useTakeControlPending: () => false,
}));
vi.mock("@/hooks/useHostConnection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useHostConnection")>()),
  useHostConnection: () => ({ hostName: "studio-01" }),
}));

import { PluginViewBlockedPlaceholder } from "../PluginViewBlockedPlaceholder";
import {
  _resetDriveLeaseBannerForTesting,
  seedDriveLeaseView,
} from "@/components/Recovery/driveLeaseState";
import {
  _resetPluginViewConsentResetsForTesting,
  holdPluginViewRetries,
  notePluginViewConsentReset,
} from "@/components/Settings/Hosts/pluginViewConsentResets";
import { takePendingHostPlugins } from "@/components/Settings/Hosts/hostPluginRequests";
import type { SettingsNavTarget } from "@/components/Settings";
import { useSettingsDialog } from "@/hooks/app/useSettingsDialog";

const lease = (drivingHere: boolean): DriveLeaseView => ({
  projectId: "proj-1",
  holder: {
    leaseId: 3,
    endpointId: "view-9",
    clientId: "shell-b",
    clientName: "greg-mbp",
    isHostLocal: false,
    acquiredAt: 1,
  },
  drivingHere,
  isHolderEndpoint: drivingHere,
  viewerIsHostLocal: false,
});

beforeEach(() => {
  window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
});

afterEach(() => {
  cleanup();
  _resetDriveLeaseBannerForTesting();
  _resetPluginViewConsentResetsForTesting();
  takePendingHostPlugins();
  delete window.__DAINTREE_HOST_ID__;
  takeControl.mockClear();
  dispatch.mockClear();
});

describe("PluginViewBlockedPlaceholder", () => {
  it("says the view waits for control, offers it with what it does, and loads once this window has it", async () => {
    seedDriveLeaseView(lease(false));
    const onRetry = vi.fn();
    const { container } = render(
      <PluginViewBlockedPlaceholder
        pluginId="acme.docker"
        pluginDisplayName="Docker Console"
        onRetry={onRetry}
      />
    );
    expect(screen.getByText("Waiting for control")).toBeTruthy();
    expect(container.textContent).toContain(
      "Docker Console shows here once this window has control"
    );
    expect(screen.queryByText(/is blocked on this computer/)).toBeNull();
    const button = screen.getByRole("button", { name: "Take control" });
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy && document.getElementById(describedBy)?.textContent).toMatch(
      /^Makes .* read-only on /
    );
    fireEvent.click(button);
    // No pane to hand the keyboard back to from a plugin view.
    await vi.waitFor(() => expect(takeControl).toHaveBeenCalledWith("proj-1", undefined));
    expect(onRetry).not.toHaveBeenCalled();

    act(() => seedDriveLeaseView(lease(true)));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("says the view is blocked here when this window drives the project", () => {
    seedDriveLeaseView(lease(true));
    const onRetry = vi.fn();
    render(
      <PluginViewBlockedPlaceholder
        pluginId="acme.docker"
        pluginDisplayName="Docker Console"
        onRetry={onRetry}
      />
    );
    expect(screen.getByText("Docker Console is blocked on this computer")).toBeTruthy();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("opens this host's plugin views in Settings, and keeps Try again", async () => {
    seedDriveLeaseView(lease(true));
    const onRetry = vi.fn();
    render(
      <PluginViewBlockedPlaceholder
        pluginId="acme.docker"
        pluginDisplayName="Docker Console"
        onRetry={onRetry}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open plugin views" }));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    const [actionId, target, options] = dispatch.mock.calls[0] as unknown as [
      string,
      SettingsNavTarget,
      unknown,
    ];
    expect(actionId).toBe("app.settings.openTab");
    expect(options).toEqual({ source: "user" });
    // The target lands on that host's Plugin views, not its plugin list.
    const { result } = renderHook(() => useSettingsDialog());
    act(() => result.current.handleOpenSettingsTab(target));
    expect(result.current.settingsTab).toBe("hosts");
    expect(takePendingHostPlugins()).toEqual({
      hostId: "studio-01",
      sectionId: "host-plugin-views",
    });

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("offers no Settings link in a window on this machine", () => {
    delete window.__DAINTREE_HOST_ID__;
    seedDriveLeaseView(lease(true));
    render(
      <PluginViewBlockedPlaceholder
        pluginId="acme.docker"
        pluginDisplayName="Docker Console"
        onRetry={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "Open plugin views" })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("asks again by itself once Settings closes after its answer was reset", () => {
    seedDriveLeaseView(lease(true));
    const onRetry = vi.fn();
    render(
      <PluginViewBlockedPlaceholder
        pluginId="acme.docker"
        pluginDisplayName="Docker Console"
        onRetry={onRetry}
      />
    );
    const closeSettings = holdPluginViewRetries();
    act(() => notePluginViewConsentReset("studio-01", "acme.other"));
    act(() => notePluginViewConsentReset("studio-02", "acme.docker"));
    act(() => notePluginViewConsentReset("studio-01", "acme.docker"));
    expect(onRetry).not.toHaveBeenCalled();
    act(() => closeSettings());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("leaves a reset alone while the view waits for control", () => {
    seedDriveLeaseView(lease(false));
    const onRetry = vi.fn();
    render(
      <PluginViewBlockedPlaceholder
        pluginId="acme.docker"
        pluginDisplayName="Docker Console"
        onRetry={onRetry}
      />
    );
    act(() => notePluginViewConsentReset("studio-01", "acme.docker"));
    expect(onRetry).not.toHaveBeenCalled();
  });

  it.each([
    ["blocked here", true],
    ["driven elsewhere", false],
  ])("offers a host's way out beside its own action when %s", (_label, drivingHere) => {
    seedDriveLeaseView(lease(drivingHere));
    const showWorktrees = vi.fn();
    render(
      <PluginViewBlockedPlaceholder
        pluginId="acme.docker"
        pluginDisplayName="Docker Console"
        onRetry={vi.fn()}
        leave={{ label: "Show worktrees", onClick: showWorktrees }}
      />
    );
    expect(
      screen.getByRole("button", { name: drivingHere ? "Try again" : "Take control" })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show worktrees" }));
    expect(showWorktrees).toHaveBeenCalledTimes(1);
  });
});
