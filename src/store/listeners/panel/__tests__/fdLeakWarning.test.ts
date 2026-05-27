// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));

import { logWarn } from "@/utils/logger";
import { setupFdLeakWarningListeners, _resetFdLeakWarningCooldown } from "../fdLeakWarning";

let onFdLeakWarningCb: ((data: unknown) => void) | null = null;

beforeEach(() => {
  onFdLeakWarningCb = null;
  vi.clearAllMocks();
  _resetFdLeakWarningCooldown();

  vi.stubGlobal("electron", {
    terminal: {
      onFdLeakWarning: (cb: (data: unknown) => void) => {
        onFdLeakWarningCb = cb;
        return () => {
          onFdLeakWarningCb = null;
        };
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const makePayload = (overrides = {}) => ({
  fdCount: 50,
  activeTerminals: 5,
  estimatedLeaked: 30,
  orphanedPids: [] as number[],
  ptmxLimit: 511,
  timestamp: Date.now(),
  ...overrides,
});

describe("setupFdLeakWarningListeners", () => {
  it("logs the first warning without notifying the user", () => {
    const d = setupFdLeakWarningListeners();
    const payload = makePayload();
    onFdLeakWarningCb!(payload);
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("[TerminalDiagnostics] FD leak warning"),
      { data: payload }
    );
    d.dispose();
  });

  it("suppresses repeat logs within cooldown period", () => {
    const d = setupFdLeakWarningListeners();
    onFdLeakWarningCb!(makePayload());
    expect(logWarn).toHaveBeenCalledTimes(1);

    onFdLeakWarningCb!(makePayload());
    expect(logWarn).toHaveBeenCalledTimes(1);

    d.dispose();
  });

  it("includes ptmxLimit percentage in log message", () => {
    const d = setupFdLeakWarningListeners();
    onFdLeakWarningCb!(makePayload({ fdCount: 400, ptmxLimit: 511 }));
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("78% of limit"),
      expect.any(Object)
    );
    d.dispose();
  });

  it("omits percentage when ptmxLimit is null", () => {
    const d = setupFdLeakWarningListeners();
    onFdLeakWarningCb!(makePayload({ ptmxLimit: null }));
    expect(logWarn).toHaveBeenCalledWith(
      expect.not.stringContaining("of limit"),
      expect.any(Object)
    );
    d.dispose();
  });

  it("includes orphaned pids when present", () => {
    const d = setupFdLeakWarningListeners();
    onFdLeakWarningCb!(makePayload({ orphanedPids: [123, 456] }));
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("orphaned PIDs: 123, 456"),
      expect.any(Object)
    );
    d.dispose();
  });
});
