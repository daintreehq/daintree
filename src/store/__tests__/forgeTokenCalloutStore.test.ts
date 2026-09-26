// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "daintree-forge-token-callout";
const PROVIDER = "daintree.github.github";

describe("forgeTokenCalloutStore", () => {
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
    return (await import("../forgeTokenCalloutStore")).useForgeTokenCalloutStore;
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

  it("keeps a dismissal across a restart", async () => {
    installLocalStorage();
    const first = await loadStore();
    first.getState().dismiss(PROVIDER, "fp-1");

    const afterRestart = await loadStore();
    expect(afterRestart.getState().dismissed[PROVIDER]).toBe("fp-1");
  });

  it("does not let a stale view drop a dismissal a sibling view made", async () => {
    const backing = installLocalStorage();
    const stale = await loadStore();
    const sibling = await loadStore();

    sibling.getState().dismiss(PROVIDER, "fp-1");
    stale.getState().dismiss("acme.gitlab", "fp-2");

    const stored: unknown = JSON.parse(backing.get(STORAGE_KEY) ?? "null");
    expect(stored).toMatchObject({
      state: { dismissed: { [PROVIDER]: "fp-1", "acme.gitlab": "fp-2" } },
    });
  });

  it("picks up a sibling view's dismissal from a storage event", async () => {
    const backing = installLocalStorage();
    const view = await loadStore();
    expect(view.getState().dismissed[PROVIDER]).toBeUndefined();

    backing.set(
      STORAGE_KEY,
      JSON.stringify({ state: { dismissed: { [PROVIDER]: "fp-1" } }, version: 0 })
    );
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    await Promise.resolve();

    expect(view.getState().dismissed[PROVIDER]).toBe("fp-1");
  });

  it("drops malformed entries on hydration", async () => {
    installLocalStorage({
      [STORAGE_KEY]: JSON.stringify({
        state: { dismissed: { [PROVIDER]: "fp-1", bad: 42 } },
        version: 0,
      }),
    });
    const store = await loadStore();
    expect(store.getState().dismissed).toEqual({ [PROVIDER]: "fp-1" });
  });
});
