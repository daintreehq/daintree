// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostConnectionState } from "@shared/types/remoteHosts";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import {
  _resetHostConnectionAnnouncementsForTesting,
  hostLinkAnnouncement,
  hostLinkEpisode,
  watchHostConnectionAnnouncements,
} from "../hostConnectionAnnouncements";

const HANDSHAKE = {
  version: "1.0.0",
  commit: "abc",
  protocolVersion: 1,
  platform: "darwin",
  arch: "arm64",
} as const;

const CONNECTED: HostConnectionState = { status: "connected", rttMs: 5, handshake: HANDSHAKE };
const RECONNECTING: HostConnectionState = { status: "connecting", attempt: 2 };
const UNREACHABLE: HostConnectionState = { status: "unreachable", lastSeenAt: 1, detail: null };

function link(connection: HostConnectionState) {
  useHostConnectionStore.setState({ connection });
}

function spoken(): string[] {
  return announce.mock.calls.map(([message]) => message as string);
}

const announce = vi.fn();
const realAnnounce = useAnnouncerStore.getState().announce;
let stop: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  announce.mockReset();
  _resetHostConnectionAnnouncementsForTesting();
  useAnnouncerStore.setState({ announce });
  useHostConnectionStore.getState().reset();
  useHostConnectionStore.setState({
    hostId: "studio-01",
    hostName: "studio-01",
    connection: CONNECTED,
    everConnected: true,
    checking: 0,
  });
});

afterEach(() => {
  stop?.();
  stop = null;
  useAnnouncerStore.setState({ announce: realAnnounce });
  useHostConnectionStore.getState().reset();
  vi.useRealTimers();
});

describe("watchHostConnectionAnnouncements", () => {
  it("says a lost link once, however many back-off cycles it goes through", () => {
    stop = watchHostConnectionAnnouncements("studio-01");
    for (let cycle = 0; cycle < 4; cycle += 1) {
      link(RECONNECTING);
      vi.advanceTimersByTime(1_000);
      link(UNREACHABLE);
      vi.advanceTimersByTime(1_000);
    }
    expect(spoken()).toEqual([
      "Connection to studio-01 lost. Terminals are read-only until it reconnects.",
    ]);

    link(RECONNECTING);
    link(CONNECTED);
    vi.advanceTimersByTime(400);
    expect(spoken()).toHaveLength(2);
    expect(spoken()[1]).toBe("Reconnected to studio-01");
  });

  it("says nothing for a blip that recovers inside the gate", () => {
    stop = watchHostConnectionAnnouncements("studio-01");
    link(RECONNECTING);
    vi.advanceTimersByTime(200);
    link(CONNECTED);
    vi.advanceTimersByTime(1_000);
    expect(announce).not.toHaveBeenCalled();
  });

  it("says nothing while the first connect is still trying", () => {
    useHostConnectionStore.setState({ connection: null, everConnected: false });
    stop = watchHostConnectionAnnouncements("studio-01");
    useHostConnectionStore.setState({ connection: { status: "connecting", attempt: 1 } });
    vi.advanceTimersByTime(1_000);
    useHostConnectionStore.setState({ connection: CONNECTED, everConnected: true });
    vi.advanceTimersByTime(1_000);
    expect(announce).not.toHaveBeenCalled();
  });

  it("says what the host answered when it isn't a lost link", () => {
    stop = watchHostConnectionAnnouncements("studio-01");
    link({ status: "unreachable", lastSeenAt: null, detail: null, hostModeOff: true });
    vi.advanceTimersByTime(400);
    expect(spoken()).toEqual(["Daintree isn't running in Host mode on studio-01."]);

    // A retry that fails the same way is the same answer, not a new one.
    link(RECONNECTING);
    vi.advanceTimersByTime(1_000);
    link({ status: "unreachable", lastSeenAt: null, detail: null, hostModeOff: true });
    vi.advanceTimersByTime(1_000);
    expect(spoken()).toHaveLength(1);
  });

  it("says nothing new while connecting again after a deliberate disconnect, then that it connected", () => {
    stop = watchHostConnectionAnnouncements("studio-01");
    link({ status: "disconnected" });
    vi.advanceTimersByTime(400);
    link(RECONNECTING);
    vi.advanceTimersByTime(2_000);
    link(CONNECTED);
    vi.advanceTimersByTime(400);
    expect(spoken()).toEqual(["Disconnected from studio-01.", "Connected to studio-01"]);
  });

  it("calls a failed retry after an ssh refusal unreachable, not a lost connection", () => {
    stop = watchHostConnectionAnnouncements("studio-01");
    link({ status: "unreachable", lastSeenAt: null, detail: null, stoppedRetrying: true });
    vi.advanceTimersByTime(400);
    link(RECONNECTING);
    vi.advanceTimersByTime(1_000);
    link(UNREACHABLE);
    vi.advanceTimersByTime(400);
    expect(spoken()).toEqual([
      "ssh couldn't log in to studio-01.",
      "studio-01 is unreachable. Terminals are read-only until it reconnects.",
    ]);
  });

  it("says connected, not reconnected, when a host first reached after failing comes up", () => {
    useHostConnectionStore.setState({ connection: null, everConnected: false });
    stop = watchHostConnectionAnnouncements("studio-01");
    link(UNREACHABLE);
    vi.advanceTimersByTime(400);
    useHostConnectionStore.setState({ connection: CONNECTED, everConnected: true });
    vi.advanceTimersByTime(400);
    expect(spoken()).toEqual([
      "studio-01 is unreachable. Terminals are read-only until it reconnects.",
      "Connected to studio-01",
    ]);
  });

  it("doesn't say an outage again when the layout running it is replaced", () => {
    stop = watchHostConnectionAnnouncements("studio-01");
    link(UNREACHABLE);
    vi.advanceTimersByTime(400);
    stop();
    // Teardown resets the store; the next layout binds it again and re-reads the link.
    useHostConnectionStore.getState().reset();
    stop = watchHostConnectionAnnouncements("studio-01");
    vi.advanceTimersByTime(1_000);
    useHostConnectionStore.setState({
      hostId: "studio-01",
      hostName: "studio-01",
      connection: UNREACHABLE,
      everConnected: true,
    });
    vi.advanceTimersByTime(1_000);
    expect(spoken()).toHaveLength(1);
    link(CONNECTED);
    vi.advanceTimersByTime(400);
    expect(spoken()[1]).toBe("Reconnected to studio-01");
  });

  it("stops listening and drops a pending announcement when torn down", () => {
    stop = watchHostConnectionAnnouncements("studio-01");
    link(UNREACHABLE);
    stop();
    stop = null;
    vi.advanceTimersByTime(1_000);
    link(CONNECTED);
    vi.advanceTimersByTime(1_000);
    expect(announce).not.toHaveBeenCalled();
  });
});

describe("hostLinkEpisode", () => {
  it("treats reconnecting and unreachable as one outage, and a connect attempt as undecided", () => {
    expect(hostLinkEpisode("reconnecting")).toBe("lost");
    expect(hostLinkEpisode("reconnecting", "host-mode-off")).toBeNull();
    expect(hostLinkEpisode("reconnecting", "disconnected")).toBeNull();
    expect(hostLinkEpisode("unreachable")).toBe("lost");
    expect(hostLinkEpisode("connecting")).toBeNull();
    expect(hostLinkEpisode("checking")).toBe("up");
    expect(hostLinkEpisode(null)).toBe("up");
  });
});

describe("hostLinkAnnouncement", () => {
  it("says connected after a deliberate disconnect and reconnected after a loss", () => {
    expect(hostLinkAnnouncement("up", "disconnected", "studio-01", true)).toBe(
      "Connected to studio-01"
    );
    expect(hostLinkAnnouncement("up", "lost", "studio-01", true)).toBe("Reconnected to studio-01");
    expect(hostLinkAnnouncement("up", "up", "studio-01", true)).toBeNull();
  });

  it("calls a host never reached unreachable rather than lost", () => {
    expect(hostLinkAnnouncement("lost", "up", "studio-01", false)).toBe(
      "studio-01 is unreachable. Terminals are read-only until it reconnects."
    );
  });
});
