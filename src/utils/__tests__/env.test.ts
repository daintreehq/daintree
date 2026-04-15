// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDaintreeEnv, isDaintreeEnvEnabled } from "../env";

type WindowWithBridge = Window &
  typeof globalThis & {
    __DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS__?: boolean;
  };

describe("getDaintreeEnv / isDaintreeEnvEnabled", () => {
  const originalViteEnv = { ...import.meta.env };

  beforeEach(() => {
    delete (window as WindowWithBridge).__DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS__;
    vi.stubEnv("DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS", "");
    vi.stubEnv("DAINTREE_VERBOSE", "");
    vi.stubEnv("DAINTREE_PERF_CAPTURE", "");
  });

  afterEach(() => {
    delete (window as WindowWithBridge).__DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS__;
    vi.unstubAllEnvs();
    Object.assign(import.meta.env, originalViteEnv);
  });

  it("returns true for DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS when the runtime window bridge is set", () => {
    (window as WindowWithBridge).__DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS__ = true;
    expect(isDaintreeEnvEnabled("DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS")).toBe(true);
    expect(getDaintreeEnv("DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS")).toBe("1");
  });

  it("runtime window bridge takes precedence over import.meta.env", () => {
    (window as WindowWithBridge).__DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS__ = true;
    vi.stubEnv("DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS", "0");
    expect(isDaintreeEnvEnabled("DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS")).toBe(true);
  });

  it("falls back to import.meta.env when the bridge is absent", () => {
    vi.stubEnv("DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS", "1");
    expect(isDaintreeEnvEnabled("DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS")).toBe(true);
  });

  it("returns false when neither the bridge nor import.meta.env is set to '1'", () => {
    expect(isDaintreeEnvEnabled("DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS")).toBe(false);
  });

  it("ignores a bridge value that is not literal true", () => {
    (window as unknown as Record<string, unknown>).__DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS__ = "1";
    expect(isDaintreeEnvEnabled("DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS")).toBe(false);
  });

  it("does not consult the runtime bridge for other keys", () => {
    // Even if someone set a bridge-like global, non-E2E keys must not read it.
    (window as unknown as Record<string, unknown>).__DAINTREE_VERBOSE__ = true;
    vi.stubEnv("DAINTREE_VERBOSE", "1");
    expect(isDaintreeEnvEnabled("DAINTREE_VERBOSE")).toBe(true);

    vi.stubEnv("DAINTREE_VERBOSE", "");
    expect(isDaintreeEnvEnabled("DAINTREE_VERBOSE")).toBe(false);
  });
});
