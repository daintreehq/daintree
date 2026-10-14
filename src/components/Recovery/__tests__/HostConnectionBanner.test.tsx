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

  it("holds the reconnecting banner behind the 400ms gate", () => {
    vi.useFakeTimers();
    seed({ status: "connecting", attempt: 1 });
    const { container } = render(<HostConnectionBanner />);
    expect(container.firstChild).toBeNull();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByText("Connection to studio-01 lost. Reconnecting…")).toBeTruthy();
    expect(screen.getByText("Terminals are read-only until it reconnects.")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("never shows a blip that recovers inside the gate", () => {
    vi.useFakeTimers();
    seed({ status: "connecting", attempt: 1 });
    const { container } = render(<HostConnectionBanner />);
    act(() => {
      seed({ status: "connected", rttMs: 5, handshake: HANDSHAKE });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.firstChild).toBeNull();
  });

  it("says unreachable with when it was last seen, and retries on request", () => {
    const now = Date.now();
    seed(
      { status: "unreachable", lastSeenAt: now - 120_000, detail: "Connection refused" },
      { lastSeenAt: now - 120_000 }
    );
    render(<HostConnectionBanner />);
    expect(screen.getByRole("status").textContent).toContain(
      "studio-01 is unreachable · last seen 2 minutes ago"
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(connect).toHaveBeenCalledWith({ hostId: "studio-01" });
  });

  it("is never a live region: back-off swaps would be read out on every cycle", () => {
    seed({ status: "unreachable", lastSeenAt: null, detail: null });
    render(<HostConnectionBanner />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("off");
  });

  it("says Host mode is off and offers to set it up instead of Retry", () => {
    seed({ status: "unreachable", lastSeenAt: null, detail: null, hostModeOff: true });
    render(<HostConnectionBanner />);
    expect(screen.getByText("Daintree isn't running in Host mode on studio-01")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("button", { name: "Set up…" })).toBeTruthy();
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
