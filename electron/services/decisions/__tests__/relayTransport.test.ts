import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionOrigin, WebSocketLike } from "@daintreehq/decisions-client";

vi.mock("electron", () => ({
  net: { isOnline: () => true },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
}));

import { powerMonitor } from "electron";
import {
  ObservedSocket,
  RetiredAttemptError,
  holdingTerminalSink,
  isRelaySocketUrl,
  networkFingerprint,
  retireable,
  socketOriginOf,
  watchNetwork,
  watchResume,
} from "../relayTransport.js";

function rawSocket(): WebSocketLike & { closed: Array<number | undefined> } {
  const closed: Array<number | undefined> = [];
  return {
    readyState: 1,
    send: vi.fn(),
    close: (code?: number) => {
      closed.push(code);
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    closed,
  };
}

const ORIGIN: QuestionOrigin = {
  host_id: "host_12345678",
  pane_id: "pane-1",
  terminal_generation: 3,
  ownership_principal: "principal-1",
  agent_incarnation: "incarnation-1",
  agent_session_id: null,
  worktree_id: "worktree-1",
} as QuestionOrigin;

afterEach(() => {
  vi.useRealTimers();
});

describe("ObservedSocket", () => {
  it("sees the close code before the library's handler runs, and forwards everything", () => {
    const raw = rawSocket();
    const seen: string[] = [];
    const socket = new ObservedSocket(raw, (code) => seen.push(`observed ${code}`));
    socket.onmessage = (event) => seen.push(`message ${String(event.data)}`);
    socket.onclose = (event) => seen.push(`library ${event.code}`);

    raw.onmessage?.({ data: "pong" });
    raw.onclose?.({ code: 4409, reason: "" });
    socket.send("ping");

    expect(seen).toEqual(["message pong", "observed 4409", "library 4409"]);
    expect(raw.send).toHaveBeenCalledWith("ping");
    expect(socket.readyState).toBe(1);
  });

  it("still observes a close after the library let go of its handlers", () => {
    const raw = rawSocket();
    const codes: number[] = [];
    const socket = new ObservedSocket(raw, (code) => codes.push(code));
    socket.onclose = null;

    raw.onclose?.({ code: 4401, reason: "" });

    expect(codes).toEqual([4401]);
  });

  it("detaches from the real socket and closes it", () => {
    const raw = rawSocket();
    const socket = new ObservedSocket(raw, () => {});

    socket.detach();

    expect(raw.onclose).toBeNull();
    expect(raw.onmessage).toBeNull();
    expect(raw.closed).toEqual([1000]);
  });
});

describe("relay socket address", () => {
  it("is the relay's origin as a socket origin, and nothing else", () => {
    const relay = "https://decisions.example.workers.dev";
    expect(socketOriginOf(relay)).toBe("wss://decisions.example.workers.dev");
    expect(
      isRelaySocketUrl("wss://decisions.example.workers.dev/api/v1/socket?ticket=t", relay)
    ).toBe(true);
    expect(isRelaySocketUrl("wss://elsewhere.example/api/v1/socket?ticket=t", relay)).toBe(false);
    expect(isRelaySocketUrl("ws://decisions.example.workers.dev/api/v1/socket", relay)).toBe(false);
    expect(isRelaySocketUrl("not a url", relay)).toBe(false);
    expect(isRelaySocketUrl("ws://localhost:8787/api/v1/socket", "http://localhost:8787")).toBe(
      true
    );
  });
});

describe("retireable", () => {
  it("passes calls through until retired, then refuses every method", async () => {
    let retired = false;
    const target = {
      durable: true,
      value: 1,
      async read() {
        return this.value;
      },
    };
    const guarded = retireable(target, () => retired);

    await expect(guarded.read()).resolves.toBe(1);
    expect(guarded.durable).toBe(true);

    retired = true;

    await expect(guarded.read()).rejects.toBeInstanceOf(RetiredAttemptError);
    expect(guarded.durable).toBe(true);
  });
});

describe("holdingTerminalSink", () => {
  it("finds every pane busy and types nothing", async () => {
    const located = await holdingTerminalSink.locate(ORIGIN);
    expect(located.state).toBe("alive");
    expect(located.target).toMatchObject({ paneId: "pane-1", terminalGeneration: 3 });
    expect(await holdingTerminalSink.isIdle(located.target!)).toBe(false);
    expect(await holdingTerminalSink.inject(located.target!, "answer", "inj-1")).toEqual({
      outcome: "held",
      reason: "delivery-not-wired",
    });
    expect(await holdingTerminalSink.hasMarker(located.target!, "inj-1")).toBe(false);
  });
});

describe("networkFingerprint", () => {
  it("lists external addresses in a fixed order with the online flag", () => {
    const fingerprint = networkFingerprint(true, {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
      en1: [{ address: "10.0.0.9", family: "IPv4", internal: false } as never],
      en0: [{ address: "192.168.1.4", family: "IPv4", internal: false } as never],
    });
    expect(fingerprint).toBe("online|en0/IPv4/192.168.1.4,en1/IPv4/10.0.0.9");
    expect(networkFingerprint(false, {})).toBe("offline|");
  });
});

describe("watchNetwork", () => {
  it("calls back only when the network differs from the last look, and stops", () => {
    vi.useFakeTimers();
    let reading = { online: true, fingerprint: "a" };
    const changes: boolean[] = [];
    const stop = watchNetwork((online) => changes.push(online), {
      intervalMs: 1_000,
      read: () => reading,
    });

    vi.advanceTimersByTime(3_000);
    expect(changes).toEqual([]);

    reading = { online: false, fingerprint: "b" };
    vi.advanceTimersByTime(1_000);
    reading = { online: true, fingerprint: "c" };
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(1_000);
    expect(changes).toEqual([false, true]);

    stop();
    reading = { online: true, fingerprint: "d" };
    vi.advanceTimersByTime(5_000);
    expect(changes).toEqual([false, true]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("watchResume", () => {
  it("listens to powerMonitor resume until stopped", () => {
    const onResume = vi.fn();
    const stop = watchResume(onResume);
    expect(powerMonitor.on).toHaveBeenCalledWith("resume", onResume);
    stop();
    expect(powerMonitor.off).toHaveBeenCalledWith("resume", onResume);
  });
});
