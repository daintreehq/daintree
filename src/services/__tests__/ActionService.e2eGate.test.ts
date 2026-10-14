import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../store/shortcutHintStore", () => ({
  shortcutHintStore: {
    getState: () => ({
      hydrated: true,
      counts: {},
      show: vi.fn(),
      incrementCount: vi.fn(),
    }),
  },
}));

vi.mock("../KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: () => null,
    getDisplayCombo: () => "",
  },
}));

type WindowSlot = { window?: unknown };

function setWindow(value: unknown): () => void {
  const original = (globalThis as WindowSlot).window;
  Object.defineProperty(globalThis, "window", {
    value,
    writable: true,
    configurable: true,
  });
  return () => {
    Object.defineProperty(globalThis, "window", {
      value: original,
      writable: true,
      configurable: true,
    });
  };
}

describe("ActionService window.__daintreeDispatchAction gate", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
    vi.resetModules();
  });

  it("does not attach __daintreeDispatchAction when __DAINTREE_E2E_MODE__ is absent", async () => {
    const fakeWindow: Record<string, unknown> = {};
    restore = setWindow(fakeWindow);

    vi.resetModules();
    await import("../ActionService");

    expect(fakeWindow.__daintreeDispatchAction).toBeUndefined();
  });

  it("rejects truthy-but-not-true values (e.g. string 'true')", async () => {
    const fakeWindow: Record<string, unknown> = { __DAINTREE_E2E_MODE__: "true" };
    restore = setWindow(fakeWindow);

    vi.resetModules();
    await import("../ActionService");

    expect(fakeWindow.__daintreeDispatchAction).toBeUndefined();
  });

  it("attaches __daintreeDispatchAction when __DAINTREE_E2E_MODE__ is true", async () => {
    const fakeWindow: Record<string, unknown> = { __DAINTREE_E2E_MODE__: true };
    restore = setWindow(fakeWindow);

    vi.resetModules();
    await import("../ActionService");

    expect(typeof fakeWindow.__daintreeDispatchAction).toBe("function");
  });

  it("can attach after the E2E mode flag appears", async () => {
    const fakeWindow: Record<string, unknown> = {};
    restore = setWindow(fakeWindow);

    vi.resetModules();
    const mod = await import("../ActionService");
    expect(fakeWindow.__daintreeDispatchAction).toBeUndefined();

    fakeWindow.__DAINTREE_E2E_MODE__ = true;
    mod.installE2EActionDispatchBridge();

    expect(typeof fakeWindow.__daintreeDispatchAction).toBe("function");
  });
});
