// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "daintree-plugin-terminal-links";

describe("pluginTerminalLinkPreferencesStore", () => {
  const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage"
  );

  function installLocalStorage(initial: Record<string, string> = {}): Map<string, string> {
    const backing = new Map<string, string>(Object.entries(initial));
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => {
          backing.set(key, value);
        },
        removeItem: (key: string) => {
          backing.delete(key);
        },
      },
      configurable: true,
      writable: true,
    });
    return backing;
  }

  async function loadStore() {
    vi.resetModules();
    return import("../pluginTerminalLinkPreferencesStore");
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalLocalStorageDescriptor) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
    }
    vi.resetModules();
  });

  it("reads every plugin as on until the user switches one off, and back on", async () => {
    installLocalStorage();
    const { usePluginTerminalLinkPreferencesStore, arePluginTerminalLinksEnabled } =
      await loadStore();
    expect(arePluginTerminalLinksEnabled("acme")).toBe(true);

    usePluginTerminalLinkPreferencesStore.getState().setEnabled("acme", false);
    expect(arePluginTerminalLinksEnabled("acme")).toBe(false);
    expect(arePluginTerminalLinksEnabled("project__p1__acme")).toBe(true);

    usePluginTerminalLinkPreferencesStore.getState().setEnabled("acme", true);
    expect(usePluginTerminalLinkPreferencesStore.getState().disabled).toEqual({});
  });

  it("keeps a switched-off plugin off across a restart", async () => {
    installLocalStorage();
    const first = await loadStore();
    first.usePluginTerminalLinkPreferencesStore.getState().setEnabled("acme", false);

    const afterRestart = await loadStore();
    expect(afterRestart.arePluginTerminalLinksEnabled("acme")).toBe(false);
  });

  it("does not let a stale view undo a sibling view's switch", async () => {
    const backing = installLocalStorage();
    const stale = await loadStore();
    const sibling = await loadStore();

    sibling.usePluginTerminalLinkPreferencesStore.getState().setEnabled("acme", false);
    stale.usePluginTerminalLinkPreferencesStore.getState().setEnabled("other", false);

    const stored: unknown = JSON.parse(backing.get(STORAGE_KEY) ?? "null");
    expect(stored).toMatchObject({ state: { disabled: { acme: true, other: true } } });
  });

  it("picks up a sibling view's switch from a storage event", async () => {
    const backing = installLocalStorage();
    const view = await loadStore();
    expect(view.arePluginTerminalLinksEnabled("acme")).toBe(true);

    backing.set(STORAGE_KEY, JSON.stringify({ state: { disabled: { acme: true } }, version: 0 }));
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    await Promise.resolve();

    expect(view.arePluginTerminalLinksEnabled("acme")).toBe(false);
  });

  it("drops malformed entries on hydration", async () => {
    installLocalStorage({
      [STORAGE_KEY]: JSON.stringify({
        state: { disabled: { acme: true, bad: "yes", worse: false } },
        version: 0,
      }),
    });
    const { usePluginTerminalLinkPreferencesStore } = await loadStore();
    expect(usePluginTerminalLinkPreferencesStore.getState().disabled).toEqual({ acme: true });
  });
});
