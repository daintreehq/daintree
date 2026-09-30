import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProcessDetector,
  SHELL_COMMAND_EXPIRY_MS,
  SHELL_COMMAND_STICKY_MS,
  resolveShellCommandTimers,
} from "../ProcessDetector.js";

vi.mock("../../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

function createCacheMock() {
  const listeners = new Set<() => void>();
  const children = new Map<number, { pid: number; comm: string; command: string }[]>();
  return {
    getChildren: vi.fn((pid: number) => children.get(pid) ?? []),
    getLastError: vi.fn(() => null),
    onRefresh: vi.fn((callback: () => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }),
    emitRefresh() {
      for (const callback of listeners) callback();
    },
  };
}

function stubE2E(expiry: string | undefined, { packaged = "0", mode = "1" } = {}) {
  vi.stubEnv("DAINTREE_E2E_MODE", mode);
  vi.stubEnv("DAINTREE_IS_PACKAGED", packaged);
  vi.stubEnv("DAINTREE_E2E_SHELL_COMMAND_EXPIRY_MS", expiry);
}

function expiryMarkers(log: { mock: { calls: unknown[][] } }): string[] {
  return log.mock.calls
    .map((args) => String(args[0]))
    .filter((message) => message.startsWith("[E2E] shell-evidence-expired"));
}

describe("resolveShellCommandTimers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the product timers when no override is set", () => {
    stubE2E(undefined);
    expect(resolveShellCommandTimers()).toEqual({
      stickyMs: SHELL_COMMAND_STICKY_MS,
      expiryMs: SHELL_COMMAND_EXPIRY_MS,
      overridden: false,
    });
  });

  it("honours the override in an unpackaged E2E launch and clamps sticky to it", () => {
    stubE2E("3000");
    expect(resolveShellCommandTimers()).toEqual({
      stickyMs: 3000,
      expiryMs: 3000,
      overridden: true,
    });
  });

  it("keeps the product sticky window when the override is longer than it", () => {
    stubE2E("20000");
    expect(resolveShellCommandTimers()).toEqual({
      stickyMs: SHELL_COMMAND_STICKY_MS,
      expiryMs: 20_000,
      overridden: true,
    });
  });

  it.each([
    ["outside E2E mode", { mode: "" }],
    ["in a packaged build", { packaged: "1" }],
    ["when packaged state is unknown", { packaged: "" }],
  ])("ignores the override %s", (_label, gate) => {
    stubE2E("3000", gate);
    expect(resolveShellCommandTimers()).toMatchObject({
      expiryMs: SHELL_COMMAND_EXPIRY_MS,
      overridden: false,
    });
  });

  it.each(["", "abc", "-5", "1.5", "0", "99", "600001"])("ignores invalid value %j", (raw) => {
    stubE2E(raw);
    expect(resolveShellCommandTimers().overridden).toBe(false);
  });
});

describe("ProcessDetector shell-command expiry override", () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    log.mockRestore();
  });

  function startDetector(id: string) {
    const base = Date.now();
    vi.setSystemTime(base);
    const cache = createCacheMock();
    const callback = vi.fn();
    const detector = new ProcessDetector(id, base, 100, callback, cache as never);
    detector.start();
    return { base, cache, callback, detector };
  }

  function lastIcon(callback: ReturnType<typeof vi.fn>): string | undefined {
    const calls = callback.mock.calls;
    return calls[calls.length - 1]?.[0]?.processIconId;
  }

  it("expires non-agent shell evidence at the overridden boundary", () => {
    stubE2E("3000");
    const { base, cache, callback, detector } = startDetector("terminal-e2e-npm");
    detector.injectShellCommandEvidence({ processIconId: "npm", processName: "npm" }, "npm", base);
    expect(lastIcon(callback)).toBe("npm");

    vi.setSystemTime(base + 2_999);
    cache.emitRefresh();
    expect(lastIcon(callback)).toBe("npm");
    expect(expiryMarkers(log)).toEqual([]);

    vi.setSystemTime(base + 3_001);
    cache.emitRefresh();
    expect(lastIcon(callback)).toBeUndefined();
    expect(expiryMarkers(log)).toEqual([
      "[E2E] shell-evidence-expired term=terminal-e2e-npm agent=<none> action=clear",
    ]);
  });

  it("does not shorten the expiry without the E2E gate", () => {
    stubE2E("3000", { mode: "" });
    const { base, cache, callback, detector } = startDetector("terminal-prod-npm");
    detector.injectShellCommandEvidence({ processIconId: "npm", processName: "npm" }, "npm", base);

    vi.setSystemTime(base + 3_001);
    cache.emitRefresh();
    expect(lastIcon(callback)).toBe("npm");

    vi.setSystemTime(base + SHELL_COMMAND_EXPIRY_MS + 1);
    cache.emitRefresh();
    expect(lastIcon(callback)).toBeUndefined();
    expect(expiryMarkers(log)).toEqual([]);
  });

  it("retains agent evidence past the overridden expiry and reports it once", () => {
    stubE2E("3000");
    const { base, cache, detector } = startDetector("terminal-e2e-agent");
    detector.injectShellCommandEvidence(
      { agentType: "claude", processIconId: "claude", processName: "claude" },
      "claude",
      base
    );
    expect(detector.getLastDetected()).toBe("claude");

    vi.setSystemTime(base + 3_001);
    cache.emitRefresh();
    cache.emitRefresh();
    vi.setSystemTime(base + 9_000);
    cache.emitRefresh();

    expect(detector.getLastDetected()).toBe("claude");
    expect(expiryMarkers(log)).toEqual([
      "[E2E] shell-evidence-expired term=terminal-e2e-agent agent=claude action=retain",
    ]);
  });
});
