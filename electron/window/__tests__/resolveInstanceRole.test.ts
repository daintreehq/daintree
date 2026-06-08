import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests resolveInstanceRole from skeletonCss.ts — the helper that seeds each
 * renderer with the worker/attended instance role via
 * webPreferences.additionalArguments (#10123). Worker instances suppress
 * automatic background GitHub polling; the default must always be attended.
 */

vi.mock("../../store.js", () => ({
  store: { get: vi.fn() },
}));

vi.mock("electron", () => ({
  nativeTheme: { shouldUseDarkColors: true },
}));

import { resolveInstanceRole, INSTANCE_ROLE_ARG } from "../skeletonCss.js";

describe("resolveInstanceRole (#10123)", () => {
  const originalRole = process.env.DAINTREE_INSTANCE_ROLE;

  beforeEach(() => {
    delete process.env.DAINTREE_INSTANCE_ROLE;
  });

  afterEach(() => {
    if (originalRole === undefined) {
      delete process.env.DAINTREE_INSTANCE_ROLE;
    } else {
      process.env.DAINTREE_INSTANCE_ROLE = originalRole;
    }
  });

  it("defaults to attended when the env var is unset", () => {
    expect(resolveInstanceRole()).toBe("attended");
  });

  it("returns worker only for the exact value 'worker'", () => {
    process.env.DAINTREE_INSTANCE_ROLE = "worker";
    expect(resolveInstanceRole()).toBe("worker");
  });

  it("normalizes malformed values to attended", () => {
    for (const value of ["Worker", "WORKER", " worker", "worker ", "1", "true", ""]) {
      process.env.DAINTREE_INSTANCE_ROLE = value;
      expect(resolveInstanceRole()).toBe("attended");
    }
  });

  it("matches the prefix preload.cts parses (drift guard)", () => {
    // preload.cts hardcodes this literal rather than importing the constant
    // (esbuild cross-bundle); this ties both halves of the contract together
    // so a rename of INSTANCE_ROLE_ARG fails loudly instead of silently
    // leaving every instance in attended mode (#10123).
    expect(`${INSTANCE_ROLE_ARG}=`).toBe("--daintree-instance-role=");
  });

  it("produces a whitespace-free argv flag", () => {
    process.env.DAINTREE_INSTANCE_ROLE = "worker";
    const arg = `${INSTANCE_ROLE_ARG}=${resolveInstanceRole()}`;
    expect(arg).toBe("--daintree-instance-role=worker");
    expect(arg).not.toMatch(/\s/);
  });
});
