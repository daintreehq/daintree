// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HostListEntry } from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";

const { supported, dispatch, has, mac } = vi.hoisted(() => ({
  supported: { value: true },
  dispatch: vi.fn(() => Promise.resolve({ ok: true, result: undefined })),
  has: vi.fn(() => false),
  mac: { value: true },
}));

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});
vi.mock("@/lib/remoteHosts", () => ({ isRemoteHostsSupported: () => supported.value }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return {
    ...actual,
    isMac: () => mac.value,
    isWindows: () => false,
    isLinux: () => !mac.value,
  };
});
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch, has } }));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { HostChip } from "../HostChip";
import { _resetHostListForTesting } from "../hostList";
import { requestHostMenu } from "../hostMenuRequests";
import { takePendingHostUpdate } from "@/components/Settings/Hosts/hostUpdateRequests";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { useProjectStore } from "@/store/projectStore";
import type { Project } from "@shared/types";
import { _resetDriveLeaseBannerForTesting } from "@/components/Recovery/driveLeaseState";

const HANDSHAKE = {
  version: "1.0.0",
  commit: "abc",
  protocolVersion: 1,
  platform: "linux",
  arch: "x64",
} as const;

function host(id: string, name: string, extra: Partial<HostListEntry> = {}): HostListEntry {
  return {
    descriptor: {
      id,
      name,
      sshTarget: `greg@${name}`,
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 1,
      notificationsEnabled: false,
    },
    connection: { status: "connected", rttMs: 1, handshake: HANDSHAKE },
    summary: null,
    ...extra,
  };
}

let emit: ((event: RemoteHostsEvent) => void) | null = null;
const list = vi.fn<() => Promise<HostListEntry[]>>();
const switchWindowHost = vi.fn(() => Promise.resolve());

beforeEach(() => {
  cleanup();
  _resetHostListForTesting();
  _resetDriveLeaseBannerForTesting();
  useHostConnectionStore.getState().reset();
  supported.value = true;
  mac.value = true;
  dispatch.mockClear();
  has.mockReturnValue(false);
  switchWindowHost.mockClear();
  list.mockReset();
  emit = null;
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      remoteHosts: {
        list,
        switchWindowHost,
        onEvent: (cb: (event: RemoteHostsEvent) => void) => {
          emit = cb;
          return () => {
            emit = null;
          };
        },
      },
      update: { checkForUpdates: vi.fn(() => Promise.resolve()) },
    },
  });
});

afterEach(() => {
  cleanup();
});

async function renderWithHosts(hosts: HostListEntry[]) {
  list.mockResolvedValue(hosts);
  const utils = render(<HostChip />);
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

async function openMenu() {
  await act(async () => {
    expect(requestHostMenu()).toBe(true);
  });
  return screen.findByRole("menu");
}

describe("HostChip", () => {
  it("stays hidden until a host other than this machine exists", async () => {
    const { container } = await renderWithHosts([]);
    expect(container.querySelector("[data-testid='host-chip']")).toBeNull();
    expect(requestHostMenu()).toBe(false);

    act(() => emit?.({ type: "hosts-changed", hosts: [host("h1", "studio-01")] }));
    expect(container.querySelector("[data-testid='host-chip']")).not.toBeNull();
  });

  it("rereads the list when an event names a host it doesn't have yet", async () => {
    const { container } = await renderWithHosts([]);
    list.mockResolvedValue([host("h1", "studio-01")]);
    await act(async () => {
      emit?.({
        type: "connection-changed",
        hostId: "h1",
        connection: { status: "connecting", attempt: 1 },
      });
      await Promise.resolve();
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-testid='host-chip']")).not.toBeNull();
  });

  it("never appears where Remote Hosts isn't supported, and makes no host calls", async () => {
    supported.value = false;
    const { container } = await renderWithHosts([host("h1", "studio-01")]);
    expect(container.querySelector("[data-testid='host-chip']")).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("names this machine in a local window, with no state and no accent", async () => {
    const { container } = await renderWithHosts([host("h1", "studio-01")]);
    const chip = container.querySelector<HTMLElement>("[data-testid='host-chip']")!;
    expect(chip.textContent).toContain("This Mac");
    expect(chip.getAttribute("data-host-status")).toBe("local");
    expect(chip.className).not.toMatch(/accent/);
    for (const el of chip.querySelectorAll("*")) {
      expect(el.getAttribute("class") ?? "").not.toMatch(/accent/);
    }
  });

  it("shows the remote host's link state in a remote window", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "h1" };
    try {
      useHostConnectionStore.setState({
        hostId: "h1",
        hostName: "studio-01",
        connection: { status: "unreachable", lastSeenAt: 1, detail: null },
      });
      const { container } = await renderWithHosts([host("h1", "studio-01")]);
      const chip = container.querySelector<HTMLElement>("[data-testid='host-chip']")!;
      expect(chip.textContent).toContain("studio-01");
      expect(chip.textContent).toContain("unreachable");
      expect(chip.getAttribute("aria-label")).toBe("Host: studio-01, unreachable");
    } finally {
      delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
    }
  });

  it("lists this machine first, then hosts alphabetically, with Add host", async () => {
    await renderWithHosts([host("h2", "studio-02"), host("h1", "build-linux")]);
    const menu = await openMenu();
    const rows = [...menu.querySelectorAll("[data-host-id]")].map((el) =>
      el.getAttribute("data-host-id")
    );
    expect(rows).toEqual(["local", "h1", "h2"]);
    expect(menu.textContent).toContain("Add host…");
    expect(menu.textContent).not.toContain("Hosts overview…");
  });

  it("offers the hosts overview once something registers it", async () => {
    has.mockReturnValue(true);
    await renderWithHosts([host("h1", "studio-01")]);
    const menu = await openMenu();
    expect(menu.textContent).toContain("Hosts overview…");
  });

  it("switches this window on a plain click and opens a new window on Cmd-click", async () => {
    await renderWithHosts([host("h1", "studio-01"), host("h2", "studio-02")]);
    let menu = await openMenu();
    fireEvent.click(menu.querySelector("[data-host-id='h1']")!);
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenCalledWith({ hostId: "h1", newWindow: false })
    );

    menu = await openMenu();
    fireEvent.click(menu.querySelector("[data-host-id='h2']")!, { metaKey: true });
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenCalledWith({ hostId: "h2", newWindow: true })
    );
  });

  it("takes the open project along on a plain click, and opens just the host on Cmd-click", async () => {
    const previous = useProjectStore.getState().currentProject;
    useProjectStore.setState({ currentProject: { id: "proj-1" } as Project });
    try {
      await renderWithHosts([host("h1", "studio-01")]);
      let menu = await openMenu();
      fireEvent.click(menu.querySelector("[data-host-id='h1']")!);
      await waitFor(() =>
        expect(dispatch).toHaveBeenCalledWith(
          "project.openOnHost",
          { hostId: "h1", projectId: "proj-1" },
          { source: "user" }
        )
      );
      expect(switchWindowHost).not.toHaveBeenCalled();

      menu = await openMenu();
      fireEvent.click(menu.querySelector("[data-host-id='h1']")!, { metaKey: true });
      await waitFor(() =>
        expect(switchWindowHost).toHaveBeenCalledWith({ hostId: "h1", newWindow: true })
      );
    } finally {
      useProjectStore.setState({ currentProject: previous });
    }
  });

  it("uses Ctrl-click for a new window off macOS", async () => {
    mac.value = false;
    await renderWithHosts([host("h1", "studio-01")]);
    const menu = await openMenu();
    fireEvent.click(menu.querySelector("[data-host-id='h1']")!, { ctrlKey: true });
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenCalledWith({ hostId: "h1", newWindow: true })
    );
  });

  it("does nothing when the current host is picked again", async () => {
    await renderWithHosts([host("h1", "studio-01")]);
    const menu = await openMenu();
    fireEvent.click(menu.querySelector("[data-host-id='local']")!);
    expect(switchWindowHost).not.toHaveBeenCalled();
  });

  it("offers to update whichever side is behind on a version mismatch", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "h1" };
    try {
      useHostConnectionStore.setState({
        hostId: "h1",
        hostName: "studio-01",
        connection: {
          status: "version-mismatch",
          mismatch: { kind: "version", local: "1.4.0", remote: "1.3.0" },
          remote: { ...HANDSHAKE, version: "1.3.0" },
        },
      });
      await renderWithHosts([host("h1", "studio-01")]);
      const menu = await openMenu();
      expect(menu.textContent).toContain("Update studio-01");
    } finally {
      delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
    }
  });

  it("routes Update <host> to that host's own update flow", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "h1" };
    try {
      useHostConnectionStore.setState({
        hostId: "h1",
        hostName: "studio-01",
        connection: {
          status: "version-mismatch",
          mismatch: { kind: "version", local: "1.4.0", remote: "1.3.0" },
          remote: { ...HANDSHAKE, version: "1.3.0" },
        },
      });
      await renderWithHosts([host("h1", "studio-01")]);
      await openMenu();
      fireEvent.click(screen.getByText("Update studio-01"));
      expect(takePendingHostUpdate()).toBe("h1");
      expect(dispatch).toHaveBeenCalledWith("host.add", undefined, { source: "user" });
    } finally {
      delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
    }
  });
});
