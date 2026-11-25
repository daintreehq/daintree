import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const releaseSignIn = vi.hoisted(() => vi.fn(async (_consumer: string) => undefined));
vi.mock("@/clients/canopyHostClient", () => ({ canopyHostClient: { releaseSignIn } }));

import {
  holdSignInDialog,
  offerHostSignIn,
  onHostSignInOffer,
  takePendingHostSignIn,
  type HostSignInOffer,
} from "../hostSignInOffers";

function offer(consumer: string, expiresAt = 1_000): HostSignInOffer {
  return {
    hostId: "studio",
    agentId: "codex",
    consumer,
    terminal: { terminalId: "daintree-sign-in-1", spawnedAt: 1 },
    expiresAt,
  };
}

describe("assistant sign-in offers for Settings → Hosts (#18197)", () => {
  beforeEach(() => {
    releaseSignIn.mockClear();
    takePendingHostSignIn(0);
  });
  afterEach(() => {
    takePendingHostSignIn(0);
  });

  it("holds one for the tab until it mounts, and a newer one ends the older", () => {
    expect(offerHostSignIn(offer("a"))).toBe(true);
    expect(offerHostSignIn(offer("b"))).toBe(true);
    expect(releaseSignIn.mock.calls).toEqual([["a"]]);
    expect(takePendingHostSignIn(500)?.consumer).toBe("b");
    expect(takePendingHostSignIn(500)).toBeNull();
  });

  it("ends one the tab takes after it expired, rather than opening it", () => {
    offerHostSignIn(offer("late", 1_000));
    expect(takePendingHostSignIn(1_000)).toBeNull();
    expect(releaseSignIn.mock.calls).toEqual([["late"]]);
  });

  it("hands one straight to a showing tab", () => {
    const heard: string[] = [];
    const stop = onHostSignInOffer((given) => heard.push(given.consumer));
    expect(offerHostSignIn(offer("now"))).toBe(true);
    stop();
    expect(heard).toEqual(["now"]);
    expect(takePendingHostSignIn(0)).toBeNull();
    expect(releaseSignIn).not.toHaveBeenCalled();
  });

  it("refuses, and ends, one that meets a sign-in dialog open here", () => {
    const heard: string[] = [];
    const stop = onHostSignInOffer((given) => heard.push(given.consumer));
    const letGo = holdSignInDialog();
    expect(offerHostSignIn(offer("over"))).toBe(false);
    expect(heard).toEqual([]);
    expect(releaseSignIn.mock.calls).toEqual([["over"]]);

    letGo();
    // Letting go twice counts once.
    letGo();
    expect(offerHostSignIn(offer("after"))).toBe(true);
    expect(heard).toEqual(["after"]);
    stop();
  });
});
