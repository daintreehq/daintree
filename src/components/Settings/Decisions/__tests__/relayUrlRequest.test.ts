import { afterEach, describe, expect, it, vi } from "vitest";
import {
  holdRelayUrlRequests,
  onRelayUrlRequest,
  requestRelayUrl,
  takePendingRelayUrlRequest,
} from "../relayUrlRequest";

function settle() {
  return new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("relay URL request", () => {
  afterEach(() => {
    takePendingRelayUrlRequest();
  });

  it("answers at once while Connection listens, leaving nothing pending", () => {
    const listener = vi.fn();
    const stop = onRelayUrlRequest(listener);

    requestRelayUrl();

    expect(listener).toHaveBeenCalledOnce();
    expect(takePendingRelayUrlRequest()).toBe(false);
    stop();
  });

  it("waits for Connection while the page is open, and is taken once", async () => {
    const release = holdRelayUrlRequests();
    requestRelayUrl();
    await settle();

    expect(takePendingRelayUrlRequest()).toBe(true);
    expect(takePendingRelayUrlRequest()).toBe(false);
    release();
  });

  it("is dropped when Settings closes before Connection showed", async () => {
    const release = holdRelayUrlRequests();
    requestRelayUrl();

    release();
    await settle();

    expect(takePendingRelayUrlRequest()).toBe(false);
  });

  it("survives StrictMode's remount, which releases and holds again at once", async () => {
    const first = holdRelayUrlRequests();
    requestRelayUrl();

    first();
    const second = holdRelayUrlRequests();
    await settle();

    expect(takePendingRelayUrlRequest()).toBe(true);
    second();
  });

  it("is kept for the page a request opens, which holds only after it was made", async () => {
    requestRelayUrl();
    await settle();
    const release = holdRelayUrlRequests();

    expect(takePendingRelayUrlRequest()).toBe(true);
    release();
  });
});
