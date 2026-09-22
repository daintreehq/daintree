import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("faultRegistry (env enabled)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("DAINTREE_E2E_FAULT_MODE", "1");
    globalThis.__daintreeFaultRegistry = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.__daintreeFaultRegistry = undefined;
  });

  async function loadRegistry() {
    return await import("../faultRegistry.js");
  }

  it("initFaultRegistry creates the registry", async () => {
    const { initFaultRegistry, FAULT_MODE_ENABLED } = await loadRegistry();
    expect(FAULT_MODE_ENABLED).toBe(true);
    expect(globalThis.__daintreeFaultRegistry).toBeUndefined();
    initFaultRegistry();
    expect(globalThis.__daintreeFaultRegistry).toEqual({});
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

  // A stub answers the channel in place of its handler. The wrapper treats a returned
  // StubbedInvoke as "return this, do not run the listener", so the contract here is that
  // stub faults — and only stub faults — produce one.
  it("applyInvokeFault returns the stubbed value for stub faults, including falsy ones", async () => {
    const { initFaultRegistry, setFault, applyInvokeFault } = await loadRegistry();
    initFaultRegistry();
    const roster = { claude: "ready", codex: "missing" };
    setFault("ch", { kind: "stub", value: roster });
    await expect(applyInvokeFault("ch")).resolves.toEqual({ value: roster });

    // Falsy and undefined values are still stubs: the caller must not mistake them for
    // "no fault, run the real handler".
    setFault("zero", { kind: "stub", value: 0 });
    await expect(applyInvokeFault("zero")).resolves.toEqual({ value: 0 });
    setFault("nil", { kind: "stub", value: undefined });
    await expect(applyInvokeFault("nil")).resolves.toEqual({ value: undefined });
  });

  it("applyInvokeFault holds a delayed stub back before answering", async () => {
    const { initFaultRegistry, setFault, applyInvokeFault } = await loadRegistry();
    initFaultRegistry();
    setFault("ch", { kind: "stub", value: "later", delayMs: 50 });
    const start = Date.now();
    const result = await applyInvokeFault("ch");
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    expect(result).toEqual({ value: "later" });
  });

  it("clearing a stub lets the real handler run again", async () => {
    const { initFaultRegistry, setFault, clearFault, applyInvokeFault } = await loadRegistry();
    initFaultRegistry();
    setFault("ch", { kind: "stub", value: 1 });
    clearFault("ch");
    await expect(applyInvokeFault("ch")).resolves.toBeUndefined();
  });
});

describe("faultRegistry (env disabled)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("DAINTREE_E2E_FAULT_MODE", "");
    globalThis.__daintreeFaultRegistry = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.__daintreeFaultRegistry = undefined;
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
    expect(globalThis.__daintreeFaultRegistry).toBeUndefined();
  });

  it("getFault returns undefined", async () => {
    const { getFault } = await loadRegistry();
    expect(getFault("anything")).toBeUndefined();
  });

  it("applyInvokeFault ignores a stub that somehow reached the registry", async () => {
    // The gate is the env flag, not the registry's emptiness: even a hand-populated
    // registry must not let a stub short-circuit a real handler outside fault mode.
    globalThis.__daintreeFaultRegistry = { ch: { kind: "stub", value: "leaked" } };
    const { applyInvokeFault } = await loadRegistry();
    await expect(applyInvokeFault("ch")).resolves.toBeUndefined();
  });

  it("setFault is a no-op", async () => {
    const { setFault } = await loadRegistry();
    setFault("ch", { kind: "error", message: "nope" });
    expect(globalThis.__daintreeFaultRegistry).toBeUndefined();
  });

  it("applyInvokeFault resolves immediately", async () => {
    const { applyInvokeFault } = await loadRegistry();
    await expect(applyInvokeFault("ch")).resolves.toBeUndefined();
  });
});
