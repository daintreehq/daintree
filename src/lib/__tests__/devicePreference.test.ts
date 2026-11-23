// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { devicePreference } from "../devicePreference";

const KEY = "daintree_agent_usage_expanded";

function storageEvent(key: string | null) {
  window.dispatchEvent(new StorageEvent("storage", { key }));
}

describe("devicePreference", () => {
  afterEach(() => {
    localStorage.removeItem(KEY);
    vi.restoreAllMocks();
  });

  it("reads the fallback until something is stored, then what is stored", () => {
    expect(devicePreference(KEY, true).read()).toBe(true);
    expect(devicePreference(KEY, false).read()).toBe(false);
    localStorage.setItem(KEY, "false");
    expect(devicePreference(KEY, true).read()).toBe(false);
    localStorage.setItem(KEY, "true");
    expect(devicePreference(KEY, false).read()).toBe(true);
  });

  it("writes what is set and tells its own listeners", () => {
    const preference = devicePreference(KEY, true);
    const listener = vi.fn();
    preference.subscribe(listener);
    preference.set(false);
    expect(localStorage.getItem(KEY)).toBe("false");
    expect(preference.read()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("follows a storage event for its own key or a clear, and ignores another key's", () => {
    const preference = devicePreference(KEY, true);
    const listener = vi.fn();
    preference.subscribe(listener);
    storageEvent("some-other-key");
    expect(listener).not.toHaveBeenCalled();
    storageEvent(KEY);
    storageEvent(null);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("goes quiet for a listener once it unsubscribes", () => {
    const preference = devicePreference(KEY, true);
    const listener = vi.fn();
    const unsubscribe = preference.subscribe(listener);
    unsubscribe();
    preference.set(false);
    storageEvent(KEY);
    expect(listener).not.toHaveBeenCalled();
  });

  it("holds a value storage refused for this view, until another view's write arrives", () => {
    const preference = devicePreference(KEY, true);
    preference.subscribe(() => {});
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    preference.set(false);
    expect(preference.read()).toBe(false);
    vi.restoreAllMocks();
    localStorage.setItem(KEY, "true");
    storageEvent(KEY);
    expect(preference.read()).toBe(true);
  });

  it("falls back when storage can't be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(devicePreference(KEY, true).read()).toBe(true);
    expect(devicePreference(KEY, false).read()).toBe(false);
  });
});
