import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../store.js", () => ({
  store: { get: vi.fn() },
}));

vi.mock("electron", () => ({
  nativeTheme: { shouldUseDarkColors: true },
}));

import {
  E2E_FAULT_MODE_ARG,
  E2E_MODE_ARG,
  E2E_SKIP_FIRST_RUN_DIALOGS_ARG,
  resolveE2EPreloadArgs,
} from "../skeletonCss.js";

describe("resolveE2EPreloadArgs", () => {
  const originalMode = process.env.DAINTREE_E2E_MODE;
  const originalSkip = process.env.DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS;
  const originalFault = process.env.DAINTREE_E2E_FAULT_MODE;
  const originalArgv = process.argv;

  beforeEach(() => {
    delete process.env.DAINTREE_E2E_MODE;
    delete process.env.DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS;
    delete process.env.DAINTREE_E2E_FAULT_MODE;
    process.argv = originalArgv.slice(0, 2);
  });

  afterEach(() => {
    restoreEnv("DAINTREE_E2E_MODE", originalMode);
    restoreEnv("DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS", originalSkip);
    restoreEnv("DAINTREE_E2E_FAULT_MODE", originalFault);
    process.argv = originalArgv;
  });

  it("omits all flags outside E2E", () => {
    expect(resolveE2EPreloadArgs()).toEqual([]);
  });

  it("threads exact E2E env flags into argv-safe preload switches", () => {
    process.env.DAINTREE_E2E_MODE = "1";
    process.env.DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS = "1";
    process.env.DAINTREE_E2E_FAULT_MODE = "1";

    expect(resolveE2EPreloadArgs()).toEqual([
      "--daintree-e2e-mode",
      "--daintree-e2e-skip-first-run-dialogs",
      "--daintree-e2e-fault-mode",
    ]);
  });

  it("preserves E2E argv switches when production build strips env reads", () => {
    process.argv.push(
      "--daintree-e2e-mode",
      "--daintree-e2e-skip-first-run-dialogs",
      "--daintree-e2e-fault-mode"
    );

    expect(resolveE2EPreloadArgs()).toEqual([
      "--daintree-e2e-mode",
      "--daintree-e2e-skip-first-run-dialogs",
      "--daintree-e2e-fault-mode",
    ]);
  });

  it("rejects truthy-but-not-exact env values", () => {
    process.env.DAINTREE_E2E_MODE = "true";
    process.env.DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS = "yes";
    process.env.DAINTREE_E2E_FAULT_MODE = "on";

    expect(resolveE2EPreloadArgs()).toEqual([]);
  });

  it("matches the prefixes preload.cts parses", () => {
    expect(E2E_MODE_ARG).toBe("--daintree-e2e-mode");
    expect(E2E_SKIP_FIRST_RUN_DIALOGS_ARG).toBe("--daintree-e2e-skip-first-run-dialogs");
    expect(E2E_FAULT_MODE_ARG).toBe("--daintree-e2e-fault-mode");
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
