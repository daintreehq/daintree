import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostWakeSetup } from "../../../../shared/types/hostWake.js";
import type {
  HostConnection,
  HostConnectionState,
  HostDescriptor,
  HostId,
} from "../../../../shared/types/remoteHosts.js";
import { HostBringBackService } from "../HostBringBackService.js";
import type { HostStartEvent } from "../hostStarts.js";
import type { WakeRoute } from "../wakeOnLan.js";

const HOST = "studio";
const SSH_TIMEOUT = "ssh: connect to host studio port 22: Operation timed out";
const DEADLINE_MS = 120_000;
const NUDGE_MS = 5_000;

function descriptor(
  options: { wake?: HostWakeSetup; connection?: HostConnection } = {}
): HostDescriptor {
  return {
    id: HOST,
    name: "Studio",
    connection: options.connection ?? { kind: "ssh", target: "studio.local" },
    platform: "darwin",
    arch: "arm64",
    lastHandshake: null,
    lastSeenAt: null,
    addedAt: 0,
    notificationsEnabled: false,
    assistantControlEnabled: true,
    ...(options.wake ? { wake: options.wake } : {}),
  };
}

const WAKE = { mac: "aa:bb:cc:dd:ee:f0", lan: "192.168.1.0/24" };
const ROUTE: WakeRoute = { kind: "route", localAddress: "192.168.1.20", broadcast: "192.168.1.255" };

function unreachable(
  detail: string | null,
  flags: { stoppedRetrying?: true; hostModeOff?: true } = {}
): HostConnectionState {
  return { status: "unreachable", lastSeenAt: null, detail, ...flags };
}

const CONNECTED: HostConnectionState = {
  status: "connected",
  rttMs: 4,
  handshake: {
    version: "1.0.0",
    commit: "abc",
    protocolVersion: 1,
    platform: "darwin",
    arch: "arm64",
  },
};

interface Setup {
  host?: HostDescriptor | null;
  state?: HostConnectionState;
  route?: WakeRoute;
  sendWake?: () => Promise<void>;
  /** What the link reports right after the redial; connecting unless given. */
  afterRedial?: HostConnectionState;
}

function world(setup: Setup = {}) {
  let host: HostDescriptor | null = setup.host === undefined ? descriptor() : setup.host;
  let state: HostConnectionState = setup.state ?? unreachable("earlier", { stoppedRetrying: true });
  const linkListeners = new Set<(hostId: HostId, state: HostConnectionState) => void>();
  const startListeners = new Set<(event: HostStartEvent) => void>();
  const calls: string[] = [];
  let holds = 0;
  let allowed = 0;
  const setLink = (next: HostConnectionState) => {
    state = next;
    for (const listener of [...linkListeners]) listener(HOST, next);
  };
  const service = new HostBringBackService({
    host: (hostId) => (hostId === HOST ? host : null),
    linkState: () => state,
    onLinkState: (listener) => {
      linkListeners.add(listener);
      return () => linkListeners.delete(listener);
    },
    redial: () => {
      calls.push("redial");
      setLink(setup.afterRedial ?? { status: "connecting", attempt: 1 });
    },
    nudge: () => calls.push("nudge"),
    hold: () => {
      holds++;
      calls.push("hold");
      return () => {
        holds--;
        calls.push("release");
      };
    },
    allowStart: () => {
      allowed++;
      return () => allowed--;
    },
    observeStarts: (_hostId, listener) => {
      startListeners.add(listener);
      return () => startListeners.delete(listener);
    },
    wakeRoute: () => setup.route ?? ROUTE,
    sendWake: async () => {
      calls.push("wake");
      await setup.sendWake?.();
    },
    deadlineMs: DEADLINE_MS,
    nudgeMs: NUDGE_MS,
  });
  return {
    service,
    calls,
    setLink,
    emitStart: (event: HostStartEvent) => {
      for (const listener of [...startListeners]) listener(event);
    },
    remove: () => {
      host = null;
    },
    /** Everything an attempt held is let go. */
    released: () =>
      holds === 0 && allowed === 0 && linkListeners.size === 0 && startListeners.size === 0,
  };
}

/** Lets the wake's send settle and the dial begin. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HostBringBackService", () => {
  it("answers connected at once for a link that is already up, trying nothing", async () => {
    const w = world({ state: CONNECTED });
    await expect(w.service.bringBack(HOST)).resolves.toMatchObject({
      status: "connected",
      wake: "not_needed",
      reached: true,
      startRequested: false,
    });
    expect(w.calls).toEqual([]);
    expect(w.released()).toBe(true);
  });

  it("sends the wake before it dials, and answers woken once the link comes up", async () => {
    const w = world({ host: descriptor({ wake: WAKE }) });
    const answer = w.service.bringBack(HOST);
    await flush();
    expect(w.calls).toEqual(["hold", "wake", "redial"]);
    // Still waking: ssh not up yet is no answer.
    w.setLink(unreachable(SSH_TIMEOUT));
    w.setLink({ status: "connecting", attempt: 2 });
    w.setLink(CONNECTED);
    await expect(answer).resolves.toMatchObject({
      status: "woken",
      wake: "sent",
      reached: true,
      startRequested: false,
    });
    expect(w.released()).toBe(true);
  });

  it("is not wakeable when ssh doesn't get in and no wake is set up, with ssh's own words", async () => {
    const w = world();
    const answer = w.service.bringBack(HOST);
    await flush();
    w.setLink(unreachable(SSH_TIMEOUT));
    await expect(answer).resolves.toMatchObject({
      status: "not_wakeable",
      wake: "not_set_up",
      reached: false,
      observed: SSH_TIMEOUT,
    });
    expect(w.calls).not.toContain("wake");
    expect(w.released()).toBe(true);
  });

  it("is not wakeable, sending nothing, when this machine isn't on the host's LAN", async () => {
    const w = world({ host: descriptor({ wake: WAKE }), route: { kind: "not_on_lan" } });
    const answer = w.service.bringBack(HOST);
    await flush();
    w.setLink(unreachable(SSH_TIMEOUT));
    await expect(answer).resolves.toMatchObject({ status: "not_wakeable", wake: "not_on_lan" });
    expect(w.calls).not.toContain("wake");
  });

  it("still dials when the wake can't be sent, and says the wake failed", async () => {
    const w = world({
      host: descriptor({ wake: WAKE }),
      sendWake: () => Promise.reject(new Error("EADDRNOTAVAIL")),
    });
    const answer = w.service.bringBack(HOST);
    await flush();
    expect(w.calls).toEqual(["hold", "wake", "redial"]);
    w.setLink(unreachable(SSH_TIMEOUT));
    await expect(answer).resolves.toMatchObject({ status: "not_wakeable", wake: "failed" });
  });

  it("answers started only once a start it saw listened and the link came up", async () => {
    const w = world();
    const answer = w.service.bringBack(HOST);
    await flush();
    w.emitStart({ kind: "checking" });
    w.emitStart({ kind: "start-requested" });
    w.emitStart({ kind: "running", started: true });
    w.setLink(CONNECTED);
    await expect(answer).resolves.toMatchObject({
      status: "started",
      reached: true,
      startRequested: true,
    });
  });

  it("never calls it started on the request alone", async () => {
    const w = world();
    const answer = w.service.bringBack(HOST);
    await flush();
    w.emitStart({ kind: "checking" });
    w.emitStart({ kind: "start-requested" });
    w.setLink(CONNECTED);
    await expect(answer).resolves.toMatchObject({ status: "connected", startRequested: true });
  });

  it("answers both observations when a wake went and a start listened", async () => {
    const w = world({ host: descriptor({ wake: WAKE }) });
    const answer = w.service.bringBack(HOST);
    await flush();
    w.emitStart({ kind: "checking" });
    w.emitStart({ kind: "start-requested" });
    w.emitStart({ kind: "running", started: true });
    w.setLink(CONNECTED);
    await expect(answer).resolves.toMatchObject({ status: "started", wake: "sent" });
  });

  it("is not startable when the start is refused, saying what the probe found", async () => {
    const w = world();
    const answer = w.service.bringBack(HOST);
    await flush();
    w.emitStart({ kind: "checking" });
    // ssh not answering the check refuses nothing.
    w.emitStart({ kind: "refused", refusal: "unreached" });
    w.emitStart({ kind: "refused", refusal: "host-mode-off" });
    const settled = await answer;
    expect(settled).toMatchObject({ status: "not_startable", reached: true });
    expect(settled.observed).toContain("Host mode isn't on");
    expect(w.released()).toBe(true);
  });

  it("is not startable when the start fails there, in its own words", async () => {
    const w = world();
    const answer = w.service.bringBack(HOST);
    await flush();
    w.emitStart({ kind: "checking" });
    w.emitStart({ kind: "start-requested" });
    w.emitStart({ kind: "failed", reason: "Couldn't start Daintree on studio.local. Log in there" });
    await expect(answer).resolves.toMatchObject({
      status: "not_startable",
      startRequested: true,
      observed: "Couldn't start Daintree on studio.local. Log in there",
    });
  });

  it("is not startable when the link parks on no Daintree serving there", async () => {
    const w = world();
    const answer = w.service.bringBack(HOST);
    await flush();
    w.setLink(unreachable("no Daintree in Host mode", { hostModeOff: true, stoppedRetrying: true }));
    await expect(answer).resolves.toMatchObject({ status: "not_startable", reached: true });
  });

  it("is unreachable when ssh refuses the login", async () => {
    const w = world({ host: descriptor({ wake: WAKE }) });
    const answer = w.service.bringBack(HOST);
    await flush();
    w.setLink(unreachable("Permission denied (publickey).", { stoppedRetrying: true }));
    await expect(answer).resolves.toMatchObject({
      status: "unreachable",
      observed: "Permission denied (publickey).",
    });
  });

  it("answers version_mismatch when the host answers on another protocol", async () => {
    const w = world();
    const answer = w.service.bringBack(HOST);
    await flush();
    w.setLink({
      status: "version-mismatch",
      mismatch: { kind: "protocol", local: "1", remote: "2" },
      remote: { ...CONNECTED.handshake, protocolVersion: 2 },
    });
    await expect(answer).resolves.toMatchObject({ status: "version_mismatch" });
  });

  it("keeps a woken host's dial going until the deadline, then times out", async () => {
    const w = world({ host: descriptor({ wake: WAKE }) });
    const answer = w.service.bringBack(HOST);
    await flush();
    w.setLink(unreachable(SSH_TIMEOUT));
    await vi.advanceTimersByTimeAsync(NUDGE_MS * 2);
    expect(w.calls.filter((call) => call === "nudge")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    const settled = await answer;
    expect(settled).toMatchObject({ status: "timed_out", wake: "sent", reached: false });
    expect(settled.elapsedMs).toBe(DEADLINE_MS);
    expect(w.released()).toBe(true);
    // Nothing is nudged once the attempt is over.
    const nudges = w.calls.filter((call) => call === "nudge").length;
    await vi.advanceTimersByTimeAsync(NUDGE_MS * 3);
    expect(w.calls.filter((call) => call === "nudge")).toHaveLength(nudges);
  });

  it("joins every call made while an attempt is under way: one wake, one dial, one answer", async () => {
    const w = world({ host: descriptor({ wake: WAKE }) });
    const first = w.service.bringBack(HOST);
    const second = w.service.bringBack(HOST);
    expect(second).toBe(first);
    expect(w.service.isBringingBack(HOST)).toBe(true);
    await flush();
    expect(w.service.bringBack(HOST)).toBe(first);
    w.setLink(CONNECTED);
    await first;
    expect(w.calls.filter((call) => call === "wake")).toHaveLength(1);
    expect(w.calls.filter((call) => call === "redial")).toHaveLength(1);
    expect(w.service.isBringingBack(HOST)).toBe(false);
    // A call after the answer starts afresh.
    w.setLink(unreachable(SSH_TIMEOUT, { stoppedRetrying: true }));
    const again = w.service.bringBack(HOST);
    expect(again).not.toBe(first);
    await flush();
    w.setLink(CONNECTED);
    await again;
    expect(w.calls.filter((call) => call === "redial")).toHaveLength(2);
  });

  it("is cancelled when the host is disconnected or removed meanwhile", async () => {
    const w = world();
    const answer = w.service.bringBack(HOST);
    await flush();
    w.setLink({ status: "disconnected" });
    await expect(answer).resolves.toMatchObject({ status: "cancelled" });
    expect(w.released()).toBe(true);

    const removed = world({ host: descriptor({ wake: WAKE }) });
    const pending = removed.service.bringBack(HOST);
    // Gone while the wake was being sent: nothing is dialled.
    removed.remove();
    await flush();
    await expect(pending).resolves.toMatchObject({ status: "cancelled", wake: "sent" });
    expect(removed.calls).not.toContain("redial");
  });

  it("is cancelled when no dial starts, as for a host being changed", async () => {
    const w = world({ afterRedial: unreachable("earlier", { stoppedRetrying: true }) });
    await expect(w.service.bringBack(HOST)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("ends every attempt at dispose and refuses new ones", async () => {
    const w = world();
    const answer = w.service.bringBack(HOST);
    await flush();
    w.service.dispose();
    await expect(answer).resolves.toMatchObject({ status: "cancelled" });
    expect(w.released()).toBe(true);
    expect(() => w.service.bringBack(HOST)).toThrow(/stopping/);
  });

  it("refuses this machine and a host it doesn't know", () => {
    const w = world();
    expect(() => w.service.bringBack("local")).toThrow(/isn't a host to bring back/);
    expect(() => w.service.bringBack("elsewhere")).toThrow(/No host with id elsewhere/);
  });

  it("never wakes a WSL distro, and calls one it can't open unreachable", async () => {
    const w = world({ host: descriptor({ connection: { kind: "wsl", distro: "Ubuntu" } }) });
    const answer = w.service.bringBack(HOST);
    await flush();
    w.setLink(unreachable("wsl.exe failed"));
    await expect(answer).resolves.toMatchObject({ status: "unreachable", wake: "not_needed" });
    expect(w.calls).not.toContain("wake");
  });
});
