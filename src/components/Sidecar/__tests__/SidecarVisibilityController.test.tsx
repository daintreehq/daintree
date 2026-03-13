// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidecarVisibilityController } from "../SidecarVisibilityController";
import { useSidecarStore } from "@/store";
import { useUIStore } from "@/store/uiStore";

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

describe("SidecarVisibilityController", () => {
  const sidecar = {
    create: vi.fn<({ tabId, url }: { tabId: string; url: string }) => Promise<void>>(),
    show: vi.fn<({ tabId, bounds }: { tabId: string; bounds: unknown }) => Promise<void>>(),
    hide: vi.fn<() => Promise<void>>(),
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

    sidecar.create.mockResolvedValue(undefined);
    sidecar.show.mockResolvedValue(undefined);
    sidecar.hide.mockResolvedValue(undefined);

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
        sidecar,
      },
      configurable: true,
      writable: true,
    });

    useSidecarStore.getState().reset();
    useUIStore.setState({ overlayCount: 0, notificationCenterOpen: false });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries bounds lookup until the placeholder appears, then restores the tab", async () => {
    let calls = 0;
    vi.spyOn(document, "getElementById").mockImplementation((id) => {
      if (id !== "sidecar-placeholder") return null;
      calls += 1;
      if (calls < 3) return null;
      return {
        getBoundingClientRect: () => createPlaceholderRect(),
      } as unknown as HTMLElement;
    });

    render(<SidecarVisibilityController />);

    act(() => {
      useSidecarStore.setState({
        isOpen: true,
        activeTabId: "tab-1",
        tabs: [{ id: "tab-1", title: "Docs", url: "https://example.com/docs" }],
        createdTabs: new Set<string>(),
      });
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(sidecar.create).toHaveBeenCalledWith({
      tabId: "tab-1",
      url: "https://example.com/docs",
    });
    expect(sidecar.show).toHaveBeenCalledWith({
      tabId: "tab-1",
      bounds: { x: 10, y: 21, width: 300, height: 401 },
    });
    expect(useSidecarStore.getState().createdTabs.has("tab-1")).toBe(true);
  });

  it("queues the latest restore request when the active tab changes mid-restore", async () => {
    const firstCreate = deferredPromise();
    sidecar.create
      .mockImplementationOnce(() => firstCreate.promise)
      .mockResolvedValueOnce(undefined);

    vi.spyOn(document, "getElementById").mockReturnValue({
      getBoundingClientRect: () => createPlaceholderRect(),
    } as unknown as HTMLElement);

    render(<SidecarVisibilityController />);

    act(() => {
      useSidecarStore.setState({
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

    expect(sidecar.create).toHaveBeenCalledTimes(1);
    expect(sidecar.create).toHaveBeenLastCalledWith({
      tabId: "tab-a",
      url: "https://example.com/a",
    });

    act(() => {
      useSidecarStore.setState({ activeTabId: "tab-b" });
    });

    firstCreate.resolve();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(sidecar.create).toHaveBeenCalledTimes(2);
    expect(sidecar.create).toHaveBeenLastCalledWith({
      tabId: "tab-b",
      url: "https://example.com/b",
    });
    expect(sidecar.show).toHaveBeenCalledTimes(1);
    expect(sidecar.show).toHaveBeenCalledWith({
      tabId: "tab-b",
      bounds: { x: 10, y: 21, width: 300, height: 401 },
    });
  });

  it("does not mark a tab created or show it if the tab is removed during restore", async () => {
    const createRequest = deferredPromise();
    sidecar.create.mockImplementationOnce(() => createRequest.promise);

    vi.spyOn(document, "getElementById").mockReturnValue({
      getBoundingClientRect: () => createPlaceholderRect(),
    } as unknown as HTMLElement);

    render(<SidecarVisibilityController />);

    act(() => {
      useSidecarStore.setState({
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
      useSidecarStore.setState({
        activeTabId: null,
        tabs: [],
        createdTabs: new Set<string>(),
      });
    });

    createRequest.resolve();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(useSidecarStore.getState().createdTabs.size).toBe(0);
    expect(sidecar.show).not.toHaveBeenCalled();
  });

  it("hides for overlays and re-shows an already created tab without recreating it", async () => {
    vi.spyOn(document, "getElementById").mockReturnValue({
      getBoundingClientRect: () => createPlaceholderRect(),
    } as unknown as HTMLElement);

    useSidecarStore.setState({
      isOpen: true,
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", title: "Docs", url: "https://example.com/docs" }],
      createdTabs: new Set<string>(["tab-1"]),
    });

    render(<SidecarVisibilityController />);

    act(() => {
      useUIStore.setState({ overlayCount: 1 });
    });

    expect(sidecar.hide).toHaveBeenCalledTimes(1);

    act(() => {
      useUIStore.setState({ overlayCount: 0 });
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(sidecar.create).not.toHaveBeenCalled();
    expect(sidecar.show).toHaveBeenCalledWith({
      tabId: "tab-1",
      bounds: { x: 10, y: 21, width: 300, height: 401 },
    });
  });
});
