// @vitest-environment jsdom

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  DiscoveredHost,
  HostProbeResult,
  HostInstallPlan,
  RemoteHostsEvent,
} from "@shared/types/ipc/remoteHosts";
import type { CloudHostStatus, CloudHostsSnapshot } from "@shared/types/cloudHosts";
import type { HostListEntry } from "@shared/types/remoteHosts";
import { useRemoteHostsStore } from "@/store/remoteHostsStore";
import { _resetCloudHostsStateForTesting } from "@/components/Hosts/cloud/cloudHostsState";
import { provider as cloudProvider } from "@/components/Hosts/cloud/__tests__/cloudProviderFixtures";
import { AddHostDialog } from "../AddHostDialog";
import { ClientAppError } from "@/utils/clientAppError";

// Which kind of host this machine adds: ssh, or (a Windows Shell) WSL distros.
const connectionKind = vi.hoisted(() => ({ value: "ssh" as "ssh" | "wsl" }));
vi.mock("@/lib/remoteHosts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/remoteHosts")>()),
  remoteConnectionKind: () => connectionKind.value,
  // Cloud machines are followed only where a test hands the page a cloudHosts bridge.
  isRemoteShellSupported: () => true,
}));

// The key review itself is CloudHostKeyReview's; here it only needs to say the key was trusted.
vi.mock("../CloudHostKeyReview", () => ({
  CloudSetupHostKey: ({ onTrusted, note }: { onTrusted: () => void; note?: ReactNode }) => (
    <>
      <button onClick={onTrusted}>Trust this key</button>
      {note}
    </>
  ),
}));

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
    hostBuild: { version: "1.4.0", commit: "abcdef0", order: "same" },
    stagedUpdate: null,
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
  downgrade: false,
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
      assistantControlEnabled: false,
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
  connectionKind.value = "ssh";
});

async function walkToAddHost() {
  fireEvent.change(screen.getByPlaceholderText("user@devbox.local"), {
    target: { value: "greg@studio" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Check host" }));
  // Host mode was on there already: Continue goes past it to Connect, saving the host on the way.
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  await connectOnceSaved();
}

/** Connect, once the save on the way to it has settled and the button takes a press. */
async function connectOnceSaved() {
  const connect = await screen.findByRole("button", { name: "Connect" });
  await waitFor(() => expect(connect.getAttribute("aria-disabled")).toBeNull());
  fireEvent.click(connect);
}

/** The discovered machines' rows, in order. */
function discoveredRows(): HTMLElement[] {
  return [...screen.getByTestId("add-host-discovered").querySelectorAll("label")];
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

  it.each([
    ["Host key verification failed.", "Connect once", "ssh greg@studio"],
    [
      "Host key for studio has changed and you have requested strict checking.\nHost key verification failed.",
      "known_hosts line ssh named",
      "differs from the one on file",
    ],
    [
      "greg@studio: Permission denied (publickey,password).",
      "Set up key login",
      "ssh-copy-id greg@studio",
    ],
  ])("names the next step when ssh says %j", async (sshError, label, command) => {
    remoteHosts.probe!.mockResolvedValueOnce(
      probeResult({
        reachable: false,
        sshError,
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
    const guidance = await screen.findByTestId("add-host-ssh-refusal");
    expect(guidance.textContent).toContain(label);
    expect(guidance.textContent).toContain(command);
    expect(screen.queryByText(/turn on\s+Remote Login/)).toBeNull();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });

  it("offers a sign-in for a refused login, and checks again once ssh gets in", async () => {
    remoteHosts.probe!.mockResolvedValueOnce(
      probeResult({
        reachable: false,
        sshError: "greg@studio: Permission denied (publickey,keyboard-interactive).",
        platform: null,
        install: null,
        hostModeListening: false,
        matchesClient: null,
      })
    );
    let finish: (result: { status: "signed-in" }) => void = () => {};
    remoteHosts.startSshSignIn = vi.fn(
      () => new Promise<{ status: "signed-in" }>((resolve) => (finish = resolve))
    );
    remoteHosts.onSshSignInEvent = vi.fn(() => () => {});
    render(<AddHostDialog isOpen onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("user@devbox.local"), {
      target: { value: "greg@studio" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check host" }));
    const guidance = await screen.findByTestId("add-host-ssh-refusal");
    fireEvent.click(within(guidance).getByRole("button", { name: "Sign in…" }));
    await waitFor(() =>
      expect(remoteHosts.startSshSignIn).toHaveBeenCalledWith({
        attemptId: expect.any(String),
        connection: { kind: "ssh", target: "greg@studio" },
      })
    );
    expect(await screen.findByTestId("ssh-sign-in-dialog")).toBeTruthy();
    // The check runs again only once ssh is in.
    expect(remoteHosts.probe).toHaveBeenCalledTimes(1);
    await act(async () => finish({ status: "signed-in" }));
    await waitFor(() => expect(remoteHosts.probe).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("ssh-sign-in-dialog")).toBeNull());
  });

  it("shows a discovery failure with Retry rather than an empty scan", async () => {
    remoteHosts.discover!.mockRejectedValueOnce(new Error("tailscale crashed"));
    render(<AddHostDialog isOpen onClose={() => {}} />);
    expect(await screen.findByText("Couldn't look for machines")).toBeTruthy();
    expect(screen.getByText("tailscale crashed")).toBeTruthy();
    expect(screen.queryByText(/nothing answered/i)).toBeNull();

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
      source: "bonjour" as const,
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
    await screen.findByText("studio-10");
    const names = discoveredRows().map((row) => row.querySelector(".font-medium")!.textContent);
    expect(names).toEqual(["studio-2", "Studio-03", "studio-10", "studio-01"]);
  });

  it("names an alias from the SSH config as its source and picks it as written, unchecked", async () => {
    remoteHosts.discover!.mockResolvedValueOnce([
      {
        name: "build-box",
        connection: { kind: "ssh", target: "build-box" },
        source: "ssh-config",
        platform: null,
        online: false,
        alreadyAdded: false,
      },
    ]);
    render(<AddHostDialog isOpen onClose={() => {}} />);
    const row = await screen.findByRole("radio", { name: "build-box" });
    expect(discoveredRows()[0]!.textContent).toContain("SSH config");
    fireEvent.click(row);
    expect((screen.getByPlaceholderText("user@devbox.local") as HTMLInputElement).value).toBe(
      "build-box"
    );
    expect(remoteHosts.probe).not.toHaveBeenCalled();
    // ssh resolves the alias only now, as it would a typed one.
    fireEvent.click(screen.getByRole("button", { name: "Check host" }));
    await waitFor(() => expect(remoteHosts.probe).toHaveBeenCalledTimes(1));
    expect(remoteHosts.probe!.mock.calls[0]![0]).toEqual({
      connection: { kind: "ssh", target: "build-box" },
    });
  });

  describe("a large mesh", () => {
    function peer(
      name: string,
      overrides: Partial<DiscoveredHost> & { target?: string } = {}
    ): DiscoveredHost {
      const { target = `${name}.netbird.cloud`, ...rest } = overrides;
      return {
        name,
        connection: { kind: "ssh", target },
        source: "netbird",
        platform: null,
        online: true,
        netbirdStatus: "connected",
        alreadyAdded: false,
        ...rest,
      };
    }
    const idle = { online: false, netbirdStatus: "idle" } as const;
    const mesh = (count: number) =>
      Array.from({ length: count }, (_, i) => peer(`node-${i + 1}`, i % 2 ? idle : {}));
    const rowNames = () =>
      discoveredRows().map((row) => row.querySelector(".font-medium")!.textContent);
    const filter = () => screen.getByLabelText("Filter machines") as HTMLInputElement;
    const sshTarget = () => screen.getByPlaceholderText("user@devbox.local") as HTMLInputElement;

    it("puts connected peers ahead of idle ones, with added machines still last", async () => {
      remoteHosts.discover!.mockResolvedValueOnce([
        peer("lazy-2", idle),
        peer("added", { alreadyAdded: true }),
        peer("dev-vm"),
        peer("lab", { ...idle, knownMachine: true }),
        peer("connecting", { online: false, netbirdStatus: "connecting" }),
        peer("ci-10"),
        peer("ci-9"),
      ]);
      render(<AddHostDialog isOpen onClose={() => {}} />);
      await screen.findByText("dev-vm");
      expect(rowNames()).toEqual([
        "ci-9",
        "ci-10",
        "dev-vm",
        "connecting",
        "lab",
        "lazy-2",
        "added",
      ]);
    });

    it("says NetBird's own word for each peer, after Added and another account", async () => {
      remoteHosts.discover!.mockResolvedValueOnce([
        peer("dev-vm"),
        peer("lazy", idle),
        peer("unknown", { online: false, netbirdStatus: undefined }),
        peer("lab", { ...idle, knownMachine: true }),
        peer("added", { ...idle, alreadyAdded: true }),
      ]);
      render(<AddHostDialog isOpen onClose={() => {}} />);
      await screen.findByText("dev-vm");
      // Where each was found, then what's known of it: its membership and NetBird's own word.
      const routes = discoveredRows().map((row) =>
        [...row.querySelector('[id$="-route"]')!.children]
          .map((line) => line.textContent)
          .join(" / ")
      );
      expect(routes).toEqual([
        "NetBird",
        "NetBird / Added as another account · Idle",
        "NetBird / Idle",
        "NetBird",
        "NetBird / Added · Idle",
      ]);
    });

    it("offers a filter only past eight machines, and puts the keyboard in it", async () => {
      remoteHosts.discover!.mockResolvedValueOnce(mesh(8));
      const { unmount } = render(<AddHostDialog isOpen onClose={() => {}} />);
      await screen.findByText("node-1");
      expect(screen.queryByLabelText("Filter machines")).toBeNull();
      unmount();

      remoteHosts.discover!.mockResolvedValueOnce(mesh(9));
      render(<AddHostDialog isOpen onClose={() => {}} />);
      await screen.findByText("node-9");
      expect(document.activeElement).toBe(filter());
    });

    it("matches part of a name or an SSH target, in any case, and only from its own field", async () => {
      remoteHosts.discover!.mockResolvedValueOnce([
        ...mesh(8),
        peer("dev-vm", { target: "greg@dev-vm.corp.netbird.cloud" }),
        peer("10.0.0.7", { target: "10.0.0.7" }),
      ]);
      render(<AddHostDialog isOpen onClose={() => {}} />);
      await screen.findByText("dev-vm");

      fireEvent.change(filter(), { target: { value: "DEV" } });
      expect(rowNames()).toEqual(["dev-vm"]);
      fireEvent.change(filter(), { target: { value: "Corp.NetBird" } });
      expect(rowNames()).toEqual(["dev-vm"]);
      fireEvent.change(filter(), { target: { value: "GREG@" } });
      expect(rowNames()).toEqual(["dev-vm"]);
      fireEvent.change(filter(), { target: { value: "10.0.0" } });
      expect(rowNames()).toEqual(["10.0.0.7"]);
      fireEvent.change(filter(), { target: { value: "  " } });
      expect(rowNames()).toHaveLength(10);

      fireEvent.change(sshTarget(), { target: { value: "dev-vm" } });
      expect(rowNames()).toHaveLength(10);
    });

    it("keeps the filter when nothing matches, and points at the SSH target", async () => {
      remoteHosts.discover!.mockResolvedValueOnce(mesh(9));
      render(<AddHostDialog isOpen onClose={() => {}} />);
      await screen.findByText("node-9");
      fireEvent.change(filter(), { target: { value: " prod-db " } });
      expect(screen.queryByTestId("add-host-discovered")).toBeNull();
      expect(screen.getByRole("status").textContent).toBe(
        'No machines match "prod-db". Enter its SSH target above if it isn\'t listed.'
      );
      expect(filter().value).toBe(" prod-db ");
      fireEvent.keyDown(filter(), { key: "Enter" });
      expect(sshTarget().value).toBe("");
      expect(document.activeElement).toBe(filter());
    });

    it("picks the one machine left on Enter, without checking it", async () => {
      remoteHosts.discover!.mockResolvedValueOnce([...mesh(8), peer("dev-vm")]);
      render(<AddHostDialog isOpen onClose={() => {}} />);
      await screen.findByText("dev-vm");

      fireEvent.change(filter(), { target: { value: "node" } });
      fireEvent.keyDown(filter(), { key: "Enter" });
      expect(sshTarget().value).toBe("");

      fireEvent.change(filter(), { target: { value: "dev" } });
      fireEvent.keyDown(filter(), { key: "Enter", isComposing: true });
      expect(sshTarget().value).toBe("");
      fireEvent.keyDown(filter(), { key: "Enter" });
      expect(sshTarget().value).toBe("dev-vm.netbird.cloud");
      expect(screen.getByDisplayValue("dev-vm").tagName).toBe("INPUT");
      expect(document.activeElement).toBe(sshTarget());
      expect(remoteHosts.probe).not.toHaveBeenCalled();
    });

    it("won't swap the machine out from under a check in progress", async () => {
      let answer!: (result: HostProbeResult) => void;
      remoteHosts.probe!.mockReturnValueOnce(new Promise((r) => (answer = r)));
      remoteHosts.discover!.mockResolvedValueOnce([...mesh(8), peer("dev-vm")]);
      render(<AddHostDialog isOpen onClose={() => {}} />);
      await screen.findByText("dev-vm");
      fireEvent.click(screen.getByRole("radio", { name: /node-1\b/ }));
      fireEvent.click(screen.getByRole("button", { name: "Check host" }));
      fireEvent.change(filter(), { target: { value: "dev-vm" } });
      fireEvent.keyDown(filter(), { key: "Enter" });
      expect(sshTarget().value).toBe("node-1.netbird.cloud");
      expect(remoteHosts.probe).toHaveBeenCalledTimes(1);
      await act(async () => answer(probeResult()));
    });

    it("keeps the filter and the pick when coming back from the check", async () => {
      remoteHosts.discover!.mockResolvedValueOnce([...mesh(8), peer("dev-vm")]);
      render(<AddHostDialog isOpen onClose={() => {}} />);
      await screen.findByText("dev-vm");
      fireEvent.change(filter(), { target: { value: "dev" } });
      fireEvent.keyDown(filter(), { key: "Enter" });
      fireEvent.click(screen.getByRole("button", { name: "Check host" }));
      fireEvent.click(await screen.findByRole("button", { name: "Back" }));
      expect(filter().value).toBe("dev");
      expect(rowNames()).toEqual(["dev-vm"]);
      expect(sshTarget().value).toBe("dev-vm.netbird.cloud");
    });

    it("won't pick a machine that's already added", async () => {
      remoteHosts.discover!.mockResolvedValueOnce([
        ...mesh(8),
        peer("dev-vm", { alreadyAdded: true }),
      ]);
      render(<AddHostDialog isOpen onClose={() => {}} />);
      await screen.findByText("dev-vm");
      fireEvent.change(filter(), { target: { value: "dev-vm" } });
      fireEvent.keyDown(filter(), { key: "Enter" });
      expect(sshTarget().value).toBe("");
    });

    it("clears the filter on Escape before the dialog closes", async () => {
      const onClose = vi.fn();
      remoteHosts.discover!.mockResolvedValueOnce(mesh(9));
      render(<AddHostDialog isOpen onClose={onClose} />);
      await screen.findByText("node-9");
      fireEvent.change(filter(), { target: { value: "node-3" } });
      fireEvent.keyDown(filter(), { key: "Escape" });
      expect(filter().value).toBe("");
      expect(rowNames()).toHaveLength(9);
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.keyDown(filter(), { key: "Escape" });
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("takes the keyboard when a slow scan lands, unless a target is already being typed", async () => {
      let land!: (found: DiscoveredHost[]) => void;
      remoteHosts.discover!.mockReturnValueOnce(new Promise((r) => (land = r)));
      const first = render(<AddHostDialog isOpen onClose={() => {}} />);
      await waitFor(() => expect(document.activeElement).toBe(sshTarget()));
      await act(async () => land(mesh(9)));
      expect(document.activeElement).toBe(filter());
      first.unmount();

      remoteHosts.discover!.mockReturnValueOnce(new Promise((r) => (land = r)));
      render(<AddHostDialog isOpen onClose={() => {}} />);
      await waitFor(() => expect(document.activeElement).toBe(sshTarget()));
      fireEvent.change(sshTarget(), { target: { value: "greg@" } });
      await act(async () => land(mesh(9)));
      expect(filter()).toBeTruthy();
      expect(document.activeElement).toBe(sshTarget());
    });
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
    fireEvent.click(await screen.findByRole("button", { name: "Set up Host mode…" }));
    expect(await screen.findByRole("button", { name: "Turn on Host mode" })).toBeTruthy();
    // The saved record keeps its target: Back reaches the check, never Find.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("button", { name: "Set up Host mode…" })).toBeTruthy();
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
    fireEvent.click(await screen.findByRole("button", { name: "Set up Host mode…" }));
    // Skipping ends setup there: saved, with nothing after Host mode to walk through.
    fireEvent.click(await screen.findByRole("button", { name: "Skip Host mode" }));
    expect(await screen.findByText("studio is saved, not connected")).toBeTruthy();
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
    fireEvent.click(await screen.findByRole("button", { name: "Set up Host mode…" }));
    expect(remoteHosts.add).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Turn on Host mode" }));
    expect(await screen.findByText("studio is saved and ready to connect")).toBeTruthy();
    expect(remoteHosts.add).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();

    // Finishing reuses the record rather than adding a second.
    await connectOnceSaved();
    await waitFor(() => expect(remoteHosts.connect).toHaveBeenCalled());
    expect(remoteHosts.add).toHaveBeenCalledOnce();
  });

  it("on a machine with no systemd, says Host mode runs in the background and what that doesn't cover", async () => {
    const box = (overrides: Partial<HostProbeResult> = {}) =>
      probeResult({
        platform: "linux",
        arch: "x64",
        install: {
          path: "/home/node/Applications/Daintree.AppImage",
          version: "1.4.0",
          commit: "abcdef0",
          packaging: "appimage",
        },
        advice: { ...probeResult().advice, systemd: false, hostModeUnit: false },
        startsOnConnect: true,
        ...overrides,
      });
    remoteHosts.probe!.mockResolvedValue(box({ hostModeListening: false, hostModeState: null }));
    remoteHosts.startHostMode!.mockResolvedValueOnce({
      probe: box({
        hostModeState: {
          pid: 4242,
          enabled: true,
          startMethod: "on-connect",
          startAtLogin: false,
          startAtLoginInstalled: null,
          startAtLoginError: null,
          keychain: { state: "unknown", detail: "Not checked yet", checked: false },
        },
      }),
      lingerRefused: null,
    });
    render(<AddHostDialog isOpen onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("user@devbox.local"), {
      target: { value: "greg@studio" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check host" }));
    fireEvent.click(await screen.findByRole("button", { name: "Set up Host mode…" }));
    const before = await screen.findByText(
      /studio has no systemd, so there's no Host mode service/
    );
    expect(before.textContent).toContain("Connecting from Daintree starts it again.");
    expect(document.body.textContent).not.toContain("systemd user unit");
    fireEvent.click(screen.getByRole("button", { name: "Turn on Host mode" }));
    const after = await screen.findByText(/Host mode is on there and runs in the background/);
    expect(after.textContent).toContain(
      "doesn't come back by itself after the machine reboots, stops or is rebuilt"
    );
    expect(remoteHosts.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "studio", startsOnConnect: true })
    );
  });

  it("saves what turning Host mode on saw there, not the check before it", async () => {
    const box = probeResult({
      platform: "linux",
      arch: "x64",
      install: {
        path: "/home/node/Applications/Daintree.AppImage",
        version: "1.4.0",
        commit: "abcdef0",
        packaging: "appimage",
      },
      hostModeListening: false,
      hostModeState: null,
    });
    remoteHosts.probe!.mockResolvedValue(box);
    remoteHosts.startHostMode!.mockResolvedValueOnce({
      probe: {
        ...box,
        hostModeListening: true,
        advice: { ...box.advice, systemd: false },
        startsOnConnect: true,
        hostModeState: {
          pid: 4242,
          enabled: true,
          startMethod: "on-connect",
          startAtLogin: false,
          startAtLoginInstalled: null,
          startAtLoginError: null,
          keychain: { state: "unknown", detail: "Not checked yet", checked: false },
        },
      },
      lingerRefused: null,
    });
    render(<AddHostDialog isOpen onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("user@devbox.local"), {
      target: { value: "greg@studio" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check host" }));
    fireEvent.click(await screen.findByRole("button", { name: "Set up Host mode…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn on Host mode" }));
    await screen.findByText(/Host mode is on there and runs in the background/);
    expect(remoteHosts.add).toHaveBeenCalledWith(
      expect.objectContaining({ startsOnConnect: true })
    );
  });

  it("says a taken or reserved name, or an added target, before anything is checked", () => {
    useRemoteHostsStore.getState().setHosts([known("lab", "studio", "admin@lab.local")]);
    render(<AddHostDialog isOpen onClose={() => {}} />);
    const targetField = screen.getByPlaceholderText("user@devbox.local");
    fireEvent.change(targetField, { target: { value: "greg@studio" } });
    expect(document.body.textContent).toContain('Another host is already called "studio"');
    const check = () => screen.getByRole("button", { name: "Check host" });
    expect(check().getAttribute("aria-disabled")).toBe("true");

    // The name fills in from the target, as a value rather than a hint.
    fireEvent.change(screen.getByDisplayValue("studio"), { target: { value: "this mac" } });
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
    fireEvent.change(screen.getByDisplayValue("lab"), { target: { value: "Lab (greg)" } });
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
    fireEvent.click(await screen.findByRole("button", { name: "Set up Host mode…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn on Host mode" }));
    expect(
      screen.getByRole("button", { name: "Skip Host mode" }).getAttribute("aria-disabled")
    ).toBe("true");
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

  it("checks an existing host as it opens, titled for why it was opened", async () => {
    remoteHosts.probe!.mockResolvedValue(probeResult({ hostModeListening: false }));
    render(
      <AddHostDialog
        isOpen
        onClose={() => {}}
        existing={{
          hostId: "studio",
          name: "studio",
          connection: { kind: "ssh", target: "greg@studio" },
          intent: "setup",
        }}
      />
    );
    expect(screen.getByText("Set up studio")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check host" })).toBeNull();
    expect(await screen.findByRole("heading", { name: "Host mode is off on studio" })).toBeTruthy();
    expect(remoteHosts.probe).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Set up Host mode…" })).toBeTruthy();
  });

  it("asks before an update that ends the host's terminals, naming the host", async () => {
    remoteHosts.probe!.mockResolvedValue(probeResult({ matchesClient: false }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Review update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update studio" }));
    // What the restart ends, as the host listed it, before anything is changed.
    await screen.findByText("api: 3 terminals, 1 agent working, 1 waiting");
    expect(screen.getByRole("heading", { name: "Restart Daintree on studio?" })).toBeTruthy();
    expect(screen.getByText("1 operation still running")).toBeTruthy();
    expect(screen.getByText("Sessions from greg-air")).toBeTruthy();
    expect(remoteHosts.install).toHaveBeenCalledOnce();
    expect(remoteHosts.install).toHaveBeenLastCalledWith(
      expect.objectContaining({ whileWorking: "refuse" })
    );

    // The one decision: ending what runs is named for what it ends.
    fireEvent.click(screen.getByRole("button", { name: "Update and end 3 terminals" }));
    await waitFor(() => expect(remoteHosts.install).toHaveBeenCalledTimes(2));
    // The confirmed set travels with it, so anything new stops the restart.
    expect(remoteHosts.install).toHaveBeenLastCalledWith(
      expect.objectContaining({ whileWorking: "proceed", hostId: "studio", confirmed: IMPACT })
    );
  });

  it("waits for idle agents from the same decision", async () => {
    remoteHosts.probe!.mockResolvedValue(probeResult({ matchesClient: false }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Review update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update studio" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update when idle" }));
    await waitFor(() => expect(remoteHosts.install).toHaveBeenCalledTimes(2));
    expect(remoteHosts.install).toHaveBeenLastCalledWith(
      expect.objectContaining({ whileWorking: "wait-for-idle", confirmed: IMPACT })
    );
  });

  it("names the operations and Sessions an update ends when no terminals are running", async () => {
    const impact = {
      detail: { ...IMPACT.detail, projects: [], terminalIds: [] },
      agents: null,
    };
    remoteHosts.install!.mockResolvedValue({ status: "needs-confirmation", impact });
    remoteHosts.probe!.mockResolvedValue(probeResult({ matchesClient: false }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Review update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update studio" }));
    await screen.findByRole("heading", { name: "Restart Daintree on studio?" });
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
    remoteHosts.probe!.mockResolvedValue(probeResult({ matchesClient: false }));
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
      fireEvent.click(await screen.findByRole("button", { name: "Review update" }));
      fireEvent.click(await screen.findByRole("button", { name: "Update studio" }));
      await screen.findByTestId("host-restart-impact");
      expect(screen.getAllByText("api: 1 terminal")).toHaveLength(2);
      expect(consoleError.mock.calls.some((call) => String(call[0]).includes("same key"))).toBe(
        false
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  describe("with a worktree waiting on the setup (#17355)", () => {
    const EXISTING = {
      hostId: "studio",
      name: "studio",
      connection: { kind: "ssh" as const, target: "greg@studio" },
      intent: "setup" as const,
    };
    const PLACEMENT = {
      projectId: "proj-1",
      worktreeId: "/repo/wt/feature-x",
      worktreePath: "/repo/wt/feature-x",
      label: "feature-x",
      requestedAt: 1_000,
    };

    beforeEach(() => {
      const entry = known("studio", "studio", "greg@studio");
      entry.descriptor.pendingPlacement = PLACEMENT;
      useRemoteHostsStore.getState().setHosts([entry]);
      remoteHosts.update = vi.fn(async () => ({}));
      remoteHosts.probe!.mockResolvedValue(probeResult({ hostModeListening: false }));
    });

    it("names the worktree, and finishing connects so it can be placed", async () => {
      const onClose = vi.fn();
      render(<AddHostDialog isOpen onClose={onClose} existing={EXISTING} />);
      expect(screen.getByText("When setup finishes, feature-x opens on studio.")).toBeTruthy();

      fireEvent.click(await screen.findByRole("button", { name: "Set up Host mode…" }));
      fireEvent.click(await screen.findByRole("button", { name: "Turn on Host mode" }));
      const done = await screen.findByRole("button", { name: "Done" });
      await waitFor(() => expect(done.getAttribute("aria-disabled")).toBeNull());
      fireEvent.click(done);

      await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      expect(remoteHosts.connect).toHaveBeenCalledWith({ hostId: "studio" });
      expect(remoteHosts.update).not.toHaveBeenCalled();
    });

    it("connects from a host already set up, where it would otherwise only close", async () => {
      remoteHosts.probe!.mockResolvedValue(probeResult());
      const onClose = vi.fn();
      render(<AddHostDialog isOpen onClose={onClose} existing={EXISTING} />);
      fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
      await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      expect(remoteHosts.connect).toHaveBeenCalledWith({ hostId: "studio" });
    });

    it("records why setup stopped on the waiting worktree, once", async () => {
      remoteHosts.startHostMode!.mockRejectedValue(new Error("systemd refused the unit"));
      render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);

      fireEvent.click(await screen.findByRole("button", { name: "Set up Host mode…" }));
      fireEvent.click(await screen.findByRole("button", { name: "Turn on Host mode" }));

      await waitFor(() => expect(remoteHosts.update).toHaveBeenCalledOnce());
      expect(remoteHosts.update).toHaveBeenCalledWith({
        hostId: "studio",
        pendingPlacement: {
          ...PLACEMENT,
          failure: { message: expect.stringContaining("systemd refused"), at: expect.any(Number) },
        },
      });
      // The list now carries the failure: nothing is written again without another stop.
      const entry = known("studio", "studio", "greg@studio");
      entry.descriptor.pendingPlacement = {
        ...PLACEMENT,
        failure: { message: "systemd refused the unit", at: 2 },
      };
      act(() => useRemoteHostsStore.getState().setHosts([entry]));
      expect(remoteHosts.update).toHaveBeenCalledOnce();
    });

    it("records a failed install, but not one the person stopped", async () => {
      remoteHosts.probe!.mockResolvedValue(probeResult({ matchesClient: false }));
      remoteHosts.install!.mockRejectedValueOnce(
        new ClientAppError("CANCELLED", "stopped", "Stopped")
      );
      render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);
      fireEvent.click(await screen.findByRole("button", { name: "Review update" }));
      fireEvent.click(await screen.findByRole("button", { name: "Update studio" }));
      await waitFor(() => expect(remoteHosts.install).toHaveBeenCalledOnce());
      await act(async () => {});
      expect(remoteHosts.update).not.toHaveBeenCalled();

      cleanup();
      remoteHosts.install!.mockRejectedValueOnce(new Error("No space left on device"));
      render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);
      fireEvent.click(await screen.findByRole("button", { name: "Review update" }));
      fireEvent.click(await screen.findByRole("button", { name: "Update studio" }));
      await waitFor(() =>
        expect(remoteHosts.update).toHaveBeenCalledWith({
          hostId: "studio",
          pendingPlacement: expect.objectContaining({
            failure: { message: expect.stringContaining("No space left"), at: expect.any(Number) },
          }),
        })
      );
    });

    it("connects once an update has installed, where Done would otherwise only close", async () => {
      remoteHosts.probe!.mockResolvedValue(probeResult({ matchesClient: false }));
      remoteHosts.install!.mockResolvedValue({
        status: "installed",
        probe: probeResult(),
        reconnected: null,
      });
      const onClose = vi.fn();
      render(<AddHostDialog isOpen onClose={onClose} existing={EXISTING} />);
      fireEvent.click(await screen.findByRole("button", { name: "Review update" }));
      fireEvent.click(await screen.findByRole("button", { name: "Update studio" }));
      await screen.findByRole("heading", { name: /Updated studio to Daintree/ });
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      expect(remoteHosts.connect).toHaveBeenCalledWith({ hostId: "studio" });

      // Nothing waiting: Done closes as it always has.
      cleanup();
      act(() =>
        useRemoteHostsStore.getState().setHosts([known("studio", "studio", "greg@studio")])
      );
      remoteHosts.connect!.mockClear();
      const closeOnly = vi.fn();
      render(<AddHostDialog isOpen onClose={closeOnly} existing={EXISTING} />);
      fireEvent.click(await screen.findByRole("button", { name: "Review update" }));
      fireEvent.click(await screen.findByRole("button", { name: "Update studio" }));
      await screen.findByRole("heading", { name: /Updated studio to Daintree/ });
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(closeOnly).toHaveBeenCalledOnce();
      expect(remoteHosts.connect).not.toHaveBeenCalled();
    });

    it("records a connect that fails after the dialog has closed", async () => {
      remoteHosts.probe!.mockResolvedValue(probeResult());
      let answer!: (state: unknown) => void;
      remoteHosts.connect!.mockImplementation(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          })
      );
      const view = render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);
      fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
      await waitFor(() => expect(remoteHosts.connect).toHaveBeenCalled());
      view.unmount();

      await act(async () =>
        answer({ status: "unreachable", lastSeenAt: null, detail: "Connection refused" })
      );
      expect(remoteHosts.update).toHaveBeenCalledWith({
        hostId: "studio",
        pendingPlacement: expect.objectContaining({
          failure: { message: "Couldn't connect: Connection refused", at: expect.any(Number) },
        }),
      });
    });

    it("records a check that couldn't reach the host", async () => {
      remoteHosts.probe!.mockResolvedValue(
        probeResult({ reachable: false, sshError: "Connection timed out" })
      );
      render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);
      await waitFor(() =>
        expect(remoteHosts.update).toHaveBeenCalledWith({
          hostId: "studio",
          pendingPlacement: expect.objectContaining({
            failure: { message: "Connection timed out", at: expect.any(Number) },
          }),
        })
      );
    });
  });

  describe("a new cloud machine that can't be reached while it finishes setting up", () => {
    const EXISTING = {
      hostId: "droplet",
      name: "droplet",
      connection: { kind: "cloud" as const, bindingId: "cb_abcdefgh" },
      intent: "setup" as const,
    };
    const turnedAway = () =>
      probeResult({
        connection: EXISTING.connection,
        reachable: false,
        sshError: "Permission denied (publickey).",
      });
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("checks it again every 10 seconds until it answers, then stops", async () => {
      remoteHosts
        .probe!.mockResolvedValueOnce(turnedAway())
        .mockResolvedValueOnce(turnedAway())
        .mockResolvedValue(probeResult({ connection: EXISTING.connection }));
      render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);
      await advance(0);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("add-host-awaiting-login")).toBeTruthy();
      await advance(9_000);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(1);
      await advance(1_000);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(2);
      await advance(10_000);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(3);
      await advance(60_000);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(3);
      expect(screen.queryByTestId("add-host-awaiting-login")).toBeNull();
    });

    it("stops after ten minutes and says so; a trust checks at once and starts ten more", async () => {
      remoteHosts.probe!.mockImplementation(async () => turnedAway());
      render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);
      await advance(0);
      for (let i = 0; i < 70; i++) await advance(10_000);
      // The one on open and sixty more.
      expect(remoteHosts.probe).toHaveBeenCalledTimes(61);
      expect(screen.getByTestId("add-host-stopped-awaiting-login")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Trust this key" }));
      await advance(0);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(62);
      expect(screen.getByTestId("add-host-awaiting-login")).toBeTruthy();
      for (let i = 0; i < 70; i++) await advance(10_000);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(121);
    });

    it("leaves an ssh host being set up to the person", async () => {
      remoteHosts.probe!.mockResolvedValue(
        probeResult({ reachable: false, sshError: "Connection timed out" })
      );
      render(
        <AddHostDialog
          isOpen
          onClose={() => {}}
          existing={{
            hostId: "studio",
            name: "studio",
            connection: { kind: "ssh", target: "greg@studio" },
            intent: "setup",
          }}
        />
      );
      await advance(0);
      await advance(60_000);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(1);
    });

    it("leaves a host that isn't newly made to the person", async () => {
      remoteHosts.probe!.mockImplementation(async () => turnedAway());
      const notNew = {
        hostId: EXISTING.hostId,
        name: EXISTING.name,
        connection: EXISTING.connection,
      };
      render(<AddHostDialog isOpen onClose={() => {}} existing={notNew} />);
      await advance(0);
      await advance(60_000);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("add-host-awaiting-login")).toBeNull();
    });

    it("holds the check a trust asks for until a check already running has answered", async () => {
      let answer: (result: HostProbeResult) => void = () => {};
      remoteHosts
        .probe!.mockResolvedValueOnce(turnedAway())
        .mockImplementationOnce(() => new Promise<HostProbeResult>((resolve) => (answer = resolve)))
        .mockImplementation(async () => turnedAway());
      render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);
      await advance(0);
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await advance(0);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole("button", { name: "Trust this key" }));
      await advance(0);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(2);
      answer(turnedAway());
      // The answer lands, then the held check starts on the next turn.
      await advance(0);
      await advance(0);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(3);
    });

    it("drops the check a trust queued when the running check gets in", async () => {
      let answer: (result: HostProbeResult) => void = () => {};
      remoteHosts
        .probe!.mockResolvedValueOnce(turnedAway())
        .mockImplementationOnce(
          () => new Promise<HostProbeResult>((resolve) => (answer = resolve))
        );
      render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);
      await advance(0);
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await advance(0);
      fireEvent.click(screen.getByRole("button", { name: "Trust this key" }));
      answer(probeResult({ connection: EXISTING.connection }));
      await advance(60_000);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(2);
    });

    it("stops checking when the dialog closes", async () => {
      remoteHosts.probe!.mockImplementation(async () => turnedAway());
      const view = render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);
      await advance(0);
      view.rerender(<AddHostDialog isOpen={false} onClose={() => {}} existing={EXISTING} />);
      await advance(60_000);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(1);
    });
  });

  describe("a cloud machine that falls asleep or stops while it's being set up", () => {
    const HOST = {
      hostId: "a37",
      name: "a37",
      connection: { kind: "cloud" as const, bindingId: "cb_a37setup" },
      intent: "setup" as const,
    };
    const AGENT37 = cloudProvider({
      name: "Agent 37",
      stoppedComputeBilled: false,
      stoppedStorageBilled: true,
      lifetime: { kind: "idle-sleep", idleSeconds: 900 },
    });
    let cloud: CloudHostsSnapshot;
    let cloudHosts: Record<string, ReturnType<typeof vi.fn>>;

    const machine = (overrides: Partial<CloudHostStatus> = {}): CloudHostStatus => ({
      hostId: HOST.hostId,
      providerId: AGENT37.id,
      providerUnavailable: null,
      accountId: "ca_0123456789",
      accountName: "Personal",
      resourceId: "inst_a37setup",
      machineName: "a37",
      ownership: "created-by-daintree",
      createdFor: null,
      worktreeCleanup: null,
      provisioning: null,
      machine: "running",
      rawState: "running",
      machineType: "default",
      vcpu: 2,
      memoryGB: 4,
      hourlyDollars: 0.05,
      lifetime: { kind: "idle-sleep", idleSeconds: 900 },
      autoStopAt: null,
      lifetimeSeconds: null,
      stoppedAt: null,
      stop: null,
      lastSnapshotAt: null,
      dataExpired: false,
      operation: null,
      lastError: null,
      observedAt: Date.now(),
      lastEndpoint: null,
      hostKeyFingerprint: null,
      hostKeyReview: null,
      keptRunningAt: null,
      asleep: false,
      ...overrides,
    });
    const asleep = () => machine({ machine: "stopped", rawState: "sleeping", asleep: true });
    /** What the cloud picture reads from now on, without telling the page. */
    const becomes = (status: CloudHostStatus) => {
      cloud = { providers: [AGENT37], accounts: [], hosts: [status] };
    };
    /** The picture changes, as main pushes it. */
    const push = async (status: CloudHostStatus) => {
      becomes(status);
      await act(async () => {
        for (const listener of [...listeners]) listener({ type: "cloud-changed", snapshot: cloud });
      });
    };
    // What the cloud channel answers for a machine it won't dial.
    const refused = () =>
      probeResult({
        connection: HOST.connection,
        reachable: false,
        sshError: "The cloud machine is asleep. Start it to wake it and connect.",
        platform: null,
        install: null,
        hostModeListening: false,
        matchesClient: null,
      });
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    beforeEach(() => {
      vi.useFakeTimers();
      becomes(machine());
      cloudHosts = {
        getSnapshot: vi.fn(async () => cloud),
        startHost: vi.fn(async () => {}),
        refreshHost: vi.fn(async () => {}),
      };
      Object.defineProperty(window, "electron", {
        value: { remoteHosts, cloudHosts },
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      cleanup();
      _resetCloudHostsStateForTesting();
      vi.useRealTimers();
    });

    it.each(["its check answers", "the cloud picture changes"])(
      "offers to start a machine found asleep however %s first, and dials nothing meanwhile",
      async (first) => {
        let answer: (result: HostProbeResult) => void = () => {};
        remoteHosts.probe!.mockImplementationOnce(
          () => new Promise<HostProbeResult>((resolve) => (answer = resolve))
        );
        render(<AddHostDialog isOpen onClose={() => {}} existing={HOST} />);
        await advance(0);
        if (first === "its check answers") {
          answer(refused());
          await advance(0);
          await push(asleep());
        } else {
          await push(asleep());
          answer(refused());
          await advance(0);
        }
        const offer = screen.getByTestId("add-host-machine-down");
        expect(offer.textContent).toContain("a37's machine is asleep");
        expect(offer.textContent).toContain(
          "It bills Personal about $0.050 an hour while it runs. Agent 37 bills only for its disk while it's stopped or asleep."
        );
        expect(screen.getByRole("button", { name: "Start machine" })).toBeTruthy();
        expect(screen.queryByTestId("add-host-awaiting-login")).toBeNull();
        // A check would only be turned away, and waking it is the person's call.
        await advance(60_000);
        expect(remoteHosts.probe).toHaveBeenCalledTimes(1);
        expect(cloudHosts.startHost).not.toHaveBeenCalled();
      }
    );

    it("starts it when asked, and carries on from one fresh check once it runs", async () => {
      remoteHosts
        .probe!.mockResolvedValueOnce(refused())
        .mockResolvedValue(probeResult({ connection: HOST.connection }));
      let started: () => void = () => {};
      cloudHosts.startHost!.mockImplementation(
        () => new Promise<void>((resolve) => (started = resolve))
      );
      render(<AddHostDialog isOpen onClose={() => {}} existing={HOST} />);
      await advance(0);
      await push(asleep());
      fireEvent.click(screen.getByRole("button", { name: "Start machine" }));
      await advance(0);
      expect(cloudHosts.startHost).toHaveBeenCalledWith({ hostId: "a37" });
      await push(
        machine({
          machine: "starting",
          rawState: "waking",
          operation: { id: "op_1", kind: "starting", startedAt: Date.now(), stage: "Waking it" },
        })
      );
      expect(screen.getByTestId("add-host-machine-starting").textContent).toContain("Waking it");
      expect(screen.queryByRole("button", { name: "Start machine" })).toBeNull();
      await advance(60_000);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(1);

      // Its answer can come before the push that says it runs.
      becomes(machine());
      started();
      await advance(0);
      await advance(0);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId("add-host-machine-down")).toBeNull();
      expect(screen.queryByTestId("add-host-machine-starting")).toBeNull();
      expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
      await advance(60_000);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(2);
    });

    it("says why a start was refused, offers it again, and checks nothing", async () => {
      remoteHosts.probe!.mockResolvedValue(refused());
      cloudHosts.startHost!.mockRejectedValueOnce(
        new ClientAppError("INTERNAL", "start refused", "Agent 37 has no capacity right now.")
      );
      render(<AddHostDialog isOpen onClose={() => {}} existing={HOST} />);
      await advance(0);
      await push(asleep());
      fireEvent.click(screen.getByRole("button", { name: "Start machine" }));
      await advance(0);
      expect(screen.getByText("Agent 37 has no capacity right now.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Start machine" })).toBeTruthy();
      await advance(60_000);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(1);
    });

    it("puts the offer ahead of a reviewed install once the machine stops", async () => {
      remoteHosts.probe!.mockResolvedValue(
        probeResult({
          connection: HOST.connection,
          install: null,
          hostModeListening: false,
          appRunning: false,
          matchesClient: false,
        })
      );
      render(<AddHostDialog isOpen onClose={() => {}} existing={HOST} />);
      await advance(0);
      fireEvent.click(screen.getByRole("button", { name: "Review install" }));
      await advance(0);
      expect(remoteHosts.planInstall).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();

      await push(machine({ machine: "stopped", rawState: "stopped" }));
      expect(screen.getByTestId("add-host-machine-down").textContent).toContain(
        "a37's machine is stopped"
      );
      expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
      expect(screen.getByRole("button", { name: "Start machine" })).toBeTruthy();
      expect(remoteHosts.install).not.toHaveBeenCalled();
    });

    it("never follows the cloud for a host that isn't a cloud machine", async () => {
      remoteHosts.probe!.mockResolvedValue(probeResult());
      render(
        <AddHostDialog
          isOpen
          onClose={() => {}}
          existing={{
            hostId: "studio",
            name: "studio",
            connection: { kind: "ssh", target: "greg@studio" },
            intent: "setup",
          }}
        />
      );
      await advance(0);
      expect(remoteHosts.probe).toHaveBeenCalledTimes(1);
      expect(cloudHosts.getSnapshot).not.toHaveBeenCalled();
    });
  });

  describe("a host on another release", () => {
    const EXISTING = {
      hostId: "studio",
      name: "studio",
      connection: { kind: "ssh" as const, target: "greg@studio" },
    };
    const NEWER = probeResult({
      matchesClient: false,
      install: {
        path: "/Applications/Daintree.app",
        version: "1.5.0",
        commit: "fedcba9",
        packaging: "app-bundle",
      },
      hostBuild: { version: "1.5.0", commit: "fedcba9", order: "newer" },
    });

    it("says a host ahead of this machine is newer, and offers to update this machine", async () => {
      const checkForUpdates = vi.fn(async () => {});
      Object.assign(window.electron, { update: { checkForUpdates } });
      remoteHosts.probe!.mockResolvedValue(NEWER);
      render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);
      expect(
        await screen.findByRole("heading", { name: "studio is ahead of this machine" })
      ).toBeTruthy();
      expect(document.body.textContent).toContain("Daintree 1.5.0");
      expect(screen.queryByRole("button", { name: "Review update" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Update this machine" }));
      expect(checkForUpdates).toHaveBeenCalledOnce();
      // The press shows what this machine's updater is doing, and can't be repeated.
      expect(await screen.findByText("Checking for an update to this machine")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Update this machine" })).toBeNull();
      expect(remoteHosts.planInstall).not.toHaveBeenCalled();
      expect(remoteHosts.install).not.toHaveBeenCalled();
    });

    it("downgrades it from a plan that says so once, and confirms the restart as one", async () => {
      remoteHosts.probe!.mockResolvedValue(NEWER);
      remoteHosts.planInstall!.mockResolvedValue({ ...UPDATE_PLAN, downgrade: true });
      render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);
      fireEvent.click(await screen.findByRole("button", { name: "Downgrade studio…" }));
      await waitFor(() =>
        expect(remoteHosts.planInstall).toHaveBeenLastCalledWith(
          expect.objectContaining({ allowDowngrade: true })
        )
      );
      expect((await screen.findByTestId("add-host-downgrade")).textContent).toMatch(
        /This is a downgrade.*Daintree 1\.5\.0 saved on studio may not open in 1\.4\.0/
      );
      expect(screen.queryByRole("button", { name: "Update studio" })).toBeNull();
      expect(remoteHosts.install).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Downgrade studio" }));
      await waitFor(() => expect(remoteHosts.install).toHaveBeenCalledOnce());
      expect(remoteHosts.install).toHaveBeenLastCalledWith(
        expect.objectContaining({ allowDowngrade: true, whileWorking: "refuse" })
      );
      // The restart it needs is decided as any other, named as the downgrade it is.
      await screen.findByRole("heading", { name: "Restart Daintree on studio?" });
      expect(screen.getByText(/Downgrading restarts it/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Downgrade and end 3 terminals" }));
      await waitFor(() => expect(remoteHosts.install).toHaveBeenCalledTimes(2));
      expect(remoteHosts.install).toHaveBeenLastCalledWith(
        expect.objectContaining({ allowDowngrade: true, whileWorking: "proceed" })
      );
    });

    it("installs the update the host downloaded by restarting it, behind the same confirmation", async () => {
      remoteHosts.probe!.mockResolvedValue(
        probeResult({
          matchesClient: false,
          hostBuild: { version: "1.3.0", commit: "0123456", order: "older" },
          stagedUpdate: { version: "1.4.0", installsOnQuit: true, ready: true },
        })
      );
      render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);
      expect(await screen.findByText("Daintree 1.4.0")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Install downloaded update" }));
      await waitFor(() => expect(remoteHosts.install).toHaveBeenCalledOnce());
      expect(remoteHosts.install).toHaveBeenLastCalledWith(
        expect.objectContaining({ applyStaged: { version: "1.4.0" }, whileWorking: "refuse" })
      );
      expect(remoteHosts.planInstall).not.toHaveBeenCalled();
      await screen.findByText("api: 3 terminals, 1 agent working, 1 waiting");
      fireEvent.click(screen.getByRole("button", { name: "Update and end 3 terminals" }));
      await waitFor(() => expect(remoteHosts.install).toHaveBeenCalledTimes(2));
      expect(remoteHosts.install).toHaveBeenLastCalledWith(
        expect.objectContaining({
          applyStaged: { version: "1.4.0" },
          whileWorking: "proceed",
          confirmed: IMPACT,
        })
      );
    });

    it("offers to check again when installing the downloaded update fails", async () => {
      remoteHosts.probe!.mockResolvedValue(
        probeResult({
          matchesClient: false,
          hostBuild: { version: "1.3.0", commit: "0123456", order: "older" },
          stagedUpdate: { version: "1.4.0", installsOnQuit: true, ready: true },
        })
      );
      remoteHosts
        .install!.mockResolvedValueOnce({ status: "needs-confirmation", impact: IMPACT })
        .mockRejectedValueOnce(
          Object.assign(new Error("The host now has Daintree 1.4.1 downloaded"), {
            userMessage:
              "The host now has Daintree 1.4.1 downloaded, not 1.4.0. Check again to see it.",
          })
        );
      render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);
      fireEvent.click(await screen.findByRole("button", { name: "Install downloaded update" }));
      fireEvent.click(await screen.findByRole("button", { name: "Update and end 3 terminals" }));
      fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
      await waitFor(() => expect(remoteHosts.probe).toHaveBeenCalledTimes(2));
    });

    it("lets a plan refused for a newer host go on to the downgrade", async () => {
      remoteHosts.probe!.mockResolvedValue(probeResult({ matchesClient: false }));
      remoteHosts
        .planInstall!.mockResolvedValueOnce({
          ...UPDATE_PLAN,
          kind: "host-newer",
          delivery: null,
          packaging: null,
          restartsHost: false,
          reason: "The host has Daintree 1.5.0, which is newer than 1.4.0 here.",
        })
        .mockResolvedValueOnce({ ...UPDATE_PLAN, downgrade: true });
      render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);
      fireEvent.click(await screen.findByRole("button", { name: "Review update" }));
      expect(await screen.findByText(/newer than 1\.4\.0 here/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Update this machine" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Downgrade studio…" }));
      await waitFor(() =>
        expect(remoteHosts.planInstall).toHaveBeenLastCalledWith(
          expect.objectContaining({ allowDowngrade: true })
        )
      );
      expect(await screen.findByTestId("add-host-downgrade")).toBeTruthy();
    });

    it("offers to check again when a plan can't go ahead for something at the host", async () => {
      remoteHosts.probe!.mockResolvedValue(probeResult({ matchesClient: false }));
      remoteHosts.planInstall!.mockResolvedValueOnce({
        ...UPDATE_PLAN,
        kind: "unsupported",
        delivery: null,
        reason:
          "The host has downloaded Daintree 1.4.0, which installs when Daintree there restarts. Install that update first.",
      });
      render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);
      fireEvent.click(await screen.findByRole("button", { name: "Review update" }));
      fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
      await waitFor(() => expect(remoteHosts.probe).toHaveBeenCalledTimes(2));
    });

    it("waits while the host is still preparing its update", async () => {
      remoteHosts.probe!.mockResolvedValue(
        probeResult({
          matchesClient: false,
          hostBuild: { version: "1.3.0", commit: "0123456", order: "older" },
          stagedUpdate: { version: "1.4.0", installsOnQuit: true, ready: false },
        })
      );
      render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);
      expect(await screen.findByText("Daintree 1.4.0, still being prepared")).toBeTruthy();
      expect(
        screen.getByRole("heading", { name: "studio is still preparing an update" })
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Install downloaded update" })).toBeNull();
    });

    it("says a package update installs on the host's own screen, and updates from here as before", async () => {
      remoteHosts.probe!.mockResolvedValue(
        probeResult({
          matchesClient: false,
          hostBuild: { version: "1.3.0", commit: "0123456", order: "older" },
          stagedUpdate: { version: "1.4.0", installsOnQuit: false, ready: true },
        })
      );
      render(<AddHostDialog isOpen onClose={() => {}} existing={EXISTING} />);
      expect(await screen.findByText(/from Restart to update on its own screen/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Review update" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Install downloaded update" })).toBeNull();
    });
  });

  it("dispatches nothing when the restart decision is cancelled", async () => {
    const onClose = vi.fn();
    remoteHosts.probe!.mockResolvedValue(probeResult({ matchesClient: false }));
    render(
      <AddHostDialog
        isOpen
        onClose={onClose}
        existing={{
          hostId: "studio",
          name: "studio",
          connection: { kind: "ssh", target: "greg@studio" },
        }}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: "Review update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update studio" }));
    await screen.findByRole("heading", { name: "Restart Daintree on studio?" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
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
    fireEvent.click(await screen.findByRole("button", { name: "Set up Host mode…" }));

    expect(
      await screen.findByText(/listening on bigbox for now, but isn't switched on there/)
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on Host mode" }));
    // Switched on for good there: on to Connect, saved.
    expect(await screen.findByText("bigbox is saved and ready to connect")).toBeTruthy();
    expect(remoteHosts.startHostMode).toHaveBeenCalledWith({
      connection: { kind: "ssh", target: "greg@bigbox" },
    });

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
      const copy = (await screen.findByText(/find devices on your local network/)).textContent!;
      expect(copy).toContain("depends on how macOS routes to that host, not on its address");
      expect(copy).toContain("Privacy & Security → Local Network");
      expect(copy).not.toMatch(/either way/);
    } finally {
      platform.mockRestore();
    }
  });
});

describe("AddHostDialog for hosts without systemd", () => {
  it("lets an ssh Linux host already listening carry on, with or without systemd", async () => {
    remoteHosts.probe!.mockResolvedValueOnce(
      probeResult({
        connection: { kind: "ssh", target: "greg@devuan" },
        platform: "linux",
        hostModeListening: true,
        matchesClient: true,
        advice: { ...probeResult().advice, systemd: false },
      })
    );
    render(<AddHostDialog isOpen onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("user@devbox.local"), {
      target: { value: "greg@devuan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check host" }));
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.queryByTestId("add-host-no-systemd")).toBeNull();
  });
});

describe("AddHostDialog on Windows (WSL distros)", () => {
  const distro = (name: string, version: number, isDefault = false, alreadyAdded = false) => ({
    name,
    connection: { kind: "wsl" as const, distro: name },
    source: "wsl" as const,
    platform: "linux" as const,
    online: true,
    alreadyAdded,
    wsl: { version, isDefault },
  });

  beforeEach(() => {
    connectionKind.value = "wsl";
  });

  it("lists this PC's distros, default first, with no ssh field, and checks the one picked", async () => {
    remoteHosts.discover!.mockResolvedValueOnce([
      distro("archlinux", 2),
      distro("Legacy", 1),
      distro("Ubuntu-24.04", 2, true),
      distro("Debian", 2, false, true),
    ]);
    remoteHosts.probe!.mockResolvedValueOnce(
      probeResult({ connection: { kind: "wsl", distro: "Ubuntu-24.04" }, platform: "linux" })
    );
    render(<AddHostDialog isOpen onClose={() => {}} />);
    const list = await screen.findByTestId("add-host-wsl-distros");
    const names = [...list.querySelectorAll("li")].map(
      (row) => row.querySelector(".font-medium")?.textContent
    );
    expect(names).toEqual(["Ubuntu-24.04", "archlinux", "Legacy", "Debian"]);
    expect(screen.queryByPlaceholderText("user@devbox.local")).toBeNull();
    expect(screen.getByText("WSL 1 can't run Daintree")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Legacy/ }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect((screen.getByRole("button", { name: /Debian/ }) as HTMLButtonElement).disabled).toBe(
      true
    );

    const check = () => screen.getByRole("button", { name: "Check distribution" });
    expect(check().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Ubuntu-24\.04/ }));
    expect(check().getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(check());
    await waitFor(() =>
      expect(remoteHosts.probe).toHaveBeenCalledWith({
        connection: { kind: "wsl", distro: "Ubuntu-24.04" },
      })
    );
    expect(await screen.findByText("Starts")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ubuntu-24.04 is up to date" })).toBeTruthy();
  });

  it("lists every distro without a filter, however many there are", async () => {
    remoteHosts.discover!.mockResolvedValueOnce(
      Array.from({ length: 9 }, (_, i) => distro(`Distro-${i + 1}`, 2, i === 0))
    );
    render(<AddHostDialog isOpen onClose={() => {}} />);
    const list = await screen.findByTestId("add-host-wsl-distros");
    expect(list.querySelectorAll("li")).toHaveLength(9);
    expect(screen.queryByLabelText("Filter machines")).toBeNull();
  });

  it("advises on a distro's lifetime with this PC's Daintree, never on sleep or lingering", async () => {
    remoteHosts.discover!.mockResolvedValueOnce([distro("Debian", 2)]);
    remoteHosts.probe!.mockResolvedValue(
      probeResult({ connection: { kind: "wsl", distro: "Debian" }, platform: "linux" })
    );
    render(<AddHostDialog isOpen onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Debian/ }));
    fireEvent.click(screen.getByRole("button", { name: "Check distribution" }));
    // Host mode is on there already, so Continue lands on Connect.
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText("Host mode is on there and starts with the distribution.")
    ).toBeTruthy();
    await screen.findByText("Keychain");
    expect(screen.getByText("Running")).toBeTruthy();
    expect(
      screen.getByText(/WSL stops it about 15 seconds after nothing else is using it/)
    ).toBeTruthy();
    expect(screen.queryByText("Sleep")).toBeNull();
    expect(screen.queryByText(/sleeping host/)).toBeNull();
    expect(screen.queryByText(/Lingering|enable-linger/)).toBeNull();
  });

  it("stops at the check for a distro without systemd, and says how to turn it on", async () => {
    remoteHosts.discover!.mockResolvedValueOnce([distro("FedoraLinux-44", 2)]);
    remoteHosts.probe!.mockResolvedValue(
      probeResult({
        connection: { kind: "wsl", distro: "FedoraLinux-44" },
        platform: "linux",
        install: null,
        hostModeListening: false,
        matchesClient: false,
        advice: { ...probeResult().advice, systemd: false },
      })
    );
    render(<AddHostDialog isOpen onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /FedoraLinux-44/ }));
    fireEvent.click(screen.getByRole("button", { name: "Check distribution" }));
    expect(
      await screen.findByText(
        "FedoraLinux-44 runs without systemd, which Daintree's Host mode needs."
      )
    ).toBeTruthy();
    expect(screen.getByText("wsl --terminate FedoraLinux-44")).toBeTruthy();
    // Nothing installed: there's no build to compare with this machine's.
    expect(screen.queryByText("Matches this machine")).toBeNull();
    expect(screen.queryByRole("button", { name: "Plan install" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(remoteHosts.probe).toHaveBeenCalledTimes(2));
  });

  it("quotes a distro name with spaces in the commands it shows", async () => {
    remoteHosts.discover!.mockResolvedValueOnce([distro("Ubuntu 22.04 LTS", 2)]);
    remoteHosts.probe!.mockResolvedValue(
      probeResult({
        connection: { kind: "wsl", distro: "Ubuntu 22.04 LTS" },
        platform: "linux",
        install: null,
        hostModeListening: false,
        advice: { ...probeResult().advice, systemd: false },
      })
    );
    render(<AddHostDialog isOpen onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Ubuntu 22\.04 LTS/ }));
    fireEvent.click(screen.getByRole("button", { name: "Check distribution" }));
    expect(await screen.findByText('wsl --terminate "Ubuntu 22.04 LTS"')).toBeTruthy();
  });

  it("keeps an existing host's own kind, even on a machine that reaches hosts another way", async () => {
    // A WSL host's record carried to a Mac: its distro name must never be read as an ssh alias.
    connectionKind.value = "ssh";
    remoteHosts.probe!.mockResolvedValue(
      probeResult({ connection: { kind: "wsl", distro: "Ubuntu" }, platform: "linux" })
    );
    render(
      <AddHostDialog
        isOpen
        onClose={() => {}}
        existing={{
          hostId: "ubuntu",
          name: "Ubuntu",
          connection: { kind: "wsl", distro: "Ubuntu" },
        }}
      />
    );
    // Checked as it opens, as the distro it is.
    await waitFor(() =>
      expect(remoteHosts.probe).toHaveBeenCalledWith({
        connection: { kind: "wsl", distro: "Ubuntu" },
      })
    );
  });

  it("says how to install a distro when there is none, and looks again", async () => {
    remoteHosts.discover!.mockResolvedValueOnce([]);
    render(<AddHostDialog isOpen onClose={() => {}} />);
    expect(await screen.findByText(/No WSL distributions are installed/)).toBeTruthy();
    remoteHosts.discover!.mockResolvedValueOnce([distro("Ubuntu", 2, true)]);
    fireEvent.click(screen.getByRole("button", { name: "Look again" }));
    expect(await screen.findByRole("button", { name: /Ubuntu/ })).toBeTruthy();
  });
});
