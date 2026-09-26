// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HostProbeResult, HostInstallPlan } from "@shared/types/ipc/remoteHosts";
import { useRemoteHostsStore } from "@/store/remoteHostsStore";
import { AddHostDialog } from "../AddHostDialog";

function probeResult(overrides: Partial<HostProbeResult> = {}): HostProbeResult {
  return {
    sshTarget: "greg@studio",
    reachable: true,
    sshError: null,
    platform: "darwin",
    arch: "arm64",
    install: {
      path: "/Applications/Daintree.app",
      version: "1.4.0",
      commit: "abcdef0",
      packaging: "app-bundle",
    },
    hostModeListening: true,
    suggestedCommands: [],
    appRunning: true,
    appImages: [],
    canDownload: true,
    matchesClient: true,
    advice: {
      sleepObserved: null,
      sleepDisabled: null,
      keyring: null,
      linger: null,
      hostModeUnit: null,
      startAtLoginInstalled: true,
      fuse: null,
    },
    hostModeState: {
      pid: 4242,
      enabled: true,
      startAtLogin: true,
      startAtLoginInstalled: true,
      startAtLoginError: null,
      keychain: { state: "unknown", detail: "Not checked yet", checked: false },
    },
    ...overrides,
  };
}

const UPDATE_PLAN: HostInstallPlan = {
  kind: "install",
  version: "1.4.0",
  commit: "abcdef0",
  channel: "stable",
  delivery: "push-bundle",
  packaging: "app-bundle",
  artifactName: null,
  artifactUrl: null,
  restartsHost: true,
  userCommandNeeded: false,
  reason: null,
};

let remoteHosts: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  useRemoteHostsStore.getState().reset();
  remoteHosts = {
    discover: vi.fn(async () => []),
    probe: vi.fn(async () => probeResult()),
    planInstall: vi.fn(async () => UPDATE_PLAN),
    install: vi.fn(async () => ({ status: "agents-working", working: 2 })),
    add: vi.fn(async () => ({ id: "studio", name: "studio", sshTarget: "greg@studio" })),
    connect: vi.fn(async () => ({ status: "connecting", attempt: 1 })),
    cancelInstall: vi.fn(async () => true),
    startHostMode: vi.fn(async () => ({ probe: probeResult(), lingerRefused: null })),
  };
  Object.defineProperty(window, "electron", {
    value: { remoteHosts },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
});

async function walkToAddHost() {
  fireEvent.change(screen.getByPlaceholderText("user@studio-03"), {
    target: { value: "greg@studio" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Check host" }));
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  fireEvent.click(await screen.findByRole("button", { name: "Add host" }));
}

describe("AddHostDialog", () => {
  it("shows a discovery failure with Retry rather than an empty scan", async () => {
    remoteHosts.discover!.mockRejectedValueOnce(new Error("tailscale crashed"));
    render(<AddHostDialog isOpen onClose={() => {}} />);
    expect(await screen.findByText(/Couldn't look for machines: tailscale crashed/)).toBeTruthy();
    expect(screen.queryByText(/Nothing found/)).toBeNull();

    remoteHosts.discover!.mockResolvedValueOnce([
      {
        name: "studio-03",
        sshTarget: "studio-03.tail.ts.net",
        source: "tailscale",
        platform: "darwin",
        online: true,
        alreadyAdded: false,
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("studio-03")).toBeTruthy();
    expect(remoteHosts.discover).toHaveBeenCalledTimes(2);
  });

  it("holds the discovery spinner back until the loading gate passes", async () => {
    remoteHosts.discover!.mockReturnValue(new Promise(() => {}));
    render(<AddHostDialog isOpen onClose={() => {}} />);
    expect(screen.queryByText("Looking for Macs and Linux machines")).toBeNull();
    expect(await screen.findByText("Looking for Macs and Linux machines")).toBeTruthy();
  });

  it("keeps a host that was added but couldn't connect, and retries only the connection", async () => {
    const onClose = vi.fn();
    remoteHosts.connect!.mockRejectedValueOnce(new Error("Permission denied (publickey)"));
    render(<AddHostDialog isOpen onClose={onClose} />);
    await walkToAddHost();

    expect(await screen.findByText("studio was added to your hosts.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Permission denied");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Add host" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(remoteHosts.add).toHaveBeenCalledOnce();
    expect(remoteHosts.connect).toHaveBeenCalledTimes(2);
    expect(remoteHosts.connect).toHaveBeenLastCalledWith({ hostId: "studio" });
  });

  it("closes straight away when the host is added and connects", async () => {
    const onClose = vi.fn();
    render(<AddHostDialog isOpen onClose={onClose} />);
    await walkToAddHost();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("asks before an update that ends the host's terminals, naming the host", async () => {
    render(
      <AddHostDialog
        isOpen
        onClose={() => {}}
        existing={{ hostId: "studio", name: "studio", sshTarget: "greg@studio" }}
      />
    );
    remoteHosts.probe!.mockResolvedValue(probeResult({ matchesClient: false }));
    fireEvent.click(screen.getByRole("button", { name: "Check host" }));
    fireEvent.click(await screen.findByRole("button", { name: "Plan update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update host" }));
    await screen.findByText(/The host reports 2 working agents/);
    expect(remoteHosts.install).toHaveBeenCalledOnce();
    expect(remoteHosts.install).toHaveBeenLastCalledWith(
      expect.objectContaining({ whileWorking: "refuse" })
    );

    fireEvent.click(screen.getByRole("button", { name: "Update now and end its terminals" }));
    expect(await screen.findByText("Update 'studio' now?")).toBeTruthy();
    expect(screen.getByText(/Every terminal there ends/)).toBeTruthy();
    expect(remoteHosts.install).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Update and end terminals" }));
    await waitFor(() => expect(remoteHosts.install).toHaveBeenCalledTimes(2));
    expect(remoteHosts.install).toHaveBeenLastCalledWith(
      expect.objectContaining({ whileWorking: "proceed", hostId: "studio" })
    );
  });

  it("dispatches nothing when the update confirmation is cancelled", async () => {
    render(
      <AddHostDialog
        isOpen
        onClose={() => {}}
        existing={{ hostId: "studio", name: "studio", sshTarget: "greg@studio" }}
      />
    );
    remoteHosts.probe!.mockResolvedValue(probeResult({ matchesClient: false }));
    fireEvent.click(screen.getByRole("button", { name: "Check host" }));
    fireEvent.click(await screen.findByRole("button", { name: "Plan update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update host" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Update now and end its terminals" })
    );
    await screen.findByText("Update 'studio' now?");
    const confirm = screen
      .getByText("Update 'studio' now?")
      .closest("[role='alertdialog'], [role='dialog']")!;
    const cancel = screen
      .getAllByRole("button", { name: "Cancel" })
      .find((button) => confirm.contains(button))!;
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByText("Update 'studio' now?")).toBeNull());
    expect(remoteHosts.install).toHaveBeenCalledOnce();
  });

  it("reports the keyring process it saw, never that secrets will work", async () => {
    remoteHosts.probe!.mockResolvedValue(
      probeResult({
        platform: "linux",
        advice: {
          sleepObserved: null,
          sleepDisabled: null,
          keyring: "running",
          linger: null,
          hostModeUnit: true,
          startAtLoginInstalled: true,
          fuse: null,
        },
      })
    );
    render(<AddHostDialog isOpen onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("user@studio-03"), {
      target: { value: "greg@studio" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check host" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/A keyring process was running for the SSH user/)).toBeTruthy();
    expect(screen.queryByText(/can be stored there\./)).toBeNull();
  });

  it("turns Host mode on for good where it only listens, then reports why lingering was refused", async () => {
    const linuxAdvice = {
      sleepObserved: null,
      sleepDisabled: null,
      keyring: "not-running" as const,
      linger: false,
      hostModeUnit: false,
      startAtLoginInstalled: false,
      fuse: true,
    };
    remoteHosts.probe!.mockResolvedValue(
      probeResult({
        platform: "linux",
        hostModeState: {
          pid: 4242,
          enabled: false,
          startAtLogin: false,
          startAtLoginInstalled: false,
          startAtLoginError: null,
          keychain: { state: "unknown", detail: "Not checked yet", checked: false },
        },
        advice: linuxAdvice,
        suggestedCommands: [
          {
            label: "Let Host mode run without a login session",
            command: "loginctl enable-linger $USER",
          },
        ],
      })
    );
    remoteHosts.startHostMode!.mockResolvedValue({
      probe: probeResult({
        platform: "linux",
        advice: { ...linuxAdvice, hostModeUnit: true, startAtLoginInstalled: true },
        hostModeState: {
          pid: 4242,
          enabled: true,
          startAtLogin: true,
          startAtLoginInstalled: true,
          startAtLoginError: null,
          keychain: {
            state: "unavailable",
            detail: "Plugin secrets unavailable on this host: no keyring (headless)",
            checked: true,
          },
        },
        suggestedCommands: [
          {
            label: "Let Host mode run without a login session",
            command: "loginctl enable-linger $USER",
          },
        ],
      }),
      lingerRefused: "Could not enable linger: Interactive authentication required.",
    });
    render(<AddHostDialog isOpen onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("user@studio-03"), {
      target: { value: "greg@bigbox" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check host" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    expect(
      await screen.findByText(/listening on bigbox for now, but isn't switched on there/)
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on Host mode" }));
    expect(
      await screen.findByText(/Host mode is on at bigbox and starts at login there/)
    ).toBeTruthy();
    expect(remoteHosts.startHostMode).toHaveBeenCalledWith({ sshTarget: "greg@bigbox" });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText("Could not enable linger: Interactive authentication required.")
    ).toBeTruthy();
    expect(screen.getByText(/Daintree asked bigbox to let its Host mode service run/)).toBeTruthy();
    expect(screen.getByText("loginctl enable-linger $USER")).toBeTruthy();
    expect(
      screen.getByText(/Checked by Daintree on bigbox: Plugin secrets unavailable on this host/)
    ).toBeTruthy();
  });

  it("explains Local Network permission by routing, never promising tailnet hosts work", async () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    try {
      render(<AddHostDialog isOpen onClose={() => {}} />);
      fireEvent.change(screen.getByPlaceholderText("user@studio-03"), {
        target: { value: "greg@studio" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Check host" }));
      fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
      fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
      const copy = (await screen.findByText(/find devices on your local network/)).textContent!;
      expect(copy).toContain("depends on how macOS routes to that host, not on its address");
      expect(copy).toContain("Privacy & Security → Local Network");
      expect(copy).not.toMatch(/either way/);
    } finally {
      platform.mockRestore();
    }
  });
});
