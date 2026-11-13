/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { BrowserHistory } from "@shared/types/browser";
import { useUrlHistoryStore } from "@/store/urlHistoryStore";
import { useDevPreviewLoadLifecycle } from "../useDevPreviewLoadLifecycle";
import { createGuestHistoryIntent, type GuestHistoryIntent } from "../useGuestHistorySnapshot";

vi.mock("@/store", () => {
  const state = { getTerminal: () => undefined };
  return {
    usePanelStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});

const ROOT = "http://localhost:5173/";
const PAGE_A = "http://localhost:5173/a";
const PAGE_B = "http://localhost:5173/b";

type FakeGuest = HTMLElement & {
  getURL: ReturnType<typeof vi.fn>;
  canGoForward: ReturnType<typeof vi.fn>;
  clearHistory: ReturnType<typeof vi.fn>;
};

function makeGuest(): FakeGuest {
  const guest = document.createElement("div") as unknown as FakeGuest;
  guest.getURL = vi.fn(() => ROOT);
  guest.canGoForward = vi.fn(() => false);
  guest.clearHistory = vi.fn();
  Object.assign(guest, {
    getTitle: vi.fn(() => ""),
    isLoading: vi.fn(() => true),
    setZoomFactor: vi.fn(),
    executeJavaScript: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    reload: vi.fn(),
  });
  return guest;
}

function emit(guest: FakeGuest, type: string, payload: Record<string, unknown>) {
  act(() => {
    guest.dispatchEvent(Object.assign(new Event(type), payload));
  });
}

function renderLifecycle(present = PAGE_B) {
  const guest = makeGuest();
  const intentRef: { current: GuestHistoryIntent } = { current: createGuestHistoryIntent() };
  const lastSetUrlRef = { current: present };
  const evictingRef = { current: false };
  const setHistory = vi.fn();
  const rendered = renderHook(() =>
    useDevPreviewLoadLifecycle({
      webviewElement: guest as unknown as Electron.WebviewTag,
      id: "dev-preview-1",
      projectId: "project-1",
      loadTimeoutMs: 30_000,
      zoomFactor: 1,
      evictingRef,
      lastSetUrlRef,
      guestHistoryIntentRef: intentRef,
      setHistory,
      setBlockedNav: vi.fn(),
    })
  );
  // The history the listeners' updaters are applied to.
  const follow = (history: BrowserHistory): BrowserHistory => {
    const updater = setHistory.mock.calls.at(-1)![0] as (prev: BrowserHistory) => BrowserHistory;
    return updater(history);
  };
  return { ...rendered, guest, intentRef, lastSetUrlRef, evictingRef, setHistory, follow };
}

describe("useDevPreviewLoadLifecycle — guest commits (#16910)", () => {
  it("reads a commit that leaves entries ahead as a step through the guest's history", () => {
    const { guest, follow } = renderLifecycle();
    guest.canGoForward.mockReturnValue(true);
    emit(guest, "did-navigate", { url: PAGE_A });

    expect(follow({ past: [PAGE_A], present: PAGE_B, future: [] })).toEqual({
      past: [],
      present: PAGE_A,
      future: [PAGE_B],
    });
  });

  it("reads a commit with nothing ahead as a fresh entry", () => {
    const { guest, follow } = renderLifecycle();
    emit(guest, "did-navigate-in-page", { url: PAGE_A, isMainFrame: true });

    expect(follow({ past: [PAGE_A], present: PAGE_B, future: [] })).toEqual({
      past: [PAGE_A, PAGE_B],
      present: PAGE_A,
      future: [],
    });
  });

  it("consumes a requested step on a commit onto the URL already showing", () => {
    const { guest, intentRef, follow } = renderLifecycle();
    intentRef.current.stepOffset = -2;
    emit(guest, "did-navigate-in-page", { url: PAGE_B, isMainFrame: true });

    expect(intentRef.current.stepOffset).toBeNull();
    // The guest moved between two entries for the URL, and so does the history.
    expect(follow({ past: [PAGE_B, PAGE_A], present: PAGE_B, future: [] })).toEqual({
      past: [],
      present: PAGE_B,
      future: [PAGE_A, PAGE_B],
    });
  });

  it("leaves the intent to a subframe's commit and to eviction's blank page", () => {
    const { guest, intentRef, evictingRef, setHistory } = renderLifecycle();
    intentRef.current = { stepOffset: -1, pruneOnCommitOf: PAGE_A };

    emit(guest, "did-navigate-in-page", { url: `${PAGE_B}#frame`, isMainFrame: false });
    evictingRef.current = true;
    emit(guest, "did-navigate", { url: "about:blank" });

    expect(intentRef.current).toEqual({ stepOffset: -1, pruneOnCommitOf: PAGE_A });
    expect(guest.clearHistory).not.toHaveBeenCalled();
    expect(setHistory).not.toHaveBeenCalled();
  });

  it("prunes once, on the saved-history load's own commit", () => {
    const { guest, intentRef } = renderLifecycle();
    intentRef.current.pruneOnCommitOf = PAGE_A;

    // The page being left changes its own URL while the load is in flight.
    emit(guest, "did-navigate-in-page", { url: `${PAGE_B}?tab=2`, isMainFrame: true });
    expect(guest.clearHistory).not.toHaveBeenCalled();
    expect(intentRef.current.pruneOnCommitOf).toBe(PAGE_A);

    emit(guest, "did-navigate", { url: PAGE_A });
    expect(guest.clearHistory).toHaveBeenCalledTimes(1);
    expect(intentRef.current.pruneOnCommitOf).toBeNull();

    emit(guest, "did-navigate", { url: PAGE_B });
    expect(guest.clearHistory).toHaveBeenCalledTimes(1);
  });

  it("prunes on a same-document commit when only the fragment differed", () => {
    const { guest, intentRef } = renderLifecycle(`${ROOT}#b`);
    intentRef.current.pruneOnCommitOf = `${ROOT}#a`;
    emit(guest, "did-navigate-in-page", { url: `${ROOT}#a`, isMainFrame: true });

    expect(guest.clearHistory).toHaveBeenCalledTimes(1);
  });

  it("reads whether entries are ahead before pruning clears them", () => {
    const { guest, intentRef, follow } = renderLifecycle();
    guest.canGoForward.mockReturnValue(true);
    guest.clearHistory.mockImplementation(() => guest.canGoForward.mockReturnValue(false));
    intentRef.current.pruneOnCommitOf = PAGE_A;
    emit(guest, "did-navigate", { url: PAGE_A });

    expect(guest.clearHistory).toHaveBeenCalledTimes(1);
    expect(follow({ past: [PAGE_A], present: PAGE_B, future: [] }).future).toEqual([PAGE_B]);
  });
});

describe("useDevPreviewLoadLifecycle — favicons (#16910)", () => {
  type UpdateFavicon = ReturnType<typeof useUrlHistoryStore.getState>["updateFavicon"];
  let updateFavicon: ReturnType<typeof vi.fn<UpdateFavicon>>;
  let original: UpdateFavicon;

  beforeEach(() => {
    vi.useFakeTimers();
    updateFavicon = vi.fn<UpdateFavicon>();
    original = useUrlHistoryStore.getState().updateFavicon;
    useUrlHistoryStore.setState({ updateFavicon });
  });

  afterEach(() => {
    useUrlHistoryStore.setState({ updateFavicon: original });
    vi.useRealTimers();
  });

  it("records the last icon of a burst, once", () => {
    const { guest } = renderLifecycle();
    emit(guest, "page-favicon-updated", { favicons: [`${ROOT}first.ico`] });
    act(() => vi.advanceTimersByTime(150));
    emit(guest, "page-favicon-updated", { favicons: [`${ROOT}second.ico`, `${ROOT}other.ico`] });
    act(() => vi.advanceTimersByTime(150));
    expect(updateFavicon).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(100));
    expect(updateFavicon).toHaveBeenCalledTimes(1);
    expect(updateFavicon).toHaveBeenCalledWith("project-1", ROOT, `${ROOT}second.ico`);
  });

  it("records the icon against the URL showing when it arrived", () => {
    const { guest } = renderLifecycle();
    emit(guest, "page-favicon-updated", { favicons: [`${ROOT}icon.ico`] });
    guest.getURL.mockReturnValue(PAGE_A);
    act(() => vi.advanceTimersByTime(250));

    expect(updateFavicon).toHaveBeenCalledWith("project-1", ROOT, `${ROOT}icon.ico`);
  });

  it("skips no icon, an oversized data URL and a blank page", () => {
    const { guest } = renderLifecycle();
    emit(guest, "page-favicon-updated", { favicons: [] });
    emit(guest, "page-favicon-updated", {
      favicons: [`data:image/png;base64,${"A".repeat(9000)}`],
    });
    guest.getURL.mockReturnValue("about:blank");
    emit(guest, "page-favicon-updated", { favicons: [`${ROOT}icon.ico`] });
    act(() => vi.advanceTimersByTime(250));

    expect(updateFavicon).not.toHaveBeenCalled();
  });

  it("drops a pending icon, and stops listening, when the guest goes", () => {
    const { guest, unmount } = renderLifecycle();
    emit(guest, "page-favicon-updated", { favicons: [`${ROOT}icon.ico`] });
    unmount();
    act(() => vi.advanceTimersByTime(250));
    emit(guest, "page-favicon-updated", { favicons: [`${ROOT}later.ico`] });
    act(() => vi.advanceTimersByTime(250));

    expect(updateFavicon).not.toHaveBeenCalled();
  });
});
