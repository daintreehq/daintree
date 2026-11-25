// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HostConnectionState } from "@shared/types/remoteHosts";
import type { CloudHostStatus, CloudHostsSnapshot } from "@shared/types/cloudHosts";

const { cloud, startHost } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const cloud = {
    snapshot: { providers: [], accounts: [], hosts: [] } as CloudHostsSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** A `cloud-changed` push reaching this window. */
    push(snapshot: CloudHostsSnapshot) {
      cloud.snapshot = snapshot;
      for (const listener of [...listeners]) listener();
    },
  };
  return { cloud, startHost: vi.fn<(hostId: string) => Promise<void>>() };
});
vi.mock("@/components/Hosts/cloud/cloudHostsState", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal<typeof import("@/components/Hosts/cloud/cloudHostsState")>()),
    useCloudHosts: () => ({
      snapshot: useSyncExternalStore(cloud.subscribe, () => cloud.snapshot),
      loaded: true,
      loadError: null,
      refresh: () => Promise.resolve(),
    }),
  };
});
vi.mock("@/clients/cloudHostsClient", () => ({
  cloudHostsClient: { startHost, refreshHost: vi.fn(() => Promise.resolve()) },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { HostConnectionBanner } from "../HostConnectionBanner";
import { getHostConnectionBannerCopy } from "../recoveryCopy";
import { useHostConnectionStore, type HostBannerVariant } from "@/store/hostConnectionStore";
import { takePendingHostSettings } from "@/components/Settings/Hosts/hostSettingsRequests";
import { DELETE_ONLY_PROVIDER } from "@/components/Hosts/cloud/__tests__/cloudProviderFixtures";

const HANDSHAKE = {
  version: "1.0.0",
  commit: "abc",
  protocolVersion: 1,
  platform: "darwin",
  arch: "arm64",
} as const;

const connect = vi.fn(() => Promise.resolve({ status: "connecting", attempt: 1 }));

function seed(connection: HostConnectionState | null, extra: Record<string, unknown> = {}) {
  useHostConnectionStore.setState({
    hostId: "studio-01",
    hostName: "studio-01",
    connection,
    everConnected: true,
    lastSeenAt: null,
    checking: 0,
    ...extra,
  });
}

/** The severity the banner's glyph (or the spinner in its place) is coloured with. */
function glyphSeverity(container: HTMLElement): string | null {
  const style = container.querySelector('[style*="--color-status-"]')?.getAttribute("style") ?? "";
  return /--color-status-(\w+)/.exec(style)?.[1] ?? null;
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

beforeEach(() => {
  cleanup();
  connect.mockClear();
  startHost.mockReset();
  cloud.snapshot = { providers: [], accounts: [], hosts: [] };
  useHostConnectionStore.getState().reset();
  Object.defineProperty(window, "electron", {
    value: { remoteHosts: { connect } },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HostConnectionBanner", () => {
  it("renders nothing in a window that runs on this machine", () => {
    useHostConnectionStore.setState({
      hostId: null,
      connection: { status: "unreachable", lastSeenAt: 1, detail: null },
    });
    const { container } = render(<HostConnectionBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing while the link is up", () => {
    seed({ status: "connected", rttMs: 20, handshake: HANDSHAKE });
    const { container } = render(<HostConnectionBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("holds a lost link's banner until the drop outlasts the settle window", () => {
    vi.useFakeTimers();
    seed({ status: "connecting", attempt: 1 });
    const { container } = render(<HostConnectionBanner />);
    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(container.firstChild).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText(/^Lost connection to studio-01/)).toBeTruthy();
    expect(
      screen.getByText("Reconnecting on its own. Terminals are read-only until it's back.")
    ).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
    // Stalled past the window: a way to try now rather than wait for the next dial.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(connect).toHaveBeenCalledWith({ hostId: "studio-01", restart: true });
  });

  it("shows a stalled drop at the settle deadline from when it went down, however often it backs off", () => {
    vi.useFakeTimers();
    seed({ status: "connecting", attempt: 1 });
    const { container } = render(<HostConnectionBanner />);
    for (let attempt = 2; attempt < 9; attempt++) {
      act(() => {
        seed({ status: "unreachable", lastSeenAt: null, detail: "Connection refused" });
      });
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      act(() => {
        seed({ status: "connecting", attempt });
      });
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
    }
    // 28 s down, through seven back-off swaps.
    expect(container.firstChild).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByText(/^Lost connection to studio-01/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    // Stalled past the settle window: an error with its recovery, like unreachable.
    expect(glyphSeverity(container)).toBe("error");
  });

  it("never shows a drop that recovers inside the settle window, however often it backs off", () => {
    vi.useFakeTimers();
    seed({ status: "connecting", attempt: 1 });
    const { container } = render(<HostConnectionBanner />);
    for (let attempt = 2; attempt < 6; attempt++) {
      act(() => {
        seed({ status: "unreachable", lastSeenAt: null, detail: "Connection refused" });
      });
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      act(() => {
        seed({ status: "connecting", attempt });
      });
      expect(container.firstChild).toBeNull();
    }
    act(() => {
      seed({ status: "connected", rttMs: 5, handshake: HANDSHAKE });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(container.firstChild).toBeNull();
  });

  it("shows a first connect behind only the 400ms gate", () => {
    vi.useFakeTimers();
    seed({ status: "connecting", attempt: 1 }, { everConnected: false });
    const { container } = render(<HostConnectionBanner />);
    expect(container.firstChild).toBeNull();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByText("Connecting to studio-01…")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("holds one calm restarting banner through a host's announced restart", () => {
    vi.useFakeTimers();
    seed({ status: "connecting", attempt: 1, restarting: true });
    const { container } = render(<HostConnectionBanner />);
    const titles = new Set<string>();
    for (let attempt = 2; attempt < 40; attempt++) {
      act(() => {
        seed({
          status: "unreachable",
          lastSeenAt: null,
          detail: "Daintree isn't running in Host mode there (no host.json).",
          restarting: true,
        });
      });
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      if (container.textContent) titles.add(container.textContent);
      act(() => {
        seed({ status: "connecting", attempt, restarting: true });
      });
      if (container.textContent) titles.add(container.textContent);
    }
    expect([...titles].every((text) => text.includes("studio-01 is restarting…"))).toBe(true);
    expect(titles.size).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/lost|unreachable/);
    // Calm: the host's own word that it is coming back.
    expect(glyphSeverity(container)).toBe("warning");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(connect).toHaveBeenCalledWith({ hostId: "studio-01", restart: true });
  });

  it("holds a restart behind the settle window like any other drop", () => {
    vi.useFakeTimers();
    seed({ status: "connecting", attempt: 1, restarting: true });
    const { container } = render(<HostConnectionBanner />);
    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(container.firstChild).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText("studio-01 is restarting…")).toBeTruthy();
  });

  it("says unreachable with when it was last seen, and retries on request", () => {
    const now = Date.now();
    seed(
      { status: "unreachable", lastSeenAt: now - 120_000, detail: "Connection refused" },
      { lastSeenAt: now - 120_000, everConnected: false }
    );
    render(<HostConnectionBanner />);
    expect(screen.getByRole("status").textContent).toContain(
      "studio-01 is unreachable · last seen 2 minutes ago"
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    // Starts over even when an attempt is stuck, rather than waiting it out.
    expect(connect).toHaveBeenCalledWith({ hostId: "studio-01", restart: true });
  });

  it("is never a live region: back-off swaps would be read out on every cycle", () => {
    seed({ status: "unreachable", lastSeenAt: null, detail: null }, { everConnected: false });
    render(<HostConnectionBanner />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("off");
  });

  it("says Daintree isn't listening on the host, offering Retry beside setting it up", () => {
    seed({ status: "unreachable", lastSeenAt: null, detail: null, hostModeOff: true });
    render(<HostConnectionBanner />);
    expect(screen.getByText("Daintree isn't listening on studio-01")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "This window reconnects once Daintree is running there again."
    );
    // Not a prompt to install: the host may well be set up and on its way back.
    expect(screen.getByRole("status").textContent).not.toContain("set up there");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(connect).toHaveBeenCalledWith({ hostId: "studio-01", restart: true });
    expect(screen.getByRole("button", { name: "Set up Host mode…" })).toBeTruthy();
  });

  it("keeps counting how long ago a host whose Daintree isn't listening was last seen", () => {
    vi.useFakeTimers();
    try {
      const start = Date.UTC(2026, 9, 22, 12);
      vi.setSystemTime(start);
      seed(
        { status: "unreachable", lastSeenAt: start - 60_000, detail: null, hostModeOff: true },
        { lastSeenAt: start - 60_000 }
      );
      render(<HostConnectionBanner />);
      expect(
        screen.getByText("Daintree isn't listening on studio-01 · last seen 1 minute ago")
      ).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(4 * 60_000);
      });
      expect(
        screen.getByText("Daintree isn't listening on studio-01 · last seen 5 minutes ago")
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says ssh couldn't log in, with ssh's words beneath, Retry and the host's details", () => {
    seed({
      status: "unreachable",
      lastSeenAt: null,
      detail: "Warning: something\ngreg@studio-01: Permission denied (publickey).",
      stoppedRetrying: true,
      blocker: { kind: "ssh-access" },
    });
    render(<HostConnectionBanner />);
    expect(screen.getByText("Couldn't log in to studio-01 over ssh")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "ssh: greg@studio-01: Permission denied (publickey)"
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Host details…" })).toBeTruthy();
  });

  it("names a WSL distribution that's gone, without a word about ssh, and offers Retry", () => {
    seed({
      status: "unreachable",
      lastSeenAt: null,
      detail:
        "There is no distribution with the supplied name.\nWsl/Service/WSL_E_DISTRO_NOT_FOUND",
      stoppedRetrying: true,
      blocker: { kind: "wsl-distro-missing", distro: "Ubuntu-24.04" },
    });
    render(<HostConnectionBanner />);
    const banner = screen.getByRole("status");
    expect(screen.getByText("WSL couldn't find Ubuntu-24.04 for studio-01")).toBeTruthy();
    expect(banner.textContent).toContain("Restore it under that name in WSL, then retry.");
    expect(banner.textContent?.toLowerCase()).not.toMatch(/ssh|log ?in/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(connect).toHaveBeenCalledWith({ hostId: "studio-01", restart: true });
    expect(screen.getByRole("button", { name: "Host details…" })).toBeTruthy();
  });

  it.each([
    ["a missing WSL distribution", { kind: "wsl-distro-missing", distro: "Ubuntu-24.04" }],
    ["an unusable connection", { kind: "unusable", message: "WSL isn't available on this PC" }],
  ] as const)("opens the host's details from %s", (_what, blocker) => {
    seed({ status: "unreachable", lastSeenAt: null, detail: null, stoppedRetrying: true, blocker });
    render(<HostConnectionBanner />);
    const opened = vi.fn();
    window.addEventListener("daintree:open-settings-tab", opened);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Host details…" }));
    } finally {
      window.removeEventListener("daintree:open-settings-tab", opened);
    }
    expect(takePendingHostSettings()).toEqual({ kind: "detail", hostId: "studio-01" });
    const event: unknown = opened.mock.calls[0]?.[0];
    expect(event instanceof CustomEvent && event.detail).toEqual({ tab: "hosts" });
  });

  it("says only that retries stopped when an unusable connection gave no words", () => {
    const copy = getHostConnectionBannerCopy(
      "connection-unavailable",
      "studio-01",
      null,
      0,
      null,
      null,
      { kind: "unusable", message: "   " }
    );
    expect(copy.description).toBe(
      "Automatic retries have stopped. Terminals are read-only until it connects."
    );
  });

  it("says a connection that can't be used in the transport's words", () => {
    seed({
      status: "unreachable",
      lastSeenAt: null,
      detail: "spawn wsl.exe ENOENT",
      stoppedRetrying: true,
      blocker: { kind: "unusable", message: "WSL isn't available on this PC" },
    });
    render(<HostConnectionBanner />);
    expect(screen.getByText("Couldn't connect to studio-01")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "WSL isn't available on this PC. Automatic retries have stopped."
    );
    expect(screen.getByRole("status").textContent).not.toContain("ssh");
  });

  it("says which build is behind and offers updating that side", () => {
    seed({
      status: "version-mismatch",
      mismatch: { kind: "version", local: "0.47.0", remote: "0.48.1" },
      remote: HANDSHAKE,
    });
    const { unmount } = render(<HostConnectionBanner />);
    expect(screen.getByText(/^This machine runs an older version of Daintree/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update this machine" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    unmount();

    seed({
      status: "version-mismatch",
      mismatch: { kind: "version", local: "0.48.1", remote: "0.47.0" },
      remote: HANDSHAKE,
    });
    render(<HostConnectionBanner />);
    expect(screen.getByText("studio-01 runs an older version of Daintree")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update studio-01" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("rechecks a host updated outside this window and lets the obsolete mismatch go once it connects", () => {
    const behind = {
      status: "version-mismatch",
      mismatch: { kind: "protocol", local: 5, remote: 4 },
      remote: { ...HANDSHAKE, protocolVersion: 4 },
    } as const;
    seed(behind);
    const { container } = render(<HostConnectionBanner />);
    expect(screen.getByRole("button", { name: "Update studio-01" })).toBeTruthy();
    // A fresh handshake, not another installation.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(connect).toHaveBeenCalledWith({ hostId: "studio-01", restart: true });

    // The dial leaves the mismatch; still behind, the same answer comes back,
    // and so does the way to recheck it.
    act(() => {
      seed({ status: "connecting", attempt: 1 });
    });
    // Held behind the settle window like any other drop.
    expect(container.firstChild).toBeNull();
    act(() => {
      seed(behind);
    });
    expect(screen.getByText("studio-01 runs an older version of Daintree")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    act(() => {
      seed({ status: "connected", rttMs: 20, handshake: { ...HANDSHAKE, protocolVersion: 5 } });
    });
    expect(container.firstChild).toBeNull();
  });

  it("rechecks when this machine is the one behind too: the host may have been rolled back", () => {
    seed({
      status: "version-mismatch",
      mismatch: { kind: "protocol", local: 4, remote: 5 },
      remote: { ...HANDSHAKE, protocolVersion: 5 },
    });
    render(<HostConnectionBanner />);
    expect(screen.getByRole("button", { name: "Update this machine" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(connect).toHaveBeenCalledWith({ hostId: "studio-01", restart: true });
  });

  it("calls builds a commit apart different, not older, and still offers the update", () => {
    seed({
      status: "version-mismatch",
      mismatch: { kind: "commit", local: "a", remote: "b" },
      remote: { ...HANDSHAKE, commit: "b" },
    });
    render(<HostConnectionBanner />);
    expect(screen.getByText("studio-01 runs a different build of Daintree")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update studio-01" })).toBeTruthy();
    // The host may already have been rebuilt to match.
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("says it is checking with the host while an unanswered mutation is resolved", () => {
    vi.useFakeTimers();
    seed({ status: "connected", rttMs: 5, handshake: HANDSHAKE }, { checking: 1 });
    render(<HostConnectionBanner />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByText("Checking with studio-01…")).toBeTruthy();
  });
});

function machine(overrides: Partial<CloudHostStatus> = {}): CloudHostsSnapshot {
  return {
    providers: [],
    accounts: [],
    hosts: [
      {
        hostId: "studio-01",
        providerId: "boat",
        providerUnavailable: null,
        accountId: "ca_0123456789",
        accountName: "Personal",
        resourceId: "bx_23456789",
        machineName: "studio-01",
        ownership: "created-by-daintree",
        createdFor: null,
        worktreeCleanup: null,
        provisioning: null,
        machine: "stopped",
        rawState: "stopped",
        machineType: "default",
        vcpu: 4,
        memoryGB: 8,
        hourlyDollars: 0.036,
        lifetime: { kind: "renewable" },
        autoStopAt: null,
        lifetimeSeconds: 7200,
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
      },
    ],
  };
}

const STARTING = {
  id: "op-1",
  kind: "starting",
  startedAt: 0,
  stage: "Starting the machine",
} as const;

describe("HostConnectionBanner on a stopped cloud machine (#17546)", () => {
  /** A press on Start, with the start's reply held until the test lets it go. */
  function pressStart(): () => Promise<void> {
    let reply!: () => void;
    startHost.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        reply = resolve;
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Start and reconnect" }));
    expect(startHost).toHaveBeenCalledExactlyOnceWith("studio-01");
    return async () => {
      await act(async () => {
        reply();
        await Promise.resolve();
      });
    };
  }

  /** The provider's running observation, which the start waits for, reaching this window. */
  function observeRunning() {
    act(() => cloud.push(machine({ machine: "running", operation: STARTING })));
  }

  /** The dial is under way, its ssh handshake not yet answered. */
  function dialUnderWay() {
    act(() => seed({ status: "connecting", attempt: 1 }, { everConnected: false }));
  }

  beforeEach(() => {
    seed({ status: "disconnected" }, { everConnected: false });
    cloud.snapshot = machine();
  });

  // Each asks for the link once and neither starts it over: the second finds
  // the first's dial under way and leaves it to finish (LinkClient.retryNow).
  const ASKED_WITHOUT_RESTART = [[{ hostId: "studio-01" }], [{ hostId: "studio-01" }]];

  it("asks for the link from both, never starting it over, when the running push lands before the start's reply", async () => {
    render(<HostConnectionBanner />);
    const reply = pressStart();
    observeRunning();
    expect(connect).toHaveBeenCalledExactlyOnceWith({ hostId: "studio-01" });
    dialUnderWay();
    await reply();
    act(() => cloud.push(machine({ machine: "running" })));
    expect(connect.mock.calls).toEqual(ASKED_WITHOUT_RESTART);
  });

  it("asks for the link from both, never starting it over, when the start's reply lands before the running push", async () => {
    render(<HostConnectionBanner />);
    const reply = pressStart();
    await reply();
    expect(connect).toHaveBeenCalledExactlyOnceWith({ hostId: "studio-01" });
    dialUnderWay();
    observeRunning();
    act(() => cloud.push(machine({ machine: "running" })));
    expect(connect.mock.calls).toEqual(ASKED_WITHOUT_RESTART);
  });

  it("dials a window waiting on a machine started elsewhere, without abandoning a dial under way", () => {
    render(<HostConnectionBanner />);
    act(() => cloud.push(machine({ operation: STARTING })));
    expect(connect).not.toHaveBeenCalled();
    observeRunning();
    expect(connect).toHaveBeenCalledExactlyOnceWith({ hostId: "studio-01" });
    dialUnderWay();
    act(() => cloud.push(machine({ machine: "running" })));
    expect(connect).toHaveBeenCalledOnce();
  });

  it("asks a window already dialling for the link again when a machine started elsewhere comes up", () => {
    render(<HostConnectionBanner />);
    dialUnderWay();
    act(() => cloud.push(machine({ machine: "running" })));
    expect(connect).toHaveBeenCalledExactlyOnceWith({ hostId: "studio-01" });
  });

  it("dials neither the host it left nor the one it moved to for a start made before the move", async () => {
    render(<HostConnectionBanner />);
    const reply = pressStart();
    // Moved to another cloud host whose machine is already running: not a machine coming up.
    act(() => {
      seed({ status: "disconnected" }, { hostId: "mini", hostName: "mini", everConnected: false });
      const [left] = machine().hosts;
      const [movedTo] = machine({ hostId: "mini", machine: "running" }).hosts;
      cloud.push({ providers: [], accounts: [], hosts: [left!, movedTo!] });
    });
    await reply();
    expect(connect).not.toHaveBeenCalled();
  });

  it("leaves a link that came back by itself alone", () => {
    render(<HostConnectionBanner />);
    act(() => seed({ status: "connected", rttMs: 20, handshake: HANDSHAKE }));
    observeRunning();
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("getHostConnectionBannerCopy", () => {
  const variants: HostBannerVariant[] = [
    "reconnecting",
    "restarting",
    "connecting",
    "unreachable",
    "host-mode-off",
    "access-denied",
    "wsl-distro-missing",
    "connection-unavailable",
    "version-mismatch",
    "disconnected",
    "checking",
  ];

  it("never guesses a cause", () => {
    // access-denied is ssh's own report that it couldn't log in: observed, not guessed.
    for (const variant of variants.filter((candidate) => candidate !== "access-denied")) {
      for (const lastSeen of [null, Date.now() - 60_000]) {
        const { title, description } = getHostConnectionBannerCopy(variant, "studio-01", lastSeen);
        const text = `${title} ${description}`.toLowerCase();
        expect(text).not.toMatch(/asleep|sleep|log ?in|password|offline|network|wi-?fi|crash/);
      }
    }
  });

  it("quotes the last line of what ssh said, past its warning box", () => {
    const detail = [
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
      "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
      "Offending ED25519 key in /Users/greg/.ssh/known_hosts:12",
      "Host key verification failed.",
      "",
    ].join("\n");
    const copy = getHostConnectionBannerCopy("access-denied", "studio-01", null, 0, detail);
    expect(copy.title).toBe("Couldn't log in to studio-01 over ssh");
    expect(copy.contextLine).toBe("ssh: Host key verification failed");
  });

  it("quotes the refusal itself when ssh trails it with a closed connection", () => {
    const detail =
      "greg@studio-01: Permission denied (publickey).\nConnection closed by UNKNOWN port 65535";
    expect(
      getHostConnectionBannerCopy("access-denied", "studio-01", null, 0, detail).contextLine
    ).toBe("ssh: greg@studio-01: Permission denied (publickey)");
  });

  it("drops the last-seen clause when nothing was ever seen", () => {
    expect(getHostConnectionBannerCopy("unreachable", "studio-01", null).title).toBe(
      "studio-01 is unreachable"
    );
  });
});

describe("HostConnectionBanner on a machine whose provider has no stop (#18229)", () => {
  const leasy = (overrides: Partial<CloudHostStatus> = {}): CloudHostsSnapshot => {
    const snapshot = machine({
      providerId: DELETE_ONLY_PROVIDER.id,
      lifetime: { kind: "none" },
      lifetimeSeconds: null,
      ...overrides,
    });
    return { ...snapshot, providers: [DELETE_ONLY_PROVIDER] };
  };

  beforeEach(() => seed({ status: "disconnected" }, { everConnected: false }));

  it("offers no start-and-reconnect, nor what a start would cost, for one reported stopped or in error", () => {
    for (const state of ["stopped", "error"] as const) {
      cloud.snapshot = leasy({ machine: state });
      render(<HostConnectionBanner />);
      expect(screen.queryByRole("button", { name: "Start and reconnect" })).toBeNull();
      expect(document.body.textContent).not.toMatch(/Start it to work here again|while it runs/);
      cleanup();
    }
    expect(startHost).not.toHaveBeenCalled();
  });

  it("still offers to check one whose state is unknown", () => {
    cloud.snapshot = leasy({ machine: "unknown" });
    render(<HostConnectionBanner />);
    expect(screen.getByRole("button", { name: "Check status" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start and reconnect" })).toBeNull();
  });
});
