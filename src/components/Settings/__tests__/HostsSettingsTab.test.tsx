// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HostListEntry } from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import { useRemoteHostsStore } from "@/store/remoteHostsStore";
import HostsSettingsTab from "../Hosts/HostsSettingsTab";
import { requestHostUpdate, takePendingHostUpdate } from "../Hosts/hostUpdateRequests";

function entry(id: string, name: string): HostListEntry {
  return {
    descriptor: {
      id,
      name,
      sshTarget: `greg@${id}`,
      platform: "linux",
      arch: "x64",
      lastHandshake: {
        version: "1.4.0",
        commit: "abcdef0123",
        protocolVersion: 1,
        platform: "linux",
        arch: "x64",
      },
      lastSeenAt: null,
      addedAt: 1,
      notificationsEnabled: false,
    },
    connection: { status: "unreachable", lastSeenAt: null, detail: null },
    summary: null,
  };
}

let listeners: Array<(event: RemoteHostsEvent) => void>;
let remoteHosts: Record<string, ReturnType<typeof vi.fn>>;
let hostMode: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  listeners = [];
  useRemoteHostsStore.getState().reset();
  remoteHosts = {
    list: vi.fn(async () => [] as HostListEntry[]),
    forget: vi.fn(async () => {}),
    update: vi.fn(async () => ({})),
    connect: vi.fn(async () => ({ status: "connecting", attempt: 1 })),
    discover: vi.fn(async () => []),
    listClipboardGrants: vi.fn(async () => []),
    resetClipboardGrants: vi.fn(async () => {}),
    onEvent: vi.fn((cb: (event: RemoteHostsEvent) => void) => {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    }),
  };
  hostMode = {
    getStatus: vi.fn(async () => ({
      supported: true,
      enabled: false,
      startAtLogin: false,
      socketPath: "/run/user/501/daintree/host.sock",
      listening: false,
      attachedClients: [],
      rows: [],
    })),
    onEvent: vi.fn(() => () => {}),
  };
  Object.defineProperty(window, "electron", {
    value: { remoteHosts, hostMode },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
});

describe("HostsSettingsTab", () => {
  it("offers to add a host when there are none", async () => {
    render(<HostsSettingsTab />);
    expect(
      await screen.findByText(
        "Add a Mac or Linux machine to run projects and agents on it from here"
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add host" })).toBeTruthy();
  });

  it("gives the hosts list and this machine's Host mode their own sections", async () => {
    const { container } = render(<HostsSettingsTab />);
    expect(await screen.findByText("Allow this machine to be a host")).toBeTruthy();
    const headings = [...container.querySelectorAll("[data-settings-section-title]")].map(
      (heading) => heading.textContent
    );
    expect(headings).toEqual(["Remote hosts", "This machine as a host"]);
    // Search results scroll to these.
    expect(container.querySelector("#hosts-list")).not.toBeNull();
    expect(container.querySelector("#host-mode")).not.toBeNull();
  });

  it("lists hosts with what was observed, and follows host list events", async () => {
    remoteHosts.list!.mockResolvedValue([entry("studio-03", "studio-03")]);
    render(<HostsSettingsTab />);
    expect(await screen.findByText("studio-03")).toBeTruthy();
    expect(
      screen.getByText(/greg@studio-03 · Linux · x64 · Daintree 1.4.0 \(abcdef0\)/)
    ).toBeTruthy();
    expect(screen.getByText(/Unreachable · never seen/)).toBeTruthy();

    listeners.forEach((l) =>
      l({
        type: "hosts-changed",
        hosts: [entry("studio-03", "studio-03"), entry("bigbox", "bigbox")],
      })
    );
    expect(await screen.findByText("bigbox")).toBeTruthy();
  });

  it("opens a host's detail and forgets it only after confirming", async () => {
    remoteHosts.list!.mockResolvedValue([entry("studio-03", "studio-03")]);
    render(<HostsSettingsTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Open studio-03" }));
    expect(screen.getByText("Agent CLIs")).toBeTruthy();
    expect(screen.getByText("Connect to this host to see the agent CLIs it reports")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Forget host" }));
    expect(remoteHosts.forget).not.toHaveBeenCalled();
    const confirm = await screen.findAllByRole("button", { name: "Forget host" });
    fireEvent.click(confirm[confirm.length - 1]!);
    await waitFor(() => expect(remoteHosts.forget).toHaveBeenCalledWith({ hostId: "studio-03" }));
  });

  it("shows a failed Connect inline and retries it", async () => {
    remoteHosts.list!.mockResolvedValue([entry("studio-03", "studio-03")]);
    remoteHosts.connect!.mockRejectedValueOnce(new Error("Permission denied (publickey)"));
    render(<HostsSettingsTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Open studio-03" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't connect: Permission denied (publickey)"
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(remoteHosts.connect).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("opens a host's update flow when asked before the tab was showing", async () => {
    remoteHosts.list!.mockResolvedValue([entry("studio-03", "studio-03")]);
    requestHostUpdate("studio-03");
    render(<HostsSettingsTab />);
    expect(await screen.findByText("Update studio-03")).toBeTruthy();
    expect(takePendingHostUpdate()).toBeNull();
  });

  it("opens a host's update flow when asked while the tab is showing", async () => {
    remoteHosts.list!.mockResolvedValue([entry("studio-03", "studio-03")]);
    render(<HostsSettingsTab />);
    await screen.findByRole("button", { name: "Open studio-03" });
    act(() => requestHostUpdate("studio-03"));
    expect(await screen.findByText("Update studio-03")).toBeTruthy();
  });
});
