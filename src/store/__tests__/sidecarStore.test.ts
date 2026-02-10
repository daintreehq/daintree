import { beforeEach, describe, expect, it, vi } from "vitest";

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
    vi.clearAllMocks();
    const localStorageMock = createLocalStorageMock();
    (globalThis as unknown as { localStorage: Storage }).localStorage =
      localStorageMock as unknown as Storage;
    window.localStorage = localStorageMock as unknown as Storage;

    useSidecarStore.getState().reset();
    useSidecarStore.setState({
      tabs: [{ id: "tab-1", title: "One", url: "https://example.com" }],
      activeTabId: "tab-1",
      createdTabs: new Set<string>(["tab-1"]),
    });
  });

  it("does not call backend closeTab for unknown tab IDs", () => {
    const before = useSidecarStore.getState().tabs;

    useSidecarStore.getState().closeTab("missing-tab");

    const after = useSidecarStore.getState().tabs;
    expect(after).toEqual(before);
    expect(window.electron.sidecar.closeTab).not.toHaveBeenCalled();
  });
});
