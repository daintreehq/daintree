// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  HostProbeResult,
  HostInstallPlan,
  RemoteHostsEvent,
} from "@shared/types/ipc/remoteHosts";
import type { HostListEntry } from "@shared/types/remoteHosts";
import { useRemoteHostsStore } from "@/store/remoteHostsStore";
import { AddHostDialog } from "../AddHostDialog";

function probeResult(overrides: Partial<HostProbeResult> = {}): HostProbeResult {
  return {
    connection: { kind: "ssh", target: "greg@studio" },
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

/** What the host says an update would end: one project's terminals, an operation, another Shell. */
const IMPACT = {
  detail: {
    projects: [{ projectName: "api", terminals: 3, working: 1, waiting: 1 }],
    complete: true,
    operations: 1,
    otherShells: ["greg-air"],
    terminalIds: ["t1", "t2", "t3"],
    shellIds: ["c-air"],
  },
  agents: null,
};

let remoteHosts: Record<string, ReturnType<typeof vi.fn>>;
let listeners: Array<(event: RemoteHostsEvent) => void> = [];

function known(id: string, name: string, target: string): HostListEntry {
  return {
    descriptor: {
      id,
      name,
      connection: { kind: "ssh", target },
      platform: null,
      arch: null,
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 0,
      notificationsEnabled: false,
      assistantMessagingEnabled: false,
      assistantStartEnabled: false,
    },
    connection: { status: "disconnected" },
    summary: null,
  };
}

beforeEach(() => {
  listeners = [];
  useRemoteHostsStore.getState().reset();
  remoteHosts = {
    discover: vi.fn(async () => []),
    probe: vi.fn(async () => probeResult()),
    planInstall: vi.fn(async () => UPDATE_PLAN),
    install: vi.fn(async () => ({ status: "needs-confirmation", impact: IMPACT })),
    add: vi.fn(async (payload: { name: string; connection: unknown }) => ({
      id: "studio",
      name: payload.name,
      connection: payload.connection,
    })),
    connect: vi.fn(async () => ({ status: "connected", rttMs: 3, handshake: {} })),
    onEvent: vi.fn((cb: (event: RemoteHostsEvent) => void) => {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    }),
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
  fireEvent.change(screen.getByPlaceholderText("user@devbox.local"), {
    target: { value: "greg@studio" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Check host" }));
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  // Host mode was on there already, so the host was saved on the way.
  fireEvent.click(await screen.findByRole("button", { name: "Done" }));
}

describe("AddHostDialog", () => {
  it("offers the .local name when ssh can't resolve a bare host name, and checks that instead", async () => {
    remoteHosts.probe!.mockResolvedValueOnce(
      probeResult({
        reachable: false,
        sshError:
          "ssh: Could not resolve hostname studio: nodename nor servname provided, or not known",
        platform: null,
        install: null,
        hostModeListening: false,
        matchesClient: null,
      })
    );
    render(<AddHostDialog isOpen onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("user@devbox.local"), {
      target: { value: "greg@studio" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check host" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try greg@studio.local" }));
    await waitFor(() => expect(remoteHosts.probe).toHaveBeenCalledTimes(2));
    expect(remoteHosts.probe!.mock.calls[1]![0]).toEqual({
      connection: { kind: "ssh", target: "greg@studio.local" },
    });
    expect(await screen.findByText("Works")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Try / })).toBeNull();
  });

  it("shows a discovery failure with Retry rather than an empty scan", async () => {
    remoteHosts.discover!.mockRejectedValueOnce(new Error("tailscale crashed"));
    render(<AddHostDialog isOpen onClose={() => {}} />);
    expect(await screen.findByText(/Couldn't look for machines: tailscale crashed/)).toBeTruthy();
    expect(screen.queryByText(/No machines answered/)).toBeNull();

    remoteHosts.discover!.mockResolvedValueOnce([
      {
        name: "studio-03",
        connection: { kind: "ssh", target: "studio-03.tail.ts.net" },
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

  it("holds the discovery spinner back until the loading gate passes, keeping its line", async () => {
    remoteHosts.discover!.mockReturnValue(new Promise(() => {}));
    render(<AddHostDialog isOpen onClose={() => {}} />);
    // The line is laid out from the start, so the heading never stands alone and nothing jumps.
    const line = screen.getByText("Looking for Macs and Linux machines").closest("p")!;
    expect(line.getAttribute("aria-hidden")).toBe("true");
    expect(line.className).toContain("invisible");
    await waitFor(() => expect(line.getAttribute("aria-hidden")).toBe("false"));
    expect(line.className).not.toContain("invisible");
  });

  it("lists machines not yet added first, numbered names in order", async () => {
    const found = (name: string, alreadyAdded = false) => ({
      name,
      connection: { kind: "ssh" as const, target: `${name}.local` },
      source: "mdns" as const,
      platform: "darwin" as const,
      online: true,
      alreadyAdded,
    });
    remoteHosts.discover!.mockResolvedValueOnce([
      found("studio-10"),
      found("studio-01", true),
      found("studio-2"),
      found("Studio-03"),
    ]);
    render(<AddHostDialog isOpen onClose={() => {}} />);
    const list = (await screen.findByText("studio-10")).closest("ul")!;
    const names = [...list.querySelectorAll("li")].map(
      (item) => item.querySelector(".font-medium")!.textContent
    );
    expect(names).toEqual(["studio-2", "Studio-03", "studio-10", "studio-01"]);
  });

  it("ends on a connection the link reported unreachable, keeping the host and retrying only the link", async () => {
    const onClose = vi.fn();
    remoteHosts.connect!.mockResolvedValueOnce({ status: "connecting", attempt: 1 });
    render(<AddHostDialog isOpen onClose={onClose} />);
    await walkToAddHost();
    await waitFor(() => expect(remoteHosts.connect).toHaveBeenCalledOnce());
    // The dial only started; what happened arrives as the link reports it.
    act(() =>
      listeners.forEach((l) =>
        l({
          type: "connection-changed",
          hostId: "studio",
          connection: {
            status: "unreachable",
            lastSeenAt: null,
            detail: "Permission denied (publickey).",
            stoppedRetrying: true,
          },
        })
      )
    );

    expect(await screen.findByText("Couldn't connect to studio")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Permission denied");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(remoteHosts.add).toHaveBeenCalledOnce();
    expect(remoteHosts.connect).toHaveBeenCalledTimes(2);
    expect(remoteHosts.connect).toHaveBeenLastCalledWith({ hostId: "studio" });
  });

  it("ends on Host mode being off there, with Set up…", async () => {
    remoteHosts.connect!.mockResolvedValueOnce({
      status: "unreachable",
      lastSeenAt: null,
      detail: null,
      hostModeOff: true,
      stoppedRetrying: true,
    });
    render(<AddHostDialog isOpen onClose={() => {}} />);
    await walkToAddHost();
    expect(await screen.findByText("studio is saved, but Host mode is off there")).toBeTruthy();
    remoteHosts.probe!.mockResolvedValue(probeResult({ hostModeListening: false }));
    fireEvent.click(screen.getByRole("button", { name: "Set up…" }));
    // Checked again rather than trusting the probe the link just contradicted.
    await waitFor(() => expect(remoteHosts.probe).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("button", { name: "Turn on Host mode" })).toBeTruthy();
    // The saved record keeps its target: no way back to change it.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("ends on a build that doesn't match, with Update…", async () => {
    remoteHosts.connect!.mockResolvedValueOnce({
      status: "version-mismatch",
      mismatch: { kind: "version", local: "1.4.0", remote: "1.3.0" },
      remote: { version: "1", commit: "c", protocolVersion: 1, platform: "linux", arch: "x64" },
    });
    render(<AddHostDialog isOpen onClose={() => {}} />);
    await walkToAddHost();
    expect(
      await screen.findByText("studio is saved, but needs a compatible Daintree build")
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update…" }));
    await waitFor(() => expect(remoteHosts.planInstall).toHaveBeenCalled());
  });

  it("saves a host whose Host mode was skipped without dialling it", async () => {
    remoteHosts.probe!.mockResolvedValue(probeResult({ hostModeListening: false }));
    render(<AddHostDialog isOpen onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("user@devbox.local"), {
      target: { value: "greg@studio" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check host" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add host" }));
    expect(await screen.findByText("Saved, not connected")).toBeTruthy();
    expect(remoteHosts.add).toHaveBeenCalledOnce();
    expect(remoteHosts.connect).not.toHaveBeenCalled();
  });

  it("saves the host the moment Host mode is on there, and stops offering Cancel", async () => {
    remoteHosts.probe!.mockResolvedValue(probeResult({ hostModeListening: false }));
    render(<AddHostDialog isOpen onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("user@devbox.local"), {
      target: { value: "greg@studio" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check host" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(remoteHosts.add).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Turn on Host mode" }));
    expect(await screen.findByText(/studio is saved in your host list/)).toBeTruthy();
    expect(remoteHosts.add).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();

    // Finishing reuses the record rather than adding a second.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(remoteHosts.connect).toHaveBeenCalled());
    expect(remoteHosts.add).toHaveBeenCalledOnce();
  });

  it("says a taken or reserved name, or an added target, before anything is checked", () => {
    useRemoteHostsStore.getState().setHosts([known("lab", "studio", "admin@lab.local")]);
    render(<AddHostDialog isOpen onClose={() => {}} />);
    const targetField = screen.getByPlaceholderText("user@devbox.local");
    fireEvent.change(targetField, { target: { value: "greg@studio" } });
    expect(document.body.textContent).toContain('Another host is already called "studio"');
    const check = () => screen.getByRole("button", { name: "Check host" });
    expect(check().getAttribute("aria-disabled")).toBe("true");

    fireEvent.change(screen.getByPlaceholderText("studio"), { target: { value: "this mac" } });
    expect(document.body.textContent).toContain("is what Daintree calls this machine");

    fireEvent.change(screen.getByDisplayValue("this mac"), { target: { value: "Lab two" } });
    fireEvent.change(targetField, { target: { value: "admin@LAB.local" } });
    expect(document.body.textContent).toContain('is already in your host list as "studio"');
    expect(check().getAttribute("aria-disabled")).toBe("true");
  });

  it("warns, but doesn't block, another account on a machine already added", () => {
    useRemoteHostsStore.getState().setHosts([known("lab", "Lab", "admin@lab.local")]);
    render(<AddHostDialog isOpen onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("user@devbox.local"), {
      target: { value: "greg@lab.local" },
    });
    fireEvent.change(screen.getByPlaceholderText("lab"), { target: { value: "Lab (greg)" } });
    expect(screen.getByTestId("add-host-same-machine").textContent).toContain(
      '"Lab" already reaches this machine as admin@lab.local'
    );
    expect(
      screen.getByRole("button", { name: "Check host" }).getAttribute("aria-disabled")
    ).not.toBe("true");
  });

  it("can't be closed while Host mode is being switched on there", async () => {
    remoteHosts.probe!.mockResolvedValue(probeResult({ hostModeListening: false }));
    let finish!: (value: unknown) => void;
    remoteHosts.startHostMode!.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const onClose = vi.fn();
    render(<AddHostDialog isOpen onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText("user@devbox.local"), {
      target: { value: "greg@studio" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check host" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn on Host mode" }));
    expect(screen.getByRole("button", { name: "Skip" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(screen.getByTestId("add-host-dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish({ probe: probeResult(), lingerRefused: null }));
    fireEvent.keyDown(screen.getByTestId("add-host-dialog"), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
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
        existing={{
          hostId: "studio",
          name: "studio",
          connection: { kind: "ssh", target: "greg@studio" },
        }}
      />
    );
    remoteHosts.probe!.mockResolvedValue(probeResult({ matchesClient: false }));
    fireEvent.click(screen.getByRole("button", { name: "Check host" }));
    fireEvent.click(await screen.findByRole("button", { name: "Plan update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update host" }));
    // What the restart ends, as the host listed it, before anything is changed.
    await screen.findByText("api: 3 terminals (agents 1 working, 1 waiting)");
    expect(screen.getByText("1 operation still running")).toBeTruthy();
    expect(screen.getByText("Sessions from greg-air")).toBeTruthy();
    expect(remoteHosts.install).toHaveBeenCalledOnce();
    expect(remoteHosts.install).toHaveBeenLastCalledWith(
      expect.objectContaining({ whileWorking: "refuse" })
    );

    fireEvent.click(screen.getByRole("button", { name: "Update now…" }));
    expect(await screen.findByText("Update 'studio' now?")).toBeTruthy();
    expect(screen.getByText(/3 terminals there end/)).toBeTruthy();
    expect(remoteHosts.install).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Update and end 3 terminals" }));
    await waitFor(() => expect(remoteHosts.install).toHaveBeenCalledTimes(2));
    // The confirmed set travels with it, so anything new stops the restart.
    expect(remoteHosts.install).toHaveBeenLastCalledWith(
      expect.objectContaining({ whileWorking: "proceed", hostId: "studio", confirmed: IMPACT })
    );
  });

  it("names the operations and Sessions an update ends when no terminals are running", async () => {
    const impact = {
      detail: { ...IMPACT.detail, projects: [], terminalIds: [] },
      agents: null,
    };
    remoteHosts.install!.mockResolvedValue({ status: "needs-confirmation", impact });
    render(
      <AddHostDialog
        isOpen
        onClose={() => {}}
        existing={{
          hostId: "studio",
          name: "studio",
          connection: { kind: "ssh", target: "greg@studio" },
        }}
      />
    );
    remoteHosts.probe!.mockResolvedValue(probeResult({ matchesClient: false }));
    fireEvent.click(screen.getByRole("button", { name: "Check host" }));
    fireEvent.click(await screen.findByRole("button", { name: "Plan update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update host" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update now…" }));
    await screen.findByText("Update 'studio' now?");
    expect(screen.getByText(/which ends everything listed/)).toBeTruthy();
    expect(screen.queryByText(/\b0 terminals\b/)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Update and end 1 operation and 1 session" })
    );
    await waitFor(() => expect(remoteHosts.install).toHaveBeenCalledTimes(2));
    expect(remoteHosts.install).toHaveBeenLastCalledWith(
      expect.objectContaining({ whileWorking: "proceed", confirmed: impact })
    );
  });

  it("lists two projects that read the same as two lines", async () => {
    const twin = { projectName: "api", terminals: 1, working: 0, waiting: 0 };
    remoteHosts.install!.mockResolvedValue({
      status: "needs-confirmation",
      impact: {
        detail: {
          ...IMPACT.detail,
          projects: [twin, twin],
          operations: 0,
          otherShells: [],
          terminalIds: ["t1", "t2"],
          shellIds: [],
        },
        agents: null,
      },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <AddHostDialog
          isOpen
          onClose={() => {}}
          existing={{
            hostId: "studio",
            name: "studio",
            connection: { kind: "ssh", target: "greg@studio" },
          }}
        />
      );
      remoteHosts.probe!.mockResolvedValue(probeResult({ matchesClient: false }));
      fireEvent.click(screen.getByRole("button", { name: "Check host" }));
      fireEvent.click(await screen.findByRole("button", { name: "Plan update" }));
      fireEvent.click(await screen.findByRole("button", { name: "Update host" }));
      await screen.findByTestId("host-restart-impact");
      expect(screen.getAllByText("api: 1 terminal")).toHaveLength(2);
      expect(consoleError.mock.calls.some((call) => String(call[0]).includes("same key"))).toBe(
        false
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("dispatches nothing when the update confirmation is cancelled", async () => {
    render(
      <AddHostDialog
        isOpen
        onClose={() => {}}
        existing={{
          hostId: "studio",
          name: "studio",
          connection: { kind: "ssh", target: "greg@studio" },
        }}
      />
    );
    remoteHosts.probe!.mockResolvedValue(probeResult({ matchesClient: false }));
    fireEvent.click(screen.getByRole("button", { name: "Check host" }));
    fireEvent.click(await screen.findByRole("button", { name: "Plan update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update host" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update now…" }));
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
    fireEvent.change(screen.getByPlaceholderText("user@devbox.local"), {
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
    fireEvent.change(screen.getByPlaceholderText("user@devbox.local"), {
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
    expect(remoteHosts.startHostMode).toHaveBeenCalledWith({
      connection: { kind: "ssh", target: "greg@bigbox" },
    });

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

  it("tells a Mac host's terminals need Local Network approved there, and says nothing of it for Linux", async () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    try {
      const advise = async () => {
        render(<AddHostDialog isOpen onClose={() => {}} />);
        fireEvent.change(screen.getByPlaceholderText("user@devbox.local"), {
          target: { value: "greg@studio" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Check host" }));
        fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
        fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
        await screen.findByText("Keychain");
      };
      await advise();
      const copy = screen.getByText(/asks the same on its own screen/).textContent!;
      expect(copy).toContain("terminals and agents");
      expect(screen.queryByText(/find devices on your local network/)).toBeNull();
      cleanup();

      remoteHosts.probe!.mockResolvedValue(probeResult({ platform: "linux" }));
      await advise();
      expect(screen.queryByText("Local network")).toBeNull();
    } finally {
      platform.mockRestore();
    }
  });

  it("explains Local Network permission by routing, never promising tailnet hosts work", async () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    try {
      render(<AddHostDialog isOpen onClose={() => {}} />);
      fireEvent.change(screen.getByPlaceholderText("user@devbox.local"), {
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
