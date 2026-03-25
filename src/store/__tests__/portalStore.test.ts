import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const storage = new Map<string, string>();
  const localStorageMock = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
  };

  (globalThis as unknown as { localStorage: Storage }).localStorage =
    localStorageMock as unknown as Storage;
  (globalThis as unknown as { window?: unknown }).window = {
    ...((globalThis as unknown as { window?: unknown }).window as Record<string, unknown>),
    localStorage: localStorageMock as unknown as Storage,
    electron: {
      portal: {
        closeTab: vi.fn(),
        hide: vi.fn(),
        show: vi.fn(),
      },
      window: { getZoomFactor: vi.fn(() => 1) },
    },
  } as unknown;
});

import { usePortalStore } from "../portalStore";
import { PORTAL_MIN_WIDTH, PORTAL_MAX_WIDTH, PORTAL_DEFAULT_WIDTH } from "@shared/types";

function createLocalStorageMock() {
  const storage = new Map<string, string>();
  return {
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
}

describe("portalStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const localStorageMock = createLocalStorageMock();
    (globalThis as unknown as { localStorage: Storage }).localStorage =
      localStorageMock as unknown as Storage;
    window.localStorage = localStorageMock as unknown as Storage;
    (
      globalThis as unknown as {
        document: { getElementById: ReturnType<typeof vi.fn> };
      }
    ).document = {
      getElementById: vi.fn(),
    };

    usePortalStore.getState().reset();
    usePortalStore.setState({
      tabs: [{ id: "tab-1", title: "One", url: "https://example.com" }],
      activeTabId: "tab-1",
      createdTabs: new Set<string>(["tab-1"]),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not call backend closeTab for unknown tab IDs", () => {
    const before = usePortalStore.getState().tabs;

    usePortalStore.getState().closeTab("missing-tab");

    const after = usePortalStore.getState().tabs;
    expect(after).toEqual(before);
    expect(window.electron.portal.closeTab).not.toHaveBeenCalled();
  });

  it("retries placeholder lookup before showing the next active tab after a close", async () => {
    let calls = 0;
    vi.mocked(document.getElementById).mockImplementation((id: string) => {
      if (id !== "portal-placeholder") return null;
      calls += 1;
      if (calls < 3) return null;
      return {
        getBoundingClientRect: () => ({
          x: 12.2,
          y: 19.8,
          width: 640.4,
          height: 479.6,
        }),
      } as HTMLElement;
    });

    usePortalStore.setState({
      isOpen: true,
      tabs: [
        { id: "tab-1", title: "One", url: "https://example.com/1" },
        { id: "tab-2", title: "Two", url: "https://example.com/2" },
      ],
      activeTabId: "tab-1",
      createdTabs: new Set<string>(["tab-1", "tab-2"]),
    });

    usePortalStore.getState().closeTab("tab-1");

    await vi.runAllTimersAsync();

    expect(window.electron.portal.closeTab).toHaveBeenCalledWith({ tabId: "tab-1" });
    expect(window.electron.portal.show).toHaveBeenCalledWith({
      tabId: "tab-2",
      bounds: { x: 12, y: 20, width: 641, height: 480 },
    });
    expect(usePortalStore.getState().activeTabId).toBe("tab-2");
    expect(usePortalStore.getState().createdTabs.has("tab-1")).toBe(false);
  });

  describe("width clamping", () => {
    it("clamps width below minimum to PORTAL_MIN_WIDTH", () => {
      usePortalStore.getState().setWidth(PORTAL_MIN_WIDTH - 1);
      expect(usePortalStore.getState().width).toBe(PORTAL_MIN_WIDTH);
    });

    it("allows width at exactly PORTAL_MIN_WIDTH", () => {
      usePortalStore.getState().setWidth(PORTAL_MIN_WIDTH);
      expect(usePortalStore.getState().width).toBe(PORTAL_MIN_WIDTH);
    });

    it("preserves in-range width values exactly", () => {
      usePortalStore.getState().setWidth(600);
      expect(usePortalStore.getState().width).toBe(600);
    });

    it("allows width at exactly PORTAL_MAX_WIDTH", () => {
      usePortalStore.getState().setWidth(PORTAL_MAX_WIDTH);
      expect(usePortalStore.getState().width).toBe(PORTAL_MAX_WIDTH);
    });

    it("clamps width above maximum to PORTAL_MAX_WIDTH", () => {
      usePortalStore.getState().setWidth(PORTAL_MAX_WIDTH + 1);
      expect(usePortalStore.getState().width).toBe(PORTAL_MAX_WIDTH);
    });

    it("resets width to PORTAL_DEFAULT_WIDTH", () => {
      usePortalStore.getState().setWidth(800);
      usePortalStore.getState().reset();
      expect(usePortalStore.getState().width).toBe(PORTAL_DEFAULT_WIDTH);
    });
  });

  it("does not show a stale tab if the close flow is superseded before restore runs", async () => {
    vi.mocked(document.getElementById).mockReturnValue({
      getBoundingClientRect: () => ({
        x: 0,
        y: 0,
        width: 800,
        height: 600,
      }),
    } as HTMLElement);

    usePortalStore.setState({
      isOpen: true,
      tabs: [
        { id: "tab-1", title: "One", url: "https://example.com/1" },
        { id: "tab-2", title: "Two", url: "https://example.com/2" },
      ],
      activeTabId: "tab-1",
      createdTabs: new Set<string>(["tab-1", "tab-2"]),
    });

    usePortalStore.getState().closeTab("tab-1");
    usePortalStore.getState().closeAllTabs();

    await vi.runAllTimersAsync();

    expect(window.electron.portal.show).not.toHaveBeenCalled();
    expect(usePortalStore.getState().tabs).toEqual([]);
    expect(usePortalStore.getState().activeTabId).toBeNull();
  });

  it("unmarkTabCreated removes from createdTabs but preserves other tabs", () => {
    const store = usePortalStore.getState();
    const tabA = store.createTab("http://example.com/a", "A");
    const tabB = store.createTab("http://example.com/b", "B");
    const tabC = store.createTab("http://example.com/c", "C");

    usePortalStore.getState().markTabCreated(tabA);
    usePortalStore.getState().markTabCreated(tabB);
    usePortalStore.getState().markTabCreated(tabC);

    usePortalStore.getState().unmarkTabCreated(tabB);

    const state = usePortalStore.getState();
    expect(state.createdTabs.has(tabA)).toBe(true);
    expect(state.createdTabs.has(tabB)).toBe(false);
    expect(state.createdTabs.has(tabC)).toBe(true);
    expect(state.tabs.some((t) => t.id === tabB)).toBe(true);
  });

  it("unmarkTabCreated is idempotent", () => {
    usePortalStore.getState().unmarkTabCreated("non-existent-tab");
    expect(() => usePortalStore.getState().unmarkTabCreated("non-existent-tab")).not.toThrow();
  });
});
