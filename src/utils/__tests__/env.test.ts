// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getCanopyEnv, isCanopyEnvEnabled } from "../env";

type WindowWithBridge = Window &
  typeof globalThis & {
    __CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS__?: boolean;
  };

describe("getCanopyEnv / isCanopyEnvEnabled", () => {
  const originalViteEnv = { ...import.meta.env };

  beforeEach(() => {
    delete (window as WindowWithBridge).__CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS__;
    vi.stubEnv("CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS", "");
    vi.stubEnv("CANOPY_VERBOSE", "");
    vi.stubEnv("CANOPY_PERF_CAPTURE", "");
  });

  afterEach(() => {
    delete (window as WindowWithBridge).__CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS__;
    vi.unstubAllEnvs();
    Object.assign(import.meta.env, originalViteEnv);
  });

  it("returns true for CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS when the runtime window bridge is set", () => {
    (window as WindowWithBridge).__CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS__ = true;
    expect(isCanopyEnvEnabled("CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS")).toBe(true);
    expect(getCanopyEnv("CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS")).toBe("1");
  });

  it("runtime window bridge takes precedence over import.meta.env", () => {
    (window as WindowWithBridge).__CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS__ = true;
    vi.stubEnv("CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS", "0");
    expect(isCanopyEnvEnabled("CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS")).toBe(true);
  });

  it("falls back to import.meta.env when the bridge is absent", () => {
    vi.stubEnv("CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS", "1");
    expect(isCanopyEnvEnabled("CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS")).toBe(true);
  });

  it("returns false when neither the bridge nor import.meta.env is set to '1'", () => {
    expect(isCanopyEnvEnabled("CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS")).toBe(false);
  });

  it("ignores a bridge value that is not literal true", () => {
    (window as unknown as Record<string, unknown>).__CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS__ = "1";
    expect(isCanopyEnvEnabled("CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS")).toBe(false);
  });

  it("does not consult the runtime bridge for other keys", () => {
    // Even if someone set a bridge-like global, non-E2E keys must not read it.
    (window as unknown as Record<string, unknown>).__CANOPY_VERBOSE__ = true;
    vi.stubEnv("CANOPY_VERBOSE", "1");
    expect(isCanopyEnvEnabled("CANOPY_VERBOSE")).toBe(true);

    vi.stubEnv("CANOPY_VERBOSE", "");
    expect(isCanopyEnvEnabled("CANOPY_VERBOSE")).toBe(false);
  });
});
