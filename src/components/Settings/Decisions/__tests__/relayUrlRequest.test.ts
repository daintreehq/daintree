import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UNCLAIMED_REQUEST_TTL_MS,
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
    vi.useRealTimers();
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
  it("keeps a request made after the last page went, for the page it opens", async () => {
    const release = holdRelayUrlRequests();
    release();
    requestRelayUrl();
    await settle();

    expect(takePendingRelayUrlRequest()).toBe(true);
  });

  it("lets a request no page claimed in time go, so a later visit doesn't land on it", () => {
    vi.useFakeTimers();
    requestRelayUrl();
    vi.advanceTimersByTime(UNCLAIMED_REQUEST_TTL_MS + 1);

    const release = holdRelayUrlRequests();

    expect(takePendingRelayUrlRequest()).toBe(false);
    release();
  });

  it("keeps a request the page claimed, past the claiming window", () => {
    vi.useFakeTimers();
    requestRelayUrl();
    const claiming = holdRelayUrlRequests();
    vi.advanceTimersByTime(UNCLAIMED_REQUEST_TTL_MS + 1);
    const again = holdRelayUrlRequests();

    expect(takePendingRelayUrlRequest()).toBe(true);
    claiming();
    again();
  });

  it("keeps a claimed request however long Decisions takes to be turned on", async () => {
    vi.useFakeTimers();
    const first = holdRelayUrlRequests();
    requestRelayUrl();
    first();
    // The page coming back within the same opening finds it claimed, not stale.
    const second = holdRelayUrlRequests();
    vi.advanceTimersByTime(UNCLAIMED_REQUEST_TTL_MS + 1);
    await settle();
    const third = holdRelayUrlRequests();

    expect(takePendingRelayUrlRequest()).toBe(true);
    second();
    third();
  });
});
