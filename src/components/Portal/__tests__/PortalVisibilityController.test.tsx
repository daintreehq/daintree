// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalNavEvent } from "@shared/types";
import { PortalVisibilityController } from "../PortalVisibilityController";
import { usePortalStore } from "@/store";
import { useUIStore } from "@/store/uiStore";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";

function deferredPromise() {
  let resolve!: () => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createPlaceholderRect() {
  return {
    x: 10.4,
    y: 20.6,
    width: 300.2,
    height: 400.8,
  };
}

describe("PortalVisibilityController", () => {
  let evictionCallbacks: Array<(data: { tabId: string }) => void> = [];
  const portal = {
    create: vi.fn<({ tabId, url }: { tabId: string; url: string }) => Promise<void>>(),
    show: vi.fn<
      ({ tabId, bounds }: { tabId: string; bounds: unknown }) => Promise<boolean | void>
    >(),
    hide: vi.fn<() => Promise<void>>(),
    onTabEvicted: vi.fn((cb: (data: { tabId: string }) => void) => {
      evictionCallbacks.push(cb);
      return () => {
        evictionCallbacks = evictionCallbacks.filter((c) => c !== cb);
      };
    }),
    onTabsEvicted: vi.fn((cb: (payload: { tabIds: string[] }) => void) => {
      tabsEvictedCallbacks.push(cb);
      return () => {
        tabsEvictedCallbacks = tabsEvictedCallbacks.filter((c) => c !== cb);
      };
    }),
    onNavEvent: vi.fn((cb: (data: PortalNavEvent) => void) => {
      navCallbacks.push(cb);
      return () => {
        navCallbacks = navCallbacks.filter((c) => c !== cb);
      };
    }),
  };
  let tabsEvictedCallbacks: Array<(payload: { tabIds: string[] }) => void> = [];
  let navCallbacks: Array<(data: PortalNavEvent) => void> = [];
  let viewCached = false;
  let revealCallbacks: Array<() => void> = [];
  let cachedCallbacks: Array<() => void> = [];
  const cacheView = () => {
    viewCached = true;
    for (const cb of cachedCallbacks) cb();
  };
  const app = {
    isViewCached: vi.fn(() => viewCached),
    onViewCached: vi.fn((cb: () => void) => {
      cachedCallbacks.push(cb);
      return () => {
        cachedCallbacks = cachedCallbacks.filter((c) => c !== cb);
      };
    }),
    onViewWarmActivated: vi.fn(() => () => {}),
    onViewRevealed: vi.fn((cb: () => void) => {
      revealCallbacks.push(cb);
      return () => {
        revealCallbacks = revealCallbacks.filter((c) => c !== cb);
      };
    }),
  };
  const storage = new Map<string, string>();
  const localStorageMock = {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      storage.delete(key);
    }),
    clear: vi.fn(() => {
      storage.clear();
    }),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    storage.clear();
    evictionCallbacks = [];
    tabsEvictedCallbacks = [];
    navCallbacks = [];
    revealCallbacks = [];
    cachedCallbacks = [];
    viewCached = false;
    __resetProjectViewCacheStateForTests();

    portal.create.mockResolvedValue(undefined);
    portal.show.mockResolvedValue(undefined);
    portal.hide.mockResolvedValue(undefined);

    Object.defineProperty(globalThis, "localStorage", {
      value: localStorageMock,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "localStorage", {
      value: localStorageMock,
      configurable: true,
      writable: true,
    });

    Object.defineProperty(window, "electron", {
      value: {
        portal,
        app,
        window: { getZoomFactor: vi.fn(() => 1) },
      },
      configurable: true,
      writable: true,
    });

    usePortalStore.getState().reset();
    useUIStore.setState({ overlayStack: [], notificationCenterOpen: false });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries bounds lookup until the placeholder appears, then restores the tab", async () => {
    let calls = 0;
    vi.spyOn(document, "getElementById").mockImplementation((id) => {
      if (id !== "portal-placeholder") return null;
      calls += 1;
      if (calls < 3) return null;
      return {
        getBoundingClientRect: () => createPlaceholderRect(),
      } as unknown as HTMLElement;
    });

    render(<PortalVisibilityController />);

    act(() => {
      usePortalStore.setState({
        isOpen: true,
        activeTabId: "tab-1",
        tabs: [{ id: "tab-1", title: "Docs", url: "https://example.com/docs" }],
        createdTabs: new Set<string>(),
      });
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(portal.create).toHaveBeenCalledWith({
      tabId: "tab-1",
      url: "https://example.com/docs",
      isRestore: true,
    });
    expect(portal.show).toHaveBeenCalledWith({
      tabId: "tab-1",
      bounds: { x: 10, y: 21, width: 301, height: 401 },
    });
    expect(usePortalStore.getState().createdTabs.has("tab-1")).toBe(true);
  });

  it("queues the latest restore request when the active tab changes mid-restore", async () => {
    const firstCreate = deferredPromise();
    portal.create
      .mockImplementationOnce(() => firstCreate.promise)
      .mockResolvedValueOnce(undefined);

    vi.spyOn(document, "getElementById").mockReturnValue({
      getBoundingClientRect: () => createPlaceholderRect(),
    } as unknown as HTMLElement);

    render(<PortalVisibilityController />);

    act(() => {
      usePortalStore.setState({
        isOpen: true,
        activeTabId: "tab-a",
        tabs: [
          { id: "tab-a", title: "A", url: "https://example.com/a" },
          { id: "tab-b", title: "B", url: "https://example.com/b" },
        ],
        createdTabs: new Set<string>(),
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(portal.create).toHaveBeenCalledTimes(1);
    expect(portal.create).toHaveBeenLastCalledWith({
      tabId: "tab-a",
      url: "https://example.com/a",
      isRestore: true,
    });

    act(() => {
      usePortalStore.setState({ activeTabId: "tab-b" });
    });

    firstCreate.resolve();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(portal.create).toHaveBeenCalledTimes(2);
    expect(portal.create).toHaveBeenLastCalledWith({
      tabId: "tab-b",
      url: "https://example.com/b",
      isRestore: true,
    });
    expect(portal.show).toHaveBeenCalledTimes(1);
    expect(portal.show).toHaveBeenCalledWith({
      tabId: "tab-b",
      bounds: { x: 10, y: 21, width: 301, height: 401 },
    });
  });

  it("does not mark a tab created or show it if the tab is removed during restore", async () => {
    const createRequest = deferredPromise();
    portal.create.mockImplementationOnce(() => createRequest.promise);

    vi.spyOn(document, "getElementById").mockReturnValue({
      getBoundingClientRect: () => createPlaceholderRect(),
    } as unknown as HTMLElement);

    render(<PortalVisibilityController />);

    act(() => {
      usePortalStore.setState({
        isOpen: true,
        activeTabId: "tab-1",
        tabs: [{ id: "tab-1", title: "Docs", url: "https://example.com/docs" }],
        createdTabs: new Set<string>(),
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      usePortalStore.setState({
        activeTabId: null,
        tabs: [],
        createdTabs: new Set<string>(),
      });
    });

    createRequest.resolve();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(usePortalStore.getState().createdTabs.size).toBe(0);
    expect(portal.show).not.toHaveBeenCalled();
  });

  it("hides for overlays and re-shows an already created tab without recreating it", async () => {
    vi.spyOn(document, "getElementById").mockReturnValue({
      getBoundingClientRect: () => createPlaceholderRect(),
    } as unknown as HTMLElement);

    usePortalStore.setState({
      isOpen: true,
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", title: "Docs", url: "https://example.com/docs" }],
      createdTabs: new Set<string>(["tab-1"]),
    });

    render(<PortalVisibilityController />);

    act(() => {
      useUIStore.setState({ overlayStack: ["test-overlay"] });
    });

    expect(portal.hide).toHaveBeenCalledTimes(1);

    act(() => {
      useUIStore.setState({ overlayStack: [] });
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(portal.create).not.toHaveBeenCalled();
    expect(portal.show).toHaveBeenCalledWith({
      tabId: "tab-1",
      bounds: { x: 10, y: 21, width: 301, height: 401 },
    });
  });

  it("stops polling and skips show() if the controller unmounts during the bounds wait", async () => {
    // Bounds null for the first few lookups, then valid: without the unmount guard
    // the in-flight async would continue polling past unmount, find bounds, and
    // call show() against a torn-down component. With the guard it breaks on the
    // first post-await tick.
    let calls = 0;
    vi.spyOn(document, "getElementById").mockImplementation((id) => {
      if (id !== "portal-placeholder") return null;
      calls += 1;
      if (calls < 5) return null;
      return { getBoundingClientRect: () => createPlaceholderRect() } as unknown as HTMLElement;
    });

    const view = render(<PortalVisibilityController />);

    act(() => {
      usePortalStore.setState({
        isOpen: true,
        activeTabId: "tab-1",
        tabs: [{ id: "tab-1", title: "Docs", url: "https://example.com/docs" }],
        createdTabs: new Set<string>(),
      });
    });

    // Let create() resolve and the first poll await be scheduled.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(portal.create).toHaveBeenCalledTimes(1);
    expect(portal.show).not.toHaveBeenCalled();

    // Unmount mid-poll — every subsequent post-await tick must bail.
    view.unmount();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(portal.show).not.toHaveBeenCalled();
  });

  it("still restores tabs after StrictMode's effect cleanup-then-rerun cycle (mount ref must reset to true)", async () => {
    vi.spyOn(document, "getElementById").mockReturnValue({
      getBoundingClientRect: () => createPlaceholderRect(),
    } as unknown as HTMLElement);

    render(
      <StrictMode>
        <PortalVisibilityController />
      </StrictMode>
    );

    act(() => {
      usePortalStore.setState({
        isOpen: true,
        activeTabId: "tab-1",
        tabs: [{ id: "tab-1", title: "Docs", url: "https://example.com/docs" }],
        createdTabs: new Set<string>(),
      });
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // If the unmount-tracking ref was permanently flipped to false by StrictMode's
    // double-invoke, the bounds-checked guard would skip portal.show.
    expect(portal.show).toHaveBeenCalledWith({
      tabId: "tab-1",
      bounds: { x: 10, y: 21, width: 301, height: 401 },
    });
  });

  it("defers markTabCreated until after portal.show resolves", async () => {
    // The skeleton in PortalDock derives visibility from !createdTabs.has(activeTabId).
    // If markTabCreated runs right after create (before bounds polling + show), the
    // skeleton clears prematurely. Verify createdTabs stays empty between create
    // and show, and only gains the id after show resolves.
    const createDeferred = deferredPromise();
    const showDeferred = deferredPromise();
    portal.create.mockImplementationOnce(() => createDeferred.promise);
    portal.show.mockImplementationOnce(() => showDeferred.promise);

    vi.spyOn(document, "getElementById").mockReturnValue({
      getBoundingClientRect: () => createPlaceholderRect(),
    } as unknown as HTMLElement);

    render(<PortalVisibilityController />);

    act(() => {
      usePortalStore.setState({
        isOpen: true,
        activeTabId: "tab-1",
        tabs: [{ id: "tab-1", title: "Docs", url: "https://example.com/docs" }],
        createdTabs: new Set<string>(),
      });
    });

    // Pre-create: nothing marked
    expect(usePortalStore.getState().createdTabs.has("tab-1")).toBe(false);

    createDeferred.resolve();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Post-create, pre-show: still not marked — this is the window the skeleton
    // needs to remain visible across.
    expect(portal.show).toHaveBeenCalledTimes(1);
    expect(usePortalStore.getState().createdTabs.has("tab-1")).toBe(false);

    showDeferred.resolve();
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Post-show: now marked, skeleton can clear
    expect(usePortalStore.getState().createdTabs.has("tab-1")).toBe(true);
  });

  it("restores the persisted active tab on cold start, not the first tab", async () => {
    vi.spyOn(document, "getElementById").mockReturnValue({
      getBoundingClientRect: () => createPlaceholderRect(),
    } as unknown as HTMLElement);

    render(<PortalVisibilityController />);

    // Simulate rehydration: portalStore.merge restored a persisted activeTabId
    // that's not tabs[0]. None of the tabs are marked created yet (cold start).
    act(() => {
      usePortalStore.setState({
        isOpen: true,
        activeTabId: "tab-3",
        tabs: [
          { id: "tab-1", title: "One", url: "https://example.com/1" },
          { id: "tab-2", title: "Two", url: "https://example.com/2" },
          { id: "tab-3", title: "Three", url: "https://example.com/3" },
        ],
        createdTabs: new Set<string>(),
      });
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(portal.create).toHaveBeenCalledTimes(1);
    expect(portal.create).toHaveBeenCalledWith({
      tabId: "tab-3",
      url: "https://example.com/3",
      isRestore: true,
    });
    expect(portal.show).toHaveBeenCalledWith({
      tabId: "tab-3",
      bounds: { x: 10, y: 21, width: 301, height: 401 },
    });
    expect(usePortalStore.getState().activeTabId).toBe("tab-3");
    expect(usePortalStore.getState().createdTabs.has("tab-3")).toBe(true);
  });

  it("removes tab from createdTabs when eviction event fires", () => {
    usePortalStore.setState({
      isOpen: true,
      activeTabId: "tab-1",
      tabs: [
        { id: "tab-1", title: "A", url: "https://example.com/a" },
        { id: "tab-2", title: "B", url: "https://example.com/b" },
      ],
      createdTabs: new Set<string>(["tab-1", "tab-2"]),
    });

    render(<PortalVisibilityController />);

    expect(portal.onTabEvicted).toHaveBeenCalled();
    expect(usePortalStore.getState().createdTabs.has("tab-2")).toBe(true);

    act(() => {
      for (const cb of evictionCallbacks) {
        cb({ tabId: "tab-2" });
      }
    });

    expect(usePortalStore.getState().createdTabs.has("tab-2")).toBe(false);
    expect(usePortalStore.getState().tabs.some((t) => t.id === "tab-2")).toBe(true);
  });

  describe("tabs main released (#14537)", () => {
    const BOUNDS = { x: 10, y: 21, width: 301, height: 401 };
    const openWithCreatedTab = () =>
      usePortalStore.setState({
        isOpen: true,
        activeTabId: "tab-1",
        tabs: [
          { id: "tab-1", title: "A", url: "https://example.com/a", partition: "persist:p" },
          { id: "tab-2", title: "B", url: "https://example.com/b" },
        ],
        createdTabs: new Set<string>(["tab-1", "tab-2"]),
      });
    const settle = () =>
      act(async () => {
        await vi.runAllTimersAsync();
      });

    beforeEach(() => {
      const placeholder = Object.assign(document.createElement("div"), {
        getBoundingClientRect: () => DOMRect.fromRect(createPlaceholderRect()),
      });
      vi.spyOn(document, "getElementById").mockReturnValue(placeholder);
    });

    it("brings the selected tab back when main evicts it", async () => {
      openWithCreatedTab();
      render(<PortalVisibilityController />);

      act(() => {
        for (const cb of evictionCallbacks) cb({ tabId: "tab-1" });
      });
      await settle();

      expect(portal.create).toHaveBeenCalledWith({
        tabId: "tab-1",
        url: "https://example.com/a",
        partition: "persist:p",
        isRestore: true,
      });
      expect(portal.show).toHaveBeenCalledWith({ tabId: "tab-1", bounds: BOUNDS });
      expect(usePortalStore.getState().createdTabs.has("tab-1")).toBe(true);
    });

    it("waits for its reveal when memory pressure takes a cached view's selected tab", async () => {
      openWithCreatedTab();
      viewCached = true;
      render(<PortalVisibilityController />);

      act(() => {
        for (const cb of tabsEvictedCallbacks) cb({ tabIds: ["tab-1", "tab-2"] });
      });
      await settle();

      // Shown from here it would cover the project in front.
      expect(portal.create).not.toHaveBeenCalled();
      expect(portal.show).not.toHaveBeenCalled();

      viewCached = false;
      act(() => {
        for (const cb of revealCallbacks) cb();
      });
      await settle();

      expect(portal.create).toHaveBeenCalledTimes(1);
      expect(portal.create).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: "tab-1", isRestore: true })
      );
      expect(portal.show).toHaveBeenCalledWith({ tabId: "tab-1", bounds: BOUNDS });
      expect(usePortalStore.getState().createdTabs.has("tab-1")).toBe(true);
      expect(usePortalStore.getState().createdTabs.has("tab-2")).toBe(false);
    });

    it("holds a restore whose view is cached mid-create until the view's reveal", async () => {
      openWithCreatedTab();
      usePortalStore.setState({ createdTabs: new Set<string>(), isOpen: false });
      const createRequest = deferredPromise();
      portal.create.mockImplementationOnce(() => createRequest.promise);
      render(<PortalVisibilityController />);

      act(() => {
        usePortalStore.setState({ isOpen: true });
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(portal.create).toHaveBeenCalledTimes(1);

      cacheView();
      createRequest.resolve();
      await settle();
      expect(portal.show).not.toHaveBeenCalled();

      viewCached = false;
      act(() => {
        for (const cb of revealCallbacks) cb();
      });
      await settle();

      expect(portal.show).toHaveBeenCalledWith({ tabId: "tab-1", bounds: BOUNDS });
      expect(usePortalStore.getState().createdTabs.has("tab-1")).toBe(true);
    });

    it("never hides the window's portal from a cached view", async () => {
      openWithCreatedTab();
      render(<PortalVisibilityController />);
      act(() => {
        useUIStore.setState({ overlayStack: ["portal-close-confirm"] });
      });
      expect(portal.hide).toHaveBeenCalledTimes(1);

      act(() => {
        cacheView();
        for (const cb of navCallbacks) {
          cb({
            tabId: "tab-1",
            title: "A next",
            url: "https://example.com/a/next",
            canGoBack: true,
            canGoForward: false,
          });
        }
      });

      expect(usePortalStore.getState().tabs[0]!.url).toBe("https://example.com/a/next");
      expect(portal.hide).toHaveBeenCalledTimes(1);
    });

    it("comes back at the page's latest URL, navigated while the dock was collapsed", async () => {
      openWithCreatedTab();
      usePortalStore.setState({ isOpen: false });
      viewCached = true;
      render(<PortalVisibilityController />);

      act(() => {
        for (const cb of navCallbacks) {
          cb({
            tabId: "tab-1",
            title: "A next",
            url: "https://example.com/a/next",
            canGoBack: true,
            canGoForward: false,
          });
        }
        for (const cb of evictionCallbacks) cb({ tabId: "tab-1" });
      });
      viewCached = false;
      act(() => {
        for (const cb of revealCallbacks) cb();
        usePortalStore.setState({ isOpen: true });
      });
      await settle();

      expect(portal.create).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: "tab-1", url: "https://example.com/a/next" })
      );
    });

    it("tracks each tab's history while the dock is collapsed, until main lets the view go (#15040)", () => {
      openWithCreatedTab();
      usePortalStore.setState({ isOpen: false });
      render(<PortalVisibilityController />);
      const navigate = (event: PortalNavEvent) => {
        for (const cb of navCallbacks) cb(event);
      };

      act(() => {
        navigate({
          tabId: "tab-1",
          title: "A next",
          url: "https://example.com/a/next",
          canGoBack: true,
          canGoForward: false,
        });
        navigate({
          tabId: "tab-gone",
          title: "Gone",
          url: "https://example.com/gone",
          canGoBack: true,
          canGoForward: true,
        });
      });

      expect(usePortalStore.getState().tabHistory).toEqual({
        "tab-1": { canGoBack: true, canGoForward: false },
      });

      act(() => {
        for (const cb of evictionCallbacks) cb({ tabId: "tab-1" });
      });

      expect(usePortalStore.getState().tabHistory).toEqual({});
    });

    it("recreates a selected tab that main reports missing on show", async () => {
      openWithCreatedTab();
      portal.show.mockResolvedValueOnce(false).mockResolvedValue(true);
      render(<PortalVisibilityController />);

      // An overlay closing re-shows the tab without creating it.
      act(() => {
        useUIStore.setState({ overlayStack: ["settings"] });
      });
      act(() => {
        useUIStore.setState({ overlayStack: [] });
      });
      await settle();

      expect(portal.create).toHaveBeenCalledTimes(1);
      expect(portal.show).toHaveBeenCalledTimes(2);
      expect(usePortalStore.getState().createdTabs.has("tab-1")).toBe(true);
    });

    it("retries a just-created tab once when it is gone again by the show", async () => {
      openWithCreatedTab();
      usePortalStore.setState({ createdTabs: new Set<string>(), isOpen: false });
      portal.show.mockResolvedValue(false);
      render(<PortalVisibilityController />);

      act(() => {
        usePortalStore.setState({ isOpen: true });
      });
      await settle();

      expect(portal.create).toHaveBeenCalledTimes(2);
      expect(portal.show).toHaveBeenCalledTimes(2);
      expect(usePortalStore.getState().createdTabs.has("tab-1")).toBe(false);
    });
  });

  describe("restores that fail (#15043)", () => {
    // Selected before mount and then opened, so exactly one effect asks for the
    // restore.
    const renderWithClosedTab = () => {
      usePortalStore.setState({
        isOpen: false,
        activeTabId: "tab-1",
        tabs: [{ id: "tab-1", title: "A", url: "https://example.com/a" }],
        createdTabs: new Set<string>(),
      });
      return render(<PortalVisibilityController />);
    };
    const openPortal = () => act(() => usePortalStore.setState({ isOpen: true }));
    const settle = () =>
      act(async () => {
        await vi.runAllTimersAsync();
      });
    const failed = () => usePortalStore.getState().restoreFailedTabs.has("tab-1");
    const mockPlaceholder = () => {
      const placeholder = Object.assign(document.createElement("div"), {
        getBoundingClientRect: () => DOMRect.fromRect(createPlaceholderRect()),
      });
      vi.spyOn(document, "getElementById").mockReturnValue(placeholder);
    };

    it("marks the tab failed when create rejects, and parks any view still on screen", async () => {
      mockPlaceholder();
      portal.create.mockRejectedValue(new Error("boom"));
      renderWithClosedTab();
      openPortal();
      await settle();

      expect(failed()).toBe(true);
      expect(portal.hide).toHaveBeenCalledTimes(1);
      expect(usePortalStore.getState().createdTabs.has("tab-1")).toBe(false);
      expect(usePortalStore.getState().tabs[0]!.url).toBe("https://example.com/a");
    });

    it("marks the tab failed when show rejects", async () => {
      mockPlaceholder();
      portal.show.mockRejectedValue(new Error("boom"));
      renderWithClosedTab();
      openPortal();
      await settle();

      expect(portal.show).toHaveBeenCalledTimes(1);
      expect(failed()).toBe(true);
    });

    it("marks the tab failed when main refuses it on both the show and its retry", async () => {
      mockPlaceholder();
      portal.show.mockResolvedValue(false);
      renderWithClosedTab();
      openPortal();
      await settle();

      expect(portal.show).toHaveBeenCalledTimes(2);
      expect(failed()).toBe(true);
    });

    it("marks the tab failed when the placeholder never appears", async () => {
      vi.spyOn(document, "getElementById").mockReturnValue(null);
      renderWithClosedTab();
      openPortal();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      // Still waiting for the dock to mount.
      expect(failed()).toBe(false);

      await settle();

      expect(portal.create).toHaveBeenCalledTimes(1);
      expect(portal.show).not.toHaveBeenCalled();
      expect(failed()).toBe(true);
    });

    it("records nothing when the retried create comes back", async () => {
      mockPlaceholder();
      portal.show.mockResolvedValueOnce(false).mockResolvedValue(true);
      renderWithClosedTab();
      openPortal();
      await settle();

      expect(portal.create).toHaveBeenCalledTimes(2);
      expect(portal.show).toHaveBeenCalledTimes(2);
      expect(usePortalStore.getState().createdTabs.has("tab-1")).toBe(true);
      expect(failed()).toBe(false);
    });

    it("leaves the failure to work queued for the same tab", async () => {
      mockPlaceholder();
      const firstCreate = deferredPromise();
      const secondCreate = deferredPromise();
      portal.create
        .mockImplementationOnce(() => firstCreate.promise)
        .mockImplementationOnce(() => secondCreate.promise);
      renderWithClosedTab();
      openPortal();
      await act(async () => {
        await Promise.resolve();
      });

      // An overlay coming and going asks for the same tab again mid-create.
      act(() => useUIStore.setState({ overlayStack: ["settings"] }));
      act(() => useUIStore.setState({ overlayStack: [] }));
      expect(portal.hide).toHaveBeenCalledTimes(1);

      firstCreate.reject(new Error("boom"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(portal.create).toHaveBeenCalledTimes(2);
      expect(failed()).toBe(false);
      expect(portal.hide).toHaveBeenCalledTimes(1);

      secondCreate.resolve();
      await settle();

      expect(usePortalStore.getState().createdTabs.has("tab-1")).toBe(true);
      expect(failed()).toBe(false);
    });

    it("records a cached view's failure without hiding the front project's portal", async () => {
      mockPlaceholder();
      const createRequest = deferredPromise();
      portal.create.mockImplementationOnce(() => createRequest.promise);
      renderWithClosedTab();
      openPortal();
      await act(async () => {
        await Promise.resolve();
      });

      cacheView();
      createRequest.reject(new Error("boom"));
      await settle();

      expect(failed()).toBe(true);
      expect(portal.hide).not.toHaveBeenCalled();
    });

    it("starts nothing when a failed tab is created after all", async () => {
      mockPlaceholder();
      portal.create.mockRejectedValueOnce(new Error("boom"));
      renderWithClosedTab();
      openPortal();
      await settle();
      expect(failed()).toBe(true);

      act(() => usePortalStore.getState().markTabCreated("tab-1"));
      await settle();

      expect(failed()).toBe(false);
      expect(portal.create).toHaveBeenCalledTimes(1);
      expect(portal.show).not.toHaveBeenCalled();
    });

    it("records nothing for a tab the user moved off while it was restoring", async () => {
      mockPlaceholder();
      const createRequest = deferredPromise();
      portal.create.mockImplementationOnce(() => createRequest.promise);
      usePortalStore.setState({
        isOpen: false,
        activeTabId: "tab-1",
        tabs: [
          { id: "tab-1", title: "A", url: "https://example.com/a" },
          { id: "tab-2", title: "B", url: "https://example.com/b" },
        ],
        createdTabs: new Set<string>(["tab-2"]),
      });
      render(<PortalVisibilityController />);
      openPortal();
      await act(async () => {
        await Promise.resolve();
      });
      act(() => usePortalStore.setState({ activeTabId: "tab-2" }));
      createRequest.reject(new Error("boom"));
      await settle();

      expect(usePortalStore.getState().restoreFailedTabs.size).toBe(0);
      expect(portal.hide).not.toHaveBeenCalled();
    });

    it("records nothing when the controller unmounts during the bounds wait", async () => {
      vi.spyOn(document, "getElementById").mockReturnValue(null);
      const view = renderWithClosedTab();
      openPortal();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      view.unmount();
      await settle();

      expect(failed()).toBe(false);
    });

    it("tries again at the same URL when the failure is cleared, and clears it on success", async () => {
      mockPlaceholder();
      portal.create.mockRejectedValueOnce(new Error("boom"));
      renderWithClosedTab();
      openPortal();
      await settle();
      expect(failed()).toBe(true);

      act(() => usePortalStore.getState().clearTabRestoreFailed("tab-1"));
      await settle();

      expect(portal.create).toHaveBeenCalledTimes(2);
      expect(portal.create).toHaveBeenLastCalledWith({
        tabId: "tab-1",
        url: "https://example.com/a",
        isRestore: true,
      });
      expect(usePortalStore.getState().createdTabs.has("tab-1")).toBe(true);
      expect(failed()).toBe(false);
    });

    it("lands back on the failure after a retry that fails, without trying again by itself", async () => {
      mockPlaceholder();
      portal.create.mockRejectedValue(new Error("boom"));
      renderWithClosedTab();
      openPortal();
      await settle();
      act(() => usePortalStore.getState().clearTabRestoreFailed("tab-1"));
      await settle();

      expect(portal.create).toHaveBeenCalledTimes(2);
      expect(failed()).toBe(true);
    });

    it("keeps a failed tab's error through eviction notices and starts nothing", async () => {
      mockPlaceholder();
      portal.create.mockRejectedValue(new Error("boom"));
      renderWithClosedTab();
      openPortal();
      await settle();
      act(() => {
        for (const cb of evictionCallbacks) cb({ tabId: "tab-1" });
        for (const cb of tabsEvictedCallbacks) cb({ tabIds: ["tab-1"] });
      });
      await settle();

      expect(portal.create).toHaveBeenCalledTimes(1);
      expect(failed()).toBe(true);
    });
  });
});
