// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HostListEntry } from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import { useRemoteHostsStore } from "@/store/remoteHostsStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import HostsSettingsTab from "../Hosts/HostsSettingsTab";
import { requestHostUpdate, takePendingHostUpdate } from "../Hosts/hostUpdateRequests";
import { requestHostPlugins, takePendingHostPlugins } from "../Hosts/hostPluginRequests";
import {
  _resetPluginViewConsentResetsForTesting,
  notePluginViewConsentReset,
  onPluginViewConsentReset,
} from "../Hosts/pluginViewConsentResets";

const { connectionKindMock } = vi.hoisted(() => ({
  connectionKindMock: vi.fn<() => "ssh" | "wsl">(() => "ssh"),
}));
vi.mock("@/lib/remoteHosts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/remoteHosts")>()),
  remoteConnectionKind: connectionKindMock,
}));

function entry(id: string, name: string): HostListEntry {
  return {
    descriptor: {
      id,
      name,
      connection: { kind: "ssh", target: `greg@${id}` },
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
      assistantControlEnabled: false,
    },
    connection: { status: "unreachable", lastSeenAt: null, detail: null },
    summary: null,
  };
}

let listeners: Array<(event: RemoteHostsEvent) => void>;
let remoteHosts: Record<string, ReturnType<typeof vi.fn>>;
let hostMode: Record<string, ReturnType<typeof vi.fn>>;
let deviceAnswer: Record<string, ReturnType<typeof vi.fn>>;

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
    listPluginViewConsents: vi.fn(async () => []),
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
  deviceAnswer = {
    getStatus: vi.fn(async () => ({
      enabled: false,
      listening: false,
      port: 7421,
      tailnetHost: null,
      sshTarget: "greg@studio",
      error: null,
      pairing: null,
      devices: [],
      recentAnswers: [],
    })),
    onEvent: vi.fn(() => () => {}),
  };
  Object.defineProperty(window, "electron", {
    value: { remoteHosts, hostMode, deviceAnswer },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
  _resetPluginViewConsentResetsForTesting();
});

describe("HostsSettingsTab", () => {
  it("offers to add a host when there are none", async () => {
    render(
      <TooltipProvider>
        <HostsSettingsTab />
      </TooltipProvider>
    );
    expect(
      await screen.findByText(
        "Add a Mac or Linux machine to run projects and agents on it from here"
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add host" })).toBeTruthy();
  });

  it("offers a WSL distribution, not a Mac or Linux machine, on Windows", async () => {
    connectionKindMock.mockReturnValue("wsl");
    try {
      render(
        <TooltipProvider>
          <HostsSettingsTab />
        </TooltipProvider>
      );
      expect(
        await screen.findByText("Add a WSL distribution to run projects and agents in it from here")
      ).toBeTruthy();
      expect(screen.queryByText(/Add a Mac or Linux machine/)).toBeNull();
    } finally {
      connectionKindMock.mockReturnValue("ssh");
    }
  });

  it("gives the hosts list, Host mode and answering from another device their own sections", async () => {
    const { container } = render(
      <TooltipProvider>
        <HostsSettingsTab />
      </TooltipProvider>
    );
    expect(await screen.findByText("Allow this machine to be a host")).toBeTruthy();
    const headings = [...container.querySelectorAll("[data-settings-section-title]")].map(
      (heading) => heading.textContent
    );
    expect(headings).toEqual([
      "Remote hosts",
      "This machine as a host",
      "Answer from another device",
    ]);
    // Search results scroll to these.
    expect(container.querySelector("#hosts-list")).not.toBeNull();
    expect(container.querySelector("#host-mode")).not.toBeNull();
  });

  it("lists hosts with what was observed, and follows host list events", async () => {
    remoteHosts.list!.mockResolvedValue([entry("studio-03", "studio-03")]);
    render(
      <TooltipProvider>
        <HostsSettingsTab />
      </TooltipProvider>
    );
    expect(await screen.findByText("studio-03")).toBeTruthy();
    // The build it last reported is in the host's details, not its row.
    expect(screen.getByText(/greg@studio-03 · Linux/)).toBeTruthy();
    expect(screen.getByText(/Unreachable · never seen/)).toBeTruthy();

    listeners.forEach((l) =>
      l({
        type: "hosts-changed",
        hosts: [entry("studio-03", "studio-03"), entry("bigbox", "bigbox")],
      })
    );
    expect(await screen.findByText("bigbox")).toBeTruthy();
  });

  it("keeps hosts an event listed when the first read answers empty after it (#15887)", async () => {
    let answer!: (hosts: HostListEntry[]) => void;
    remoteHosts.list!.mockReturnValueOnce(new Promise<HostListEntry[]>((r) => (answer = r)));
    render(
      <TooltipProvider>
        <HostsSettingsTab />
      </TooltipProvider>
    );
    await waitFor(() => expect(remoteHosts.list).toHaveBeenCalledTimes(1));
    act(() =>
      listeners.forEach((l) => l({ type: "hosts-changed", hosts: [entry("bigbox", "bigbox")] }))
    );
    expect(await screen.findByText("bigbox")).toBeTruthy();

    await act(async () => answer([]));
    expect(screen.getByText("bigbox")).toBeTruthy();
  });

  it("opens a host's detail and removes it only after confirming", async () => {
    remoteHosts.list!.mockResolvedValue([entry("studio-03", "studio-03")]);
    render(
      <TooltipProvider>
        <HostsSettingsTab />
      </TooltipProvider>
    );
    fireEvent.click(await screen.findByRole("button", { name: "Details for studio-03" }));
    expect(screen.getByText("Agent CLIs")).toBeTruthy();
    expect(screen.getByText("Connect to studio-03 to see its agent CLIs")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove host" }));
    expect(remoteHosts.forget).not.toHaveBeenCalled();
    const confirm = await screen.findAllByRole("button", { name: "Remove host" });
    fireEvent.click(confirm[confirm.length - 1]!);
    await waitFor(() => expect(remoteHosts.forget).toHaveBeenCalledWith({ hostId: "studio-03" }));
  });

  it("removes a host from its row, only after confirming", async () => {
    remoteHosts.list!.mockResolvedValue([entry("studio-03", "studio-03")]);
    render(
      <TooltipProvider>
        <HostsSettingsTab />
      </TooltipProvider>
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove studio-03 from this device" })
    );
    expect(remoteHosts.forget).not.toHaveBeenCalled();
    expect(await screen.findByText("Remove 'studio-03' from this device?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove host" }));
    await waitFor(() => expect(remoteHosts.forget).toHaveBeenCalledWith({ hostId: "studio-03" }));
  });

  it("sends one removal at a time, and keeps what removing does in view beside a failure", async () => {
    remoteHosts.list!.mockResolvedValue([entry("studio-03", "studio-03")]);
    let refuse: (error: Error) => void = () => {};
    remoteHosts.forget!.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (refuse = reject))
    );
    render(
      <TooltipProvider>
        <HostsSettingsTab />
      </TooltipProvider>
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove studio-03 from this device" })
    );
    const confirm = await screen.findByRole("button", { name: "Remove host" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(remoteHosts.forget).toHaveBeenCalledTimes(1);
    await act(async () => refuse(new Error("link down")));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/windows attached to it return to this machine/)).toBeTruthy();
  });

  it("shows a failed Connect inline and retries it", async () => {
    // Not connected and nothing trying: a host retrying on its own offers Disconnect instead.
    remoteHosts.list!.mockResolvedValue([
      { ...entry("studio-03", "studio-03"), connection: { status: "disconnected" } },
    ]);
    remoteHosts.connect!.mockRejectedValueOnce(new Error("Permission denied (publickey)"));
    render(
      <TooltipProvider>
        <HostsSettingsTab />
      </TooltipProvider>
    );
    fireEvent.click(await screen.findByRole("button", { name: "Details for studio-03" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't connect: Permission denied (publickey)"
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(remoteHosts.connect).toHaveBeenCalledTimes(2);
    // Busy until the link reports what happened, not just until the dial started.
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
      true
    );
    act(() =>
      listeners.forEach((l) =>
        l({
          type: "connection-changed",
          hostId: "studio-03",
          connection: { status: "disconnected" },
        })
      )
    );
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
        false
      )
    );
  });

  it("shows a Connect that reached ssh but no host as the link reported it", async () => {
    remoteHosts.list!.mockResolvedValue([
      { ...entry("studio-03", "studio-03"), connection: { status: "disconnected" } },
    ]);
    remoteHosts.connect!.mockResolvedValueOnce({
      status: "unreachable",
      lastSeenAt: null,
      detail: "Permission denied (publickey).",
      stoppedRetrying: true,
    });
    render(
      <TooltipProvider>
        <HostsSettingsTab />
      </TooltipProvider>
    );
    fireEvent.click(await screen.findByRole("button", { name: "Details for studio-03" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't connect: Permission denied (publickey)."
    );
  });

  it("lists hosts A to Z, numbered as people number them", async () => {
    remoteHosts.list!.mockResolvedValue([
      entry("zeta", "zeta"),
      entry("studio-10", "studio-10"),
      entry("alpha", "Alpha"),
      entry("studio-2", "studio-2"),
    ]);
    render(
      <TooltipProvider>
        <HostsSettingsTab />
      </TooltipProvider>
    );
    await screen.findByText("zeta");
    const names = screen
      .getAllByRole("button", { name: /^Details for / })
      .map((button) => button.getAttribute("aria-label")?.replace("Details for ", ""));
    expect(names).toEqual(["Alpha", "studio-2", "studio-10", "zeta"]);
  });

  it("opens a host's update flow when asked before the tab was showing", async () => {
    remoteHosts.list!.mockResolvedValue([entry("studio-03", "studio-03")]);
    requestHostUpdate("studio-03");
    render(
      <TooltipProvider>
        <HostsSettingsTab />
      </TooltipProvider>
    );
    expect(await screen.findByText("Update studio-03")).toBeTruthy();
    expect(takePendingHostUpdate()).toBeNull();
  });

  it("opens a host's update flow when asked while the tab is showing", async () => {
    remoteHosts.list!.mockResolvedValue([entry("studio-03", "studio-03")]);
    render(
      <TooltipProvider>
        <HostsSettingsTab />
      </TooltipProvider>
    );
    await screen.findByRole("button", { name: "Details for studio-03" });
    act(() => requestHostUpdate("studio-03"));
    expect(await screen.findByText("Update studio-03")).toBeTruthy();
  });

  it("opens a host's plugins when asked after its update flow was asked for", async () => {
    remoteHosts.list!.mockResolvedValue([entry("studio-03", "studio-03")]);
    render(
      <TooltipProvider>
        <HostsSettingsTab />
      </TooltipProvider>
    );
    await screen.findByRole("button", { name: "Details for studio-03" });
    act(() => requestHostUpdate("studio-03"));
    expect(await screen.findByText("Update studio-03")).toBeTruthy();
    act(() => requestHostPlugins("studio-03"));
    await waitFor(() => expect(screen.queryByText("Update studio-03")).toBeNull());
    expect(screen.getByRole("button", { name: "Remove host" })).toBeTruthy();
  });

  it("opens on the host and section asked for before it mounted, then follows each later request", async () => {
    let answerList: (hosts: HostListEntry[]) => void = () => {};
    remoteHosts.list!.mockImplementation(
      () =>
        new Promise<HostListEntry[]>((resolve) => {
          answerList = resolve;
        })
    );
    const scrolls: Array<{ id: string; options: unknown }> = [];
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function (this: Element, options?: boolean | ScrollIntoViewOptions) {
        scrolls.push({ id: this.id, options });
      });
    const lastScroll = () => scrolls[scrolls.length - 1];
    try {
      requestHostPlugins("studio-03", "host-plugin-views");
      render(
        <TooltipProvider>
          <HostsSettingsTab />
        </TooltipProvider>
      );
      await act(async () =>
        answerList([entry("studio-02", "studio-02"), entry("studio-03", "studio-03")])
      );
      await waitFor(() => expect(lastScroll()?.id).toBe("host-plugin-views"));
      expect(lastScroll()?.options).toEqual({ block: "start" });
      expect(document.getElementById("host-plugin-views")?.textContent).toContain(
        "Plugins from studio-03"
      );
      expect(takePendingHostPlugins()).toBeNull();

      // A repeat of the same section scrolls there again, as does a change.
      for (const [sectionId, title] of [
        ["host-plugin-views", "Plugin views"],
        ["host-plugins", "Plugins"],
        ["host-plugins", "Plugins"],
        ["host-plugin-views", "Plugin views"],
      ] as const) {
        scrolls.length = 0;
        act(() => requestHostPlugins("studio-03", sectionId));
        await waitFor(() => expect(lastScroll()?.id).toBe(sectionId));
        expect(lastScroll()?.options).toEqual({ block: "start" });
        expect(document.getElementById(sectionId)?.textContent).toContain(title);
      }
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  it("holds a reset plugin view's retry until the tab goes away with Settings", async () => {
    const retry = vi.fn();
    onPluginViewConsentReset("studio-03", "acme.graph", retry);
    const { unmount } = render(
      <TooltipProvider>
        <HostsSettingsTab />
      </TooltipProvider>
    );
    await screen.findByRole("button", { name: "Add host" });
    act(() => notePluginViewConsentReset("studio-03", "acme.graph"));
    expect(retry).not.toHaveBeenCalled();
    unmount();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
