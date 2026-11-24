// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import type { HostListEntry } from "@shared/types/remoteHosts";

vi.mock("../HostProjectPicker", () => ({
  HostProjectPicker: ({ hostId }: { hostId: string }) => <div>Projects on {hostId}</div>,
}));
vi.mock("../HostSwitchDialog", () => ({ HostSwitchDialog: () => null }));
vi.mock("../HostSwitcherPalette", () => ({
  HostSwitcherPalette: () => <div data-testid="host-switcher-palette" />,
}));
vi.mock("../HostSetupRecipeConfirm", () => ({ HostSetupRecipeConfirm: () => null }));
const env = vi.hoisted(() => ({
  projectId: null as string | null,
  hosts: [] as HostListEntry[],
}));
const update = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: { currentProject: { id: string } | null }) => unknown) =>
    selector({ currentProject: env.projectId ? { id: env.projectId } : null }),
}));
vi.mock("@/components/Hosts/hostList", () => ({
  useHostList: () => ({ hosts: env.hosts, localSummary: null }),
  getHostListSnapshot: () => ({ hosts: env.hosts, localSummary: null }),
}));
vi.mock("@/clients/remoteHostsClient", () => ({ remoteHostsClient: { update } }));

import { HostSwitchDialogHost } from "../HostSwitchDialogHost";
import {
  _resetHostSwitchRequestsForTesting,
  currentHostSwitchRequest,
} from "../hostSwitchRequests";
import { _resetPendingPlacementsForTesting } from "@/components/Hosts/pendingPlacement";

let listeners: Array<(event: RemoteHostsEvent) => void> = [];
const takeProjectOffer = vi.fn<() => Promise<string | null>>();

beforeEach(() => {
  listeners = [];
  takeProjectOffer.mockReset();
  Object.assign(window, {
    electron: {
      remoteHosts: {
        takeProjectOffer,
        onEvent: (listener: (event: RemoteHostsEvent) => void) => {
          listeners.push(listener);
          return () => {
            listeners = listeners.filter((l) => l !== listener);
          };
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  env.projectId = null;
  env.hosts = [];
  update.mockClear();
  _resetPendingPlacementsForTesting();
  _resetHostSwitchRequestsForTesting();
});

describe("HostSwitchDialogHost", () => {
  it("offers the host's projects in a new window that was opened for them", async () => {
    takeProjectOffer.mockResolvedValue("studio-01");
    render(<HostSwitchDialogHost />);
    expect(await screen.findByText("Projects on studio-01")).toBeTruthy();
  });

  it("shows an offer handed out only once even when StrictMode replays the effect", async () => {
    // Main hands the offer to the first ask and nothing to the next.
    takeProjectOffer.mockResolvedValueOnce("studio-01").mockResolvedValue(null);
    render(
      <StrictMode>
        <HostSwitchDialogHost />
      </StrictMode>
    );
    expect(await screen.findByText("Projects on studio-01")).toBeTruthy();
    expect(takeProjectOffer).toHaveBeenCalledTimes(2);
  });

  it("asks again when main says an offer is waiting for a view already up", async () => {
    takeProjectOffer.mockResolvedValueOnce(null).mockResolvedValueOnce("studio-01");
    render(<HostSwitchDialogHost />);
    await act(async () => {});
    expect(screen.queryByText(/Projects on/)).toBeNull();
    act(() => listeners.forEach((listener) => listener({ type: "project-offer" })));
    expect(await screen.findByText("Projects on studio-01")).toBeTruthy();
    expect(takeProjectOffer).toHaveBeenCalledTimes(2);
  });

  it("carries on a worktree waiting on a host that is already up when the view mounts", async () => {
    takeProjectOffer.mockResolvedValue(null);
    env.projectId = "proj-1";
    env.hosts = [
      {
        descriptor: {
          id: "box",
          name: "box",
          connection: { kind: "ssh", target: "box" },
          platform: null,
          arch: null,
          lastHandshake: null,
          lastSeenAt: null,
          addedAt: 0,
          notificationsEnabled: false,
          assistantControlEnabled: true,
          pendingPlacement: {
            projectId: "proj-1",
            worktreeId: "/repo/wt/x",
            worktreePath: "/repo/wt/x",
            label: "x",
            requestedAt: 1,
          },
        },
        connection: {
          status: "connected",
          rttMs: null,
          handshake: {
            version: "1",
            commit: "c",
            protocolVersion: 1,
            platform: "linux",
            arch: "x64",
          },
        },
        summary: null,
      },
    ];

    render(<HostSwitchDialogHost />);
    await act(async () => {});

    // The dialog host registered before the resume asked for it.
    expect(currentHostSwitchRequest()).toMatchObject({
      toHostId: "box",
      worktreePath: "/repo/wt/x",
      askFirst: true,
    });
    expect(update).toHaveBeenCalledWith({ hostId: "box", pendingPlacement: null });
  });

  it("keeps the host switcher palette mounted for Switch host to open", async () => {
    takeProjectOffer.mockResolvedValue(null);
    render(<HostSwitchDialogHost />);
    await act(async () => {});
    expect(screen.getByTestId("host-switcher-palette")).toBeTruthy();
  });
});
