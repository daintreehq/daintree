// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HostListEntry, PendingHostPlacement } from "@shared/types/remoteHosts";

const env = vi.hoisted(() => ({
  hosts: [] as HostListEntry[],
  viewHost: null as string | null,
}));
const update = vi.hoisted(() => vi.fn());
const requestHostUpdate = vi.hoisted(() => vi.fn());
const openHostsSettingsTab = vi.hoisted(() => vi.fn());

vi.mock("@/clients/remoteHostsClient", () => ({ remoteHostsClient: { update } }));
vi.mock("@/components/Settings/Hosts/hostUpdateRequests", () => ({ requestHostUpdate }));
vi.mock("@/components/Settings/Hosts/hostSettingsRequests", () => ({ openHostsSettingsTab }));
vi.mock("@/hooks/useHostConnection", () => ({ getViewHostId: () => env.viewHost }));
vi.mock("@/components/Hosts/hostList", () => ({
  useHostList: () => ({ hosts: env.hosts, localSummary: null }),
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: { currentProject: { id: string } }) => unknown) =>
    selector({ currentProject: { id: "proj-1" } }),
}));

import { PendingPlacementNotice } from "../PendingPlacementNotice";

const WORKTREE = "/repo/wt/feature-x";

function waitingOn(hostId: string, placement: Partial<PendingHostPlacement> = {}): HostListEntry {
  return {
    descriptor: {
      id: hostId,
      name: hostId,
      connection: { kind: "ssh", target: hostId },
      platform: null,
      arch: null,
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 0,
      notificationsEnabled: false,
      assistantControlEnabled: true,
      pendingPlacement: {
        projectId: "proj-1",
        worktreeId: WORKTREE,
        worktreePath: WORKTREE,
        label: "feature-x",
        requestedAt: 1,
        ...placement,
      },
    },
    connection: { status: "disconnected" },
    summary: null,
  };
}

beforeEach(() => {
  env.hosts = [];
  env.viewHost = null;
  update.mockReset().mockResolvedValue({});
  requestHostUpdate.mockReset();
  openHostsSettingsTab.mockReset();
});

afterEach(() => cleanup());

describe("PendingPlacementNotice", () => {
  it("shows nothing for a worktree that waits on no host", () => {
    env.hosts = [waitingOn("box", { worktreeId: "/repo/wt/other" })];
    render(<PendingPlacementNotice worktreeId={WORKTREE} inGutter />);
    expect(screen.queryByTestId("worktree-pending-placement")).toBeNull();
  });

  it("names the host it waits on, opens its setup, and cancels", () => {
    env.hosts = [waitingOn("box")];
    render(<PendingPlacementNotice worktreeId={WORKTREE} inGutter />);
    expect(screen.getByText("Opens on box after setup")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Set up…" }));
    expect(requestHostUpdate).toHaveBeenCalledWith("box", "setup");
    expect(openHostsSettingsTab).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(update).toHaveBeenCalledWith({ hostId: "box", pendingPlacement: null });
  });

  it("says why setup failed and offers Retry, still waiting", () => {
    env.hosts = [waitingOn("box", { failure: { message: "Host mode didn't start", at: 2 } })];
    render(<PendingPlacementNotice worktreeId={WORKTREE} inGutter={false} />);
    expect(screen.getByRole("alert").textContent).toContain("Couldn't set up box");
    expect(screen.getByText("Host mode didn't start")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(requestHostUpdate).toHaveBeenCalledWith("box", "setup");
    expect(update).not.toHaveBeenCalled();
  });

  it("says when the cancel didn't go through", async () => {
    update.mockRejectedValue(new Error("store is read-only"));
    env.hosts = [waitingOn("box")];
    render(<PendingPlacementNotice worktreeId={WORKTREE} inGutter />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText(/store is read-only|Couldn't cancel/)).toBeTruthy();
  });

  it("shows nothing in a window on another host", () => {
    env.viewHost = "studio";
    env.hosts = [waitingOn("box")];
    render(<PendingPlacementNotice worktreeId={WORKTREE} inGutter />);
    expect(screen.queryByTestId("worktree-pending-placement")).toBeNull();
  });
});
