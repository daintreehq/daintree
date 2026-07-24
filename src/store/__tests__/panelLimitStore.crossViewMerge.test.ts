import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Cross-view write-merge coverage for the shared localStorage partition
 * (issue #11351). The limit fields aren't project-scoped, but they're set from
 * multiple independent surfaces across views — and the store's transient setters
 * (`requestConfirmation` bumping `requestSeq`) trigger a persist write of the
 * unchanged limits, so a stale view would otherwise clobber a sibling's edit.
 */
describe("panelLimitStore cross-view write merge (#11351)", () => {
  const STORAGE_KEY = "daintree-panel-limits";
  const VERSION = 1;
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  type PersistedBlob = { version: number; state: Record<string, unknown> };

  function installLocalStorage(initial: Record<string, string>): Map<string, string> {
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

  function restoreLocalStorage(): void {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "localStorage", originalDescriptor);
      return;
    }
    delete (globalThis as Partial<typeof globalThis>).localStorage;
  }

  function readBlob(backing: Map<string, string>): PersistedBlob {
    return JSON.parse(backing.get(STORAGE_KEY)!) as PersistedBlob;
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    restoreLocalStorage();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("a fresh view's limit change preserves a sibling's other limit fields", async () => {
    const backing = installLocalStorage({});
    const { usePanelLimitStore: store } = await import("../panelLimitStore");

    backing.set(
      STORAGE_KEY,
      JSON.stringify({ version: VERSION, state: { confirmationLimit: 25, warningsDisabled: true } })
    );

    store.getState().setSoftWarningLimit(15);

    const written = readBlob(backing);
    expect(written.state.softWarningLimit).toBe(15); // this view's change
    expect(written.state.confirmationLimit).toBe(25); // sibling's field survived
    expect(written.state.warningsDisabled).toBe(true); // sibling's field survived
  });

  it("independent threshold edits from two views both survive", async () => {
    const backing = installLocalStorage({});
    const { usePanelLimitStore: store } = await import("../panelLimitStore");

    store.getState().setSoftWarningLimit(15);

    const disk = readBlob(backing);
    disk.state.hardLimit = 50;
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    store.getState().setConfirmationLimit(25);

    const written = readBlob(backing);
    expect(written.state.softWarningLimit).toBe(15);
    expect(written.state.confirmationLimit).toBe(25); // this view's change
    expect(written.state.hardLimit).toBe(50); // sibling's change survived
  });

  it("a transient confirmation-state write does not clobber a sibling's edited limit", async () => {
    const backing = installLocalStorage({});
    const { usePanelLimitStore: store } = await import("../panelLimitStore");

    // A sibling edits the hard limit on disk.
    backing.set(STORAGE_KEY, JSON.stringify({ version: VERSION, state: { hardLimit: 50 } }));

    // A transient, non-persisted state change (requestSeq/pendingConfirm) still
    // triggers a persist write of this stale view's unchanged limits.
    store.getState().requestConfirmation(10, null);

    const written = readBlob(backing);
    expect(written.state.hardLimit).toBe(50); // sibling's edit not clobbered

    store.getState().resolveConfirmation(false); // settle the pending promise
  });
});
