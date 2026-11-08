import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  net: { isOnline: () => true },
}));

import { networkFingerprint, watchNetwork } from "../networkWatch.js";

afterEach(() => {
  vi.useRealTimers();
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
