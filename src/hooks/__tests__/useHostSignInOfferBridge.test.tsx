// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanopyHostEvent } from "@shared/types/ipc/canopyHost";

const offers = vi.hoisted(() => ({ offerHostSignIn: vi.fn((_offer: unknown) => true) }));
vi.mock("@/components/Settings/Hosts/hostSignInOffers", () => offers);

import { useHostSignInOfferBridge } from "../useHostSignInOfferBridge";

describe("useHostSignInOfferBridge (#18197)", () => {
  let emit: (event: CanopyHostEvent) => void = () => {};
  let unsubscribed = false;
  const tabs: unknown[] = [];
  const onTab = (event: Event) => tabs.push((event as CustomEvent).detail);

  beforeEach(() => {
    offers.offerHostSignIn.mockClear();
    offers.offerHostSignIn.mockReturnValue(true);
    tabs.length = 0;
    unsubscribed = false;
    window.addEventListener("daintree:open-settings-tab", onTab);
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {
        canopyHost: {
          onEvent: (callback: (event: CanopyHostEvent) => void) => {
            emit = callback;
            return () => {
              unsubscribed = true;
            };
          },
        },
      },
    });
  });
  afterEach(() => {
    window.removeEventListener("daintree:open-settings-tab", onTab);
  });

  const signInOffer = (expiresAt: number): CanopyHostEvent => ({
    kind: "sign-in-offer",
    hostId: "studio",
    agentId: "codex",
    consumer: "offer-1",
    terminal: { terminalId: "daintree-sign-in-1", spawnedAt: 1 },
    expiresAt,
  });

  it("opens Settings → Hosts for a sign-in Main offered this view", () => {
    const { unmount } = renderHook(() => useHostSignInOfferBridge());
    emit(signInOffer(Date.now() + 30_000));
    expect(offers.offerHostSignIn).toHaveBeenCalledWith({
      hostId: "studio",
      agentId: "codex",
      consumer: "offer-1",
      terminal: { terminalId: "daintree-sign-in-1", spawnedAt: 1 },
      expiresAt: expect.any(Number),
    });
    expect(tabs).toEqual([{ tab: "hosts" }]);
    unmount();
    expect(unsubscribed).toBe(true);
  });

  it("opens nothing for one that already ended, one refused here, or any other push", () => {
    renderHook(() => useHostSignInOfferBridge());
    emit(signInOffer(Date.now() - 1));
    emit({ kind: "resync", hostId: "studio" });
    expect(offers.offerHostSignIn).not.toHaveBeenCalled();

    offers.offerHostSignIn.mockReturnValue(false);
    emit(signInOffer(Date.now() + 30_000));
    expect(offers.offerHostSignIn).toHaveBeenCalledTimes(1);
    expect(tabs).toEqual([]);
  });
});
