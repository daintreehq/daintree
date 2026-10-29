// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DriveLeaseView } from "@shared/types/ipc/driveLease";

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

afterEach(() => {
  cleanup();
  _resetDriveLeaseBannerForTesting();
  takeControl.mockClear();
});

describe("PluginViewBlockedPlaceholder", () => {
  it("says the view waits for control, offers it with what it does, and loads once this window has it", async () => {
    seedDriveLeaseView(lease(false));
    const onRetry = vi.fn();
    const { container } = render(
      <PluginViewBlockedPlaceholder pluginDisplayName="Docker Console" onRetry={onRetry} />
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
    render(<PluginViewBlockedPlaceholder pluginDisplayName="Docker Console" onRetry={onRetry} />);
    expect(screen.getByText("Docker Console is blocked on this computer")).toBeTruthy();
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
