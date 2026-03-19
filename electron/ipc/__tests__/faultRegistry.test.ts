import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("faultRegistry (env enabled)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("CANOPY_E2E_FAULT_MODE", "1");
    globalThis.__canopyFaultRegistry = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.__canopyFaultRegistry = undefined;
  });

  async function loadRegistry() {
    return await import("../faultRegistry.js");
  }

  it("initFaultRegistry creates the registry", async () => {
    const { initFaultRegistry, FAULT_MODE_ENABLED } = await loadRegistry();
    expect(FAULT_MODE_ENABLED).toBe(true);
    expect(globalThis.__canopyFaultRegistry).toBeUndefined();
    initFaultRegistry();
    expect(globalThis.__canopyFaultRegistry).toEqual({});
  });

  it("setFault and getFault round-trip", async () => {
    const { initFaultRegistry, setFault, getFault } = await loadRegistry();
    initFaultRegistry();
    setFault("test:channel", { kind: "error", message: "boom" });
    expect(getFault("test:channel")).toEqual({ kind: "error", message: "boom" });
  });

  it("setFault replaces existing config", async () => {
    const { initFaultRegistry, setFault, getFault } = await loadRegistry();
    initFaultRegistry();
    setFault("ch", { kind: "error", message: "first" });
    setFault("ch", { kind: "delay", delayMs: 100 });
    expect(getFault("ch")).toEqual({ kind: "delay", delayMs: 100 });
  });

  it("clearFault removes a single fault", async () => {
    const { initFaultRegistry, setFault, getFault, clearFault } = await loadRegistry();
    initFaultRegistry();
    setFault("a", { kind: "error", message: "a" });
    setFault("b", { kind: "error", message: "b" });
    clearFault("a");
    expect(getFault("a")).toBeUndefined();
    expect(getFault("b")).toEqual({ kind: "error", message: "b" });
  });

  it("clearAllFaults empties the registry", async () => {
    const { initFaultRegistry, setFault, getFault, clearAllFaults } = await loadRegistry();
    initFaultRegistry();
    setFault("a", { kind: "error", message: "a" });
    setFault("b", { kind: "error", message: "b" });
    clearAllFaults();
    expect(getFault("a")).toBeUndefined();
    expect(getFault("b")).toBeUndefined();
  });

  it("applyInvokeFault throws for error faults", async () => {
    const { initFaultRegistry, setFault, applyInvokeFault } = await loadRegistry();
    initFaultRegistry();
    setFault("ch", { kind: "error", message: "injected", code: "E2E" });
    await expect(applyInvokeFault("ch")).rejects.toThrow("injected");
    try {
      await applyInvokeFault("ch");
    } catch (err: unknown) {
      expect((err as NodeJS.ErrnoException).code).toBe("E2E");
    }
  });

  it("applyInvokeFault delays for delay faults", async () => {
    const { initFaultRegistry, setFault, applyInvokeFault } = await loadRegistry();
    initFaultRegistry();
    setFault("ch", { kind: "delay", delayMs: 50 });
    const start = Date.now();
    await applyInvokeFault("ch");
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it("applyInvokeFault is a no-op when no fault set", async () => {
    const { initFaultRegistry, applyInvokeFault } = await loadRegistry();
    initFaultRegistry();
    await expect(applyInvokeFault("clean-channel")).resolves.toBeUndefined();
  });
});

describe("faultRegistry (env disabled)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("CANOPY_E2E_FAULT_MODE", "");
    globalThis.__canopyFaultRegistry = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.__canopyFaultRegistry = undefined;
  });

  async function loadRegistry() {
    return await import("../faultRegistry.js");
  }

  it("FAULT_MODE_ENABLED is false", async () => {
    const { FAULT_MODE_ENABLED } = await loadRegistry();
    expect(FAULT_MODE_ENABLED).toBe(false);
  });

  it("initFaultRegistry is a no-op", async () => {
    const { initFaultRegistry } = await loadRegistry();
    initFaultRegistry();
    expect(globalThis.__canopyFaultRegistry).toBeUndefined();
  });

  it("getFault returns undefined", async () => {
    const { getFault } = await loadRegistry();
    expect(getFault("anything")).toBeUndefined();
  });

  it("setFault is a no-op", async () => {
    const { setFault } = await loadRegistry();
    setFault("ch", { kind: "error", message: "nope" });
    expect(globalThis.__canopyFaultRegistry).toBeUndefined();
  });

  it("applyInvokeFault resolves immediately", async () => {
    const { applyInvokeFault } = await loadRegistry();
    await expect(applyInvokeFault("ch")).resolves.toBeUndefined();
  });
});
