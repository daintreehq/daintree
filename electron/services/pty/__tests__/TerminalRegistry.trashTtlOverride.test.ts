import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRegistry, resolveTrashTtlMs } from "../TerminalRegistry.js";
import { TRASH_TTL_MS } from "../types.js";
import type { TerminalProcess } from "../TerminalProcess.js";

function stubE2E(ttl: string | undefined, { packaged = "0", mode = "1" } = {}) {
  vi.stubEnv("DAINTREE_E2E_MODE", mode);
  vi.stubEnv("DAINTREE_IS_PACKAGED", packaged);
  vi.stubEnv("DAINTREE_E2E_TRASH_TTL_MS", ttl);
}

describe("resolveTrashTtlMs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the product TTL without an override", () => {
    stubE2E(undefined);
    expect(resolveTrashTtlMs()).toBe(TRASH_TTL_MS);
  });

  it("honours the override in an unpackaged E2E launch", () => {
    stubE2E("3000");
    expect(resolveTrashTtlMs()).toBe(3000);
  });

  it.each([
    ["outside E2E mode", { mode: "" }],
    ["in a packaged build", { packaged: "1" }],
  ])("ignores the override %s", (_label, gate) => {
    stubE2E("3000", gate);
    expect(resolveTrashTtlMs()).toBe(TRASH_TTL_MS);
  });

  it("ignores a malformed override", () => {
    stubE2E("soon");
    expect(resolveTrashTtlMs()).toBe(TRASH_TTL_MS);
  });
});

describe("TerminalRegistry trash TTL override", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function trashOne(registry: TerminalRegistry): ReturnType<typeof vi.fn> {
    registry.add("t1", {} as unknown as TerminalProcess);
    const onExpire = vi.fn();
    registry.trash("t1", onExpire);
    return onExpire;
  }

  it("kills a trashed terminal at the overridden TTL when constructed with defaults", () => {
    stubE2E("3000");
    const registry = new TerminalRegistry();
    const onExpire = trashOne(registry);

    vi.advanceTimersByTime(2_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledWith("t1");
  });

  it("keeps the product TTL without the E2E gate", () => {
    stubE2E("3000", { mode: "" });
    const registry = new TerminalRegistry();
    const onExpire = trashOne(registry);

    vi.advanceTimersByTime(3_000);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TRASH_TTL_MS - 3_000);
    expect(onExpire).toHaveBeenCalledWith("t1");
  });
});
