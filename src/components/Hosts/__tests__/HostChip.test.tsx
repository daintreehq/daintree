// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
// How this machine reaches hosts: ssh, or (a Windows Shell) WSL distros.
const connectionKind = vi.hoisted(() => ({ value: "ssh" as "ssh" | "wsl" }));
vi.mock("@/lib/remoteHosts", () => ({
  isRemoteShellSupported: () => supported.value,
  isRemoteHostSupported: () => supported.value,
  isEitherRemoteRoleSupported: () => supported.value,
  remoteConnectionKind: () => connectionKind.value,
}));
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

import { TooltipProvider } from "@/components/ui/tooltip";
import { HostChip } from "../HostChip";
import { _resetHostListForTesting } from "../hostList";
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
      connection: { kind: "ssh", target: `greg@${name}` },
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 1,
      notificationsEnabled: false,
      assistantMessagingEnabled: false,
      assistantStartEnabled: false,
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
  connectionKind.value = "ssh";
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

/** The Settings tabs asked to open, in order: Update <host> opens Settings → Hosts. */
let openedSettingsTabs: string[] = [];
const recordSettingsTab = (event: Event) => {
  openedSettingsTabs.push((event as CustomEvent<{ tab: string }>).detail.tab);
};

beforeEach(() => {
  openedSettingsTabs = [];
  window.addEventListener("daintree:open-settings-tab", recordSettingsTab);
});

afterEach(() => {
  window.removeEventListener("daintree:open-settings-tab", recordSettingsTab);
  cleanup();
});

async function renderWithHosts(hosts: HostListEntry[]) {
  list.mockResolvedValue(hosts);
  const utils = render(
    <TooltipProvider>
      <HostChip />
    </TooltipProvider>
  );
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

async function openMenu() {
  fireEvent.keyDown(screen.getByTestId("host-chip"), { key: "Enter" });
  return screen.findByRole("menu");
}

describe("HostChip", () => {
  it("stays hidden until a host other than this machine exists", async () => {
    const { container } = await renderWithHosts([]);
    expect(container.querySelector("[data-testid='host-chip']")).toBeNull();

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

  it("names this machine in words in a local window, with no accent and no remote tint", async () => {
    const { container } = await renderWithHosts([host("h1", "studio-01")]);
    const chip = container.querySelector<HTMLElement>("[data-testid='host-chip']")!;
    expect(chip.textContent).toBe("This Mac");
    expect(chip.getAttribute("aria-label")).toBe("Working on This Mac");
    expect(chip.getAttribute("data-host-location")).toBe("local");
    expect(chip.className).not.toMatch(/status-info/);
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
      expect(chip.getAttribute("aria-label")).toBe("Working on SSH · studio-01, unreachable");
      // A different place reads as one, never as a status fill or an accent,
      // in every remote state.
      expect(chip.getAttribute("data-host-location")).toBe("remote");
      expect(chip.className).not.toMatch(/status-/);
      expect(chip.className).not.toMatch(/accent/);
    } finally {
      delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
    }
  });

  it("says a Windows Shell's remote window is in a WSL distro", async () => {
    connectionKind.value = "wsl";
    mac.value = false;
    window.__DAINTREE_HOST_ID__ = { id: "h1" };
    try {
      useHostConnectionStore.setState({
        hostId: "h1",
        hostName: "Ubuntu",
        connection: { status: "unreachable", lastSeenAt: 1, detail: null },
      });
      const { container } = await renderWithHosts([host("h1", "Ubuntu")]);
      const chip = container.querySelector<HTMLElement>("[data-testid='host-chip']")!;
      expect(chip.getAttribute("aria-label")).toBe("Working on WSL · Ubuntu, unreachable");
      expect(chip.textContent).not.toContain("SSH");
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

  it("only goes to a host on a plain click, even with a project open; Cmd-click opens a new window", async () => {
    const previous = useProjectStore.getState().currentProject;
    useProjectStore.setState({ currentProject: { id: "proj-1" } as Project });
    try {
      await renderWithHosts([host("h1", "studio-01")]);
      let menu = await openMenu();
      fireEvent.click(menu.querySelector("[data-host-id='h1']")!);
      await waitFor(() =>
        expect(switchWindowHost).toHaveBeenCalledWith({ hostId: "h1", newWindow: false })
      );
      expect(dispatch).not.toHaveBeenCalledWith(
        "project.openOnHost",
        expect.anything(),
        expect.anything()
      );

      menu = await openMenu();
      fireEvent.click(menu.querySelector("[data-host-id='h1']")!, { metaKey: true });
      await waitFor(() =>
        expect(switchWindowHost).toHaveBeenCalledWith({ hostId: "h1", newWindow: true })
      );
    } finally {
      useProjectStore.setState({ currentProject: previous });
    }
  });

  it('brings the branch along only from "Continue this branch on…"', async () => {
    const previous = useProjectStore.getState().currentProject;
    useProjectStore.setState({ currentProject: { id: "proj-1" } as Project });
    try {
      await renderWithHosts([host("h1", "studio-01")]);
      const menu = await openMenu();
      const continueOn = within(menu).getByText("Continue this branch on…");
      fireEvent.keyDown(continueOn, { key: "ArrowRight" });
      fireEvent.click(
        await screen.findByText("studio-01", { selector: "[data-continue-host-id] *" })
      );
      await waitFor(() =>
        expect(dispatch).toHaveBeenCalledWith(
          "project.openOnHost",
          { hostId: "h1", projectId: "proj-1" },
          { source: "user" }
        )
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

  it("leaves a different build it connected to anyway to the host's details", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "h1" };
    try {
      useHostConnectionStore.setState({
        hostId: "h1",
        hostName: "studio-01",
        connection: {
          status: "connected",
          rttMs: 4,
          handshake: { ...HANDSHAKE, version: "1.3.0" },
          buildMismatch: { kind: "version", local: "1.4.0", remote: "1.3.0" },
        },
      });
      const { container } = await renderWithHosts([host("h1", "studio-01")]);
      const chip = container.querySelector<HTMLElement>("[data-testid='host-chip']")!;
      expect(chip.getAttribute("data-host-status")).toBe("build-differs");
      expect(chip.textContent).not.toContain("different build");
      const menu = await openMenu();
      expect(menu.textContent).not.toContain("Update studio-01");
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
      expect(openedSettingsTabs).toEqual(["hosts"]);
    } finally {
      delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
    }
  });

  it("offers the update of a host a switch was refused for, from a window still on this machine", async () => {
    const behind = host("h1", "studio-01", {
      connection: {
        status: "version-mismatch",
        mismatch: { kind: "version", local: "1.4.0", remote: "1.3.0" },
        remote: { ...HANDSHAKE, version: "1.3.0" },
      },
    });
    await renderWithHosts([behind, host("h2", "studio-02")]);
    const menu = await openMenu();
    expect(menu.textContent).toContain("Update studio-01");
    expect(menu.textContent).not.toContain("Update studio-02");
    fireEvent.click(screen.getByText("Update studio-01"));
    expect(takePendingHostUpdate()).toBe("h1");
    expect(openedSettingsTabs).toEqual(["hosts"]);
  });

  it("offers to update this machine once, however many hosts are ahead of it", async () => {
    const ahead = (id: string, name: string) =>
      host(id, name, {
        connection: {
          status: "version-mismatch",
          mismatch: { kind: "version", local: "1.3.0", remote: "1.4.0" },
          remote: { ...HANDSHAKE, version: "1.4.0" },
        },
      });
    await renderWithHosts([ahead("h1", "studio-01"), ahead("h2", "studio-02")]);
    const menu = await openMenu();
    expect(menu.textContent?.match(/Update this machine/g)).toHaveLength(1);
    fireEvent.click(screen.getByText("Update this machine"));
    expect(window.electron.update.checkForUpdates).toHaveBeenCalled();
  });
});
