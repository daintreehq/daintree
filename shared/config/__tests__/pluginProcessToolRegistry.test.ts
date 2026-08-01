import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPluginProcessToolRegistryForTests,
  getPluginProcessToolRegistry,
  registerPluginProcessTools,
  setPluginProcessToolRegistry,
  unregisterPluginProcessTools,
} from "../pluginProcessToolRegistry.js";

describe("pluginProcessToolRegistry (#11613)", () => {
  beforeEach(() => {
    clearPluginProcessToolRegistryForTests();
  });

  afterEach(() => {
    clearPluginProcessToolRegistryForTests();
    vi.restoreAllMocks();
  });

  it("flattens a plugin's contributions into a command → icon record", () => {
    registerPluginProcessTools("acme.tools", [
      { command: "acme-cli", iconId: "sparkles" },
      { command: "acme-serve", iconId: "globe" },
    ]);

    expect(getPluginProcessToolRegistry()).toEqual({
      "acme-cli": "sparkles",
      "acme-serve": "globe",
    });
  });

  it("lower-cases commands so they match the detector's lower-cased lookup", () => {
    registerPluginProcessTools("acme.tools", [{ command: "AcMe-CLI", iconId: "sparkles" }]);

    const snapshot = getPluginProcessToolRegistry();
    expect(Object.keys(snapshot)).toEqual(["acme-cli"]);
    expect(snapshot["AcMe-CLI"]).toBeUndefined();
  });

  it("replaces a plugin's prior set on re-registration rather than merging", () => {
    registerPluginProcessTools("acme.tools", [
      { command: "acme-cli", iconId: "sparkles" },
      { command: "acme-old", iconId: "globe" },
    ]);
    registerPluginProcessTools("acme.tools", [{ command: "acme-cli", iconId: "package" }]);

    const snapshot = getPluginProcessToolRegistry();
    expect(snapshot["acme-cli"]).toBe("package");
    expect(snapshot).not.toHaveProperty("acme-old");
  });

  it("clears a plugin's entries when re-registered with an empty array", () => {
    registerPluginProcessTools("acme.tools", [{ command: "acme-cli", iconId: "sparkles" }]);
    registerPluginProcessTools("acme.tools", []);

    expect(getPluginProcessToolRegistry()).toEqual({});
  });

  it("unregister removes only the named plugin's entries", () => {
    registerPluginProcessTools("acme.tools", [{ command: "acme-cli", iconId: "sparkles" }]);
    registerPluginProcessTools("other.tools", [{ command: "other-cli", iconId: "globe" }]);

    unregisterPluginProcessTools("acme.tools");

    const snapshot = getPluginProcessToolRegistry();
    expect(snapshot).not.toHaveProperty("acme-cli");
    expect(snapshot["other-cli"]).toBe("globe");
  });

  it("unregistering an unknown plugin leaves the snapshot reference untouched", () => {
    registerPluginProcessTools("acme.tools", [{ command: "acme-cli", iconId: "sparkles" }]);
    const before = getPluginProcessToolRegistry();

    unregisterPluginProcessTools("never.registered");

    expect(getPluginProcessToolRegistry()).toBe(before);
  });

  it("resolves a cross-plugin command collision first-registered-wins with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    registerPluginProcessTools("first.plugin", [{ command: "shared-cli", iconId: "sparkles" }]);
    registerPluginProcessTools("second.plugin", [{ command: "shared-cli", iconId: "globe" }]);

    expect(getPluginProcessToolRegistry()["shared-cli"]).toBe("sparkles");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("shared-cli"));
  });

  it("promotes the losing plugin's entry once the winner unloads", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    registerPluginProcessTools("first.plugin", [{ command: "shared-cli", iconId: "sparkles" }]);
    registerPluginProcessTools("second.plugin", [{ command: "shared-cli", iconId: "globe" }]);
    unregisterPluginProcessTools("first.plugin");

    expect(getPluginProcessToolRegistry()["shared-cli"]).toBe("globe");
  });

  it("skips malformed contributions instead of writing undefined into the snapshot", () => {
    registerPluginProcessTools("acme.tools", [
      { command: "acme-cli", iconId: "sparkles" },
      { command: "no-icon" } as never,
      { iconId: "globe" } as never,
    ]);

    expect(getPluginProcessToolRegistry()).toEqual({ "acme-cli": "sparkles" });
  });

  it("does not let a `__proto__` command reassign the snapshot's prototype", () => {
    registerPluginProcessTools("acme.tools", [{ command: "__proto__", iconId: "sparkles" }]);

    const snapshot = getPluginProcessToolRegistry();
    expect(Object.hasOwn(snapshot, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(snapshot)).toBe(null);
  });

  it("setPluginProcessToolRegistry replaces the snapshot wholesale (host mirror path)", () => {
    registerPluginProcessTools("acme.tools", [{ command: "acme-cli", iconId: "sparkles" }]);

    setPluginProcessToolRegistry({ "mirrored-cli": "globe" });

    const snapshot = getPluginProcessToolRegistry();
    expect(snapshot["mirrored-cli"]).toBe("globe");
    expect(snapshot).not.toHaveProperty("acme-cli");
  });

  it("returns the mirrored record as-is rather than a clone, so identity is a valid cache key", () => {
    const record = { "mirrored-cli": "globe" };
    setPluginProcessToolRegistry(record);
    expect(getPluginProcessToolRegistry()).toBe(record);
  });

  it("keeps the same reference when mirroring the record already held", () => {
    const record = { "mirrored-cli": "globe" };
    setPluginProcessToolRegistry(record);
    setPluginProcessToolRegistry(record);
    expect(getPluginProcessToolRegistry()).toBe(record);
  });

  it("gives every main-side mutation a fresh snapshot reference", () => {
    registerPluginProcessTools("acme.tools", [{ command: "acme-cli", iconId: "sparkles" }]);
    const first = getPluginProcessToolRegistry();
    registerPluginProcessTools("other.tools", [{ command: "other-cli", iconId: "globe" }]);
    expect(getPluginProcessToolRegistry()).not.toBe(first);
  });

  it("ignores an empty plugin id on both register and unregister", () => {
    registerPluginProcessTools("", [{ command: "acme-cli", iconId: "sparkles" }]);
    expect(getPluginProcessToolRegistry()).toEqual({});

    registerPluginProcessTools("acme.tools", [{ command: "acme-cli", iconId: "sparkles" }]);
    const before = getPluginProcessToolRegistry();
    unregisterPluginProcessTools("");
    expect(getPluginProcessToolRegistry()).toBe(before);
  });
});
