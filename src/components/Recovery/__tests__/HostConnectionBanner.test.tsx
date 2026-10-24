// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HostConnectionState } from "@shared/types/remoteHosts";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { HostConnectionBanner } from "../HostConnectionBanner";
import { getHostConnectionBannerCopy } from "../recoveryCopy";
import { useHostConnectionStore, type HostBannerVariant } from "@/store/hostConnectionStore";

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
    expect(screen.getByText("Connection to studio-01 lost. Reconnecting…")).toBeTruthy();
    expect(screen.getByText("Terminals are read-only until it reconnects.")).toBeTruthy();
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
    expect(screen.getByText("Connection to studio-01 lost. Reconnecting…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
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
    expect(screen.getByRole("button", { name: "Set up…" })).toBeTruthy();
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

  it("says ssh couldn't log in, in ssh's words, with Retry and the host's settings", () => {
    seed({
      status: "unreachable",
      lastSeenAt: null,
      detail: "Warning: something\ngreg@studio-01: Permission denied (publickey).",
      stoppedRetrying: true,
    });
    render(<HostConnectionBanner />);
    expect(screen.getByText("ssh couldn't log in to studio-01")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "ssh said: greg@studio-01: Permission denied (publickey)"
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settings…" })).toBeTruthy();
  });

  it("names a different build without an action", () => {
    seed({
      status: "version-mismatch",
      mismatch: { kind: "commit", local: "a", remote: "b" },
      remote: HANDSHAKE,
    });
    render(<HostConnectionBanner />);
    expect(screen.getByText("studio-01 runs a different build")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
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

describe("getHostConnectionBannerCopy", () => {
  const variants: HostBannerVariant[] = [
    "reconnecting",
    "restarting",
    "connecting",
    "unreachable",
    "host-mode-off",
    "access-denied",
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
    expect(copy.title).toBe("ssh couldn't log in to studio-01");
    expect(copy.description).toBe(
      "ssh said: Host key verification failed. Not retrying until you connect again."
    );
  });

  it("quotes the refusal itself when ssh trails it with a closed connection", () => {
    const detail =
      "greg@studio-01: Permission denied (publickey).\nConnection closed by UNKNOWN port 65535";
    expect(
      getHostConnectionBannerCopy("access-denied", "studio-01", null, 0, detail).description
    ).toBe(
      "ssh said: greg@studio-01: Permission denied (publickey). Not retrying until you connect again."
    );
  });

  it("drops the last-seen clause when nothing was ever seen", () => {
    expect(getHostConnectionBannerCopy("unreachable", "studio-01", null).title).toBe(
      "studio-01 is unreachable"
    );
  });
});
