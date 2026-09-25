// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListEntry } from "@shared/types/remoteHosts";
import type { HostWorktreeEntry } from "@shared/types/ipc/hostMetrics";
import { HANDSHAKE, makeSummary } from "./fixtures";

const { hostList, switchToHost } = vi.hoisted(() => ({
  hostList: { hosts: [] as HostListEntry[], localSummary: null },
  switchToHost: vi.fn(async () => {}),
}));

vi.mock("../../hostList", () => ({
  useHostList: () => hostList,
  hasRemoteHosts: (state: { hosts: unknown[] }) => state.hosts.length > 0,
}));
vi.mock("../../hostSwitching", () => ({
  switchToHost,
  isNewWindowClick: (event: { metaKey: boolean; ctrlKey: boolean }) =>
    event.metaKey || event.ctrlKey,
}));

import { OtherHostsWorktrees } from "../OtherHostsWorktrees";

function entry(id: string, connected: boolean): HostListEntry {
  return {
    descriptor: {
      id,
      name: id,
      sshTarget: id,
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 0,
      notificationsEnabled: false,
    },
    connection: connected
      ? { status: "connected", rttMs: 5, handshake: HANDSHAKE }
      : { status: "disconnected" },
    summary: makeSummary({ hostId: id }),
  };
}

const worktree: HostWorktreeEntry = {
  hostId: "studio-01",
  projectId: "p-remote",
  projectName: "helios",
  worktreeId: "/srv/helios-feature",
  name: "helios-feature",
  branch: "feature/x",
  path: "/srv/helios-feature",
  isMainWorktree: false,
  modifiedCount: 3,
  lastActivityAt: null,
};

const listWorktrees = vi.fn(async ({ hostId }: { hostId: string }) =>
  hostId === "studio-01" ? [worktree] : []
);

beforeEach(() => {
  switchToHost.mockClear();
  listWorktrees.mockClear();
  hostList.hosts = [entry("studio-01", true), entry("away", false)];
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { hostMetrics: { listWorktrees } },
  });
});

describe("OtherHostsWorktrees", () => {
  it("lists every other host's worktrees read-only and opens the right host on click", async () => {
    const onNavigate = vi.fn();
    render(<OtherHostsWorktrees onNavigate={onNavigate} />);
    expect(listWorktrees).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "All hosts" }));
    });
    const rows = await screen.findAllByTestId("other-host-worktree-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("feature/x");
    expect(rows[0]!.textContent).toContain("helios · 3 changed");
    // This window's own host isn't asked; an unreachable host says so rather than listing nothing.
    expect(listWorktrees).toHaveBeenCalledWith({ hostId: "studio-01" });
    expect(listWorktrees).not.toHaveBeenCalledWith({ hostId: "away" });
    expect(screen.getByText("Not connected")).toBeTruthy();
    // Read-only: nothing on a row but the way to its host.
    expect(rows[0]!.querySelectorAll("button, input")).toHaveLength(0);

    fireEvent.click(rows[0]!);
    expect(onNavigate).toHaveBeenCalled();
    expect(switchToHost).toHaveBeenCalledWith("studio-01", false, "p-remote");
  });

  it("renders nothing without another host", () => {
    hostList.hosts = [];
    const { container } = render(<OtherHostsWorktrees onNavigate={() => {}} />);
    expect(container.textContent).toBe("");
  });
});
