/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { BrowserNavigationHistorySnapshot } from "@shared/types/browser";
import { useGuestHistorySnapshot } from "../useGuestHistorySnapshot";

type Pending = {
  webContentsId: number;
  resolve: (snapshot: BrowserNavigationHistorySnapshot) => void;
};

let pending: Pending[] = [];
const getNavigationHistory = vi.fn(
  (webContentsId: number) =>
    new Promise<BrowserNavigationHistorySnapshot>((resolve) => {
      pending.push({ webContentsId, resolve });
    })
);

function snapshotOf(urls: string[], activeIndex: number): BrowserNavigationHistorySnapshot {
  return {
    entries: urls.map((url, index) => ({ index, url, title: "" })),
    activeIndex,
    canGoBack: activeIndex > 0,
    canGoForward: activeIndex < urls.length - 1,
  };
}

function makeGuest(webContentsId = 1) {
  const guest = document.createElement("div") as unknown as Electron.WebviewTag & {
    getWebContentsId: ReturnType<typeof vi.fn>;
  };
  guest.getWebContentsId = vi.fn(() => webContentsId);
  return guest;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function settle(request: Pending, snapshot: BrowserNavigationHistorySnapshot) {
  await act(async () => {
    request.resolve(snapshot);
    await Promise.resolve();
  });
}

function emit(guest: Electron.WebviewTag, type: string, payload: Record<string, unknown> = {}) {
  act(() => {
    guest.dispatchEvent(Object.assign(new Event(type), payload));
  });
}

beforeEach(() => {
  pending = [];
  getNavigationHistory.mockClear();
  (window as unknown as { electron: unknown }).electron = { webview: { getNavigationHistory } };
});

describe("useGuestHistorySnapshot (#16910)", () => {
  it("reads nothing until the guest is ready", async () => {
    const guest = makeGuest();
    const { result } = renderHook(() => useGuestHistorySnapshot(guest, false));
    await flush();

    expect(getNavigationHistory).not.toHaveBeenCalled();
    expect(result.current.navSnapshot).toBeNull();
  });

  it("picks the nearest entries by Chromium's index, whatever their order", async () => {
    const guest = makeGuest();
    const { result } = renderHook(() => useGuestHistorySnapshot(guest, true));
    await flush();
    await settle(pending[0]!, {
      entries: [9, 0, 5, 2, 7].map((index) => ({ index, url: `/${index}`, title: "" })),
      activeIndex: 5,
      canGoBack: true,
      canGoForward: true,
    });

    expect(result.current.backEntry?.index).toBe(2);
    expect(result.current.forwardEntry?.index).toBe(7);
  });

  it("reads again on a main-frame commit, coalescing a burst, and not for a subframe", async () => {
    const guest = makeGuest();
    renderHook(() => useGuestHistorySnapshot(guest, true));
    await flush();
    expect(getNavigationHistory).toHaveBeenCalledTimes(1);

    emit(guest, "did-navigate-in-page", { isMainFrame: false });
    await flush();
    expect(getNavigationHistory).toHaveBeenCalledTimes(1);

    emit(guest, "did-navigate-in-page", { isMainFrame: true });
    emit(guest, "page-title-updated");
    await flush();
    expect(getNavigationHistory).toHaveBeenCalledTimes(2);
  });

  it("keeps the newest read when an older one answers last", async () => {
    const guest = makeGuest();
    const { result } = renderHook(() => useGuestHistorySnapshot(guest, true));
    await flush();
    emit(guest, "did-navigate");
    await flush();
    const [older, newer] = pending;

    await settle(newer!, snapshotOf(["/a", "/b"], 1));
    await settle(older!, snapshotOf(["/a"], 0));

    expect(result.current.navSnapshot?.activeIndex).toBe(1);
  });

  it("never shows a replaced element's entries", async () => {
    const first = makeGuest();
    const { result, rerender } = renderHook(({ guest }) => useGuestHistorySnapshot(guest, true), {
      initialProps: { guest: first },
    });
    await flush();
    await settle(pending[0]!, snapshotOf(["/a", "/b"], 1));
    emit(first, "did-navigate");
    await flush();
    const stale = pending[1]!;

    rerender({ guest: makeGuest(2) });
    expect(result.current.navSnapshot).toBeNull();

    await settle(stale, snapshotOf(["/a", "/b", "/c"], 2));
    expect(result.current.navSnapshot).toBeNull();
  });

  it("drops the old guest's entries when a new guest takes over the same element", async () => {
    const guest = makeGuest(1);
    const { result } = renderHook(() => useGuestHistorySnapshot(guest, true));
    await flush();
    await settle(pending[0]!, snapshotOf(["/a", "/b"], 1));
    expect(result.current.backEntry?.url).toBe("/a");

    // A DOM move: same element, new WebContents, its history still loading.
    guest.getWebContentsId.mockReturnValue(2);
    emit(guest, "dom-ready");
    await flush();

    expect(pending.at(-1)!.webContentsId).toBe(2);
    expect(result.current.navSnapshot).toBeNull();
    expect(result.current.backEntry).toBeNull();
  });

  it("drops the old guest's entries, and its answer, when the guest detaches mid-move", async () => {
    const guest = makeGuest(1);
    const { result } = renderHook(() => useGuestHistorySnapshot(guest, true));
    await flush();
    await settle(pending[0]!, snapshotOf(["/a", "/b"], 1));
    emit(guest, "did-navigate");
    await flush();
    const departed = pending[1]!;

    guest.getWebContentsId.mockImplementation(() => {
      throw new Error("The WebView must be attached to the DOM");
    });
    emit(guest, "dom-ready");
    await flush();
    expect(result.current.navSnapshot).toBeNull();

    await settle(departed, snapshotOf(["/a", "/b", "/c"], 2));
    expect(result.current.navSnapshot).toBeNull();
  });

  it("publishes nothing after unmount", async () => {
    const guest = makeGuest();
    const { result, unmount } = renderHook(() => useGuestHistorySnapshot(guest, true));
    await flush();
    const request = pending[0]!;
    const before = result.current;
    unmount();

    await settle(request, snapshotOf(["/a", "/b"], 1));
    expect(result.current).toBe(before);
  });
});
