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
      sidecar: {
        closeTab: vi.fn(),
        hide: vi.fn(),
        show: vi.fn(),
      },
    },
  } as unknown;
});

import { useSidecarStore } from "../sidecarStore";

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

describe("sidecarStore", () => {
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

    useSidecarStore.getState().reset();
    useSidecarStore.setState({
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
    const before = useSidecarStore.getState().tabs;

    useSidecarStore.getState().closeTab("missing-tab");

    const after = useSidecarStore.getState().tabs;
    expect(after).toEqual(before);
    expect(window.electron.sidecar.closeTab).not.toHaveBeenCalled();
  });

  it("retries placeholder lookup before showing the next active tab after a close", async () => {
    let calls = 0;
    vi.mocked(document.getElementById).mockImplementation((id: string) => {
      if (id !== "sidecar-placeholder") return null;
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

    useSidecarStore.setState({
      isOpen: true,
      tabs: [
        { id: "tab-1", title: "One", url: "https://example.com/1" },
        { id: "tab-2", title: "Two", url: "https://example.com/2" },
      ],
      activeTabId: "tab-1",
      createdTabs: new Set<string>(["tab-1", "tab-2"]),
    });

    useSidecarStore.getState().closeTab("tab-1");

    await vi.runAllTimersAsync();

    expect(window.electron.sidecar.closeTab).toHaveBeenCalledWith({ tabId: "tab-1" });
    expect(window.electron.sidecar.show).toHaveBeenCalledWith({
      tabId: "tab-2",
      bounds: { x: 12, y: 20, width: 640, height: 480 },
    });
    expect(useSidecarStore.getState().activeTabId).toBe("tab-2");
    expect(useSidecarStore.getState().createdTabs.has("tab-1")).toBe(false);
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

    useSidecarStore.setState({
      isOpen: true,
      tabs: [
        { id: "tab-1", title: "One", url: "https://example.com/1" },
        { id: "tab-2", title: "Two", url: "https://example.com/2" },
      ],
      activeTabId: "tab-1",
      createdTabs: new Set<string>(["tab-1", "tab-2"]),
    });

    useSidecarStore.getState().closeTab("tab-1");
    useSidecarStore.getState().closeAllTabs();

    await vi.runAllTimersAsync();

    expect(window.electron.sidecar.show).not.toHaveBeenCalled();
    expect(useSidecarStore.getState().tabs).toEqual([]);
    expect(useSidecarStore.getState().activeTabId).toBeNull();
  });
});
