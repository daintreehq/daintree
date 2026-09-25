import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runSession = vi.hoisted(() => vi.fn());

vi.mock("../CodexAppServerClient.js", async () => {
  const actual = await vi.importActual<typeof import("../CodexAppServerClient.js")>(
    "../CodexAppServerClient.js"
  );
  return { ...actual, runCodexAppServerSession: runSession };
});

import { CodexAppServerError } from "../CodexAppServerClient.js";
import {
  normalizeCodexRateLimits,
  readCodexQuota,
  resetCodexQuotaCacheForTests,
} from "../CodexQuotaService.js";

type Call = (method: string, params?: unknown) => Promise<unknown>;

function respondWith(reply: () => unknown) {
  runSession.mockImplementation(async (run: (call: Call) => Promise<unknown>) =>
    run(async (method) => {
      if (method !== "account/rateLimits/read") throw new Error(`unexpected ${method}`);
      return reply();
    })
  );
}

const FIVE_HOURS = { usedPercent: 42.4, windowDurationMins: 300, resetsAt: 1_700_000_000 };
const WEEK = { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1_700_500_000 };

describe("normalizeCodexRateLimits", () => {
  it("converts reset seconds to ms and orders windows by duration, not slot", () => {
    const result = normalizeCodexRateLimits(
      { rateLimits: { primary: WEEK, secondary: FIVE_HOURS, planType: "plus" } },
      5
    );
    expect(result).toEqual({
      status: "ok",
      planType: "plus",
      fetchedAt: 5,
      windows: [
        { usedPercent: 42.4, windowDurationMins: 300, resetsAt: 1_700_000_000_000 },
        { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1_700_500_000_000 },
      ],
    });
  });

  it("keeps a lone window when the other is null", () => {
    const result = normalizeCodexRateLimits(
      { rateLimits: { primary: null, secondary: WEEK, planType: null } },
      1
    );
    expect(result).toMatchObject({ status: "ok", planType: null });
    expect(result.status === "ok" && result.windows).toHaveLength(1);
  });

  it("reports a real 0% as 0, and a missing reset as null", () => {
    const result = normalizeCodexRateLimits(
      { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } },
      1
    );
    expect(result.status === "ok" && result.windows[0]).toEqual({
      usedPercent: 0,
      windowDurationMins: 300,
      resetsAt: null,
    });
  });

  it("never fabricates a zero when no window was sent", () => {
    expect(normalizeCodexRateLimits({ rateLimits: { primary: null, secondary: null } }, 1)).toEqual(
      { status: "unavailable", reason: "no-windows", fetchedAt: 1 }
    );
  });

  it.each([
    ["a non-object", "nope"],
    ["no rateLimits", {}],
    ["a window without a percentage", { rateLimits: { primary: { windowDurationMins: 300 } } }],
    [
      "a window with a non-positive duration",
      { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 0 } } },
    ],
    [
      "one unreadable window beside a good one",
      { rateLimits: { primary: FIVE_HOURS, secondary: { usedPercent: "x" } } },
    ],
  ])("treats %s as unsupported", (_label, raw) => {
    expect(normalizeCodexRateLimits(raw, 1)).toMatchObject({
      status: "unavailable",
      reason: "unsupported-response",
    });
  });

  it("caps a reported overage at 100%", () => {
    const result = normalizeCodexRateLimits(
      { rateLimits: { primary: { usedPercent: 130, windowDurationMins: 300 } } },
      1
    );
    expect(result.status === "ok" && result.windows[0].usedPercent).toBe(100);
  });
});

describe("readCodexQuota", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    runSession.mockReset();
    resetCodexQuotaCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps transport failures to unavailable reasons instead of rejecting", async () => {
    runSession.mockRejectedValueOnce(new CodexAppServerError("cli-missing", "no codex"));
    await expect(readCodexQuota()).resolves.toMatchObject({ reason: "cli-missing" });

    resetCodexQuotaCacheForTests();
    runSession.mockRejectedValueOnce(new CodexAppServerError("timeout", "slow"));
    await expect(readCodexQuota()).resolves.toMatchObject({ reason: "timeout" });

    resetCodexQuotaCacheForTests();
    // What a signed-out or API-key session gets back.
    runSession.mockRejectedValueOnce(
      new CodexAppServerError("protocol-error", "Codex app-server: not logged in")
    );
    await expect(readCodexQuota()).resolves.toMatchObject({
      status: "unavailable",
      reason: "read-failed",
    });
  });

  it("shares one session between concurrent callers", async () => {
    respondWith(() => ({ rateLimits: { primary: FIVE_HOURS } }));
    const [a, b] = await Promise.all([readCodexQuota(), readCodexQuota()]);
    expect(a).toBe(b);
    expect(runSession).toHaveBeenCalledTimes(1);
  });

  it("serves the cache for 30s, then reads again", async () => {
    respondWith(() => ({ rateLimits: { primary: FIVE_HOURS } }));
    const first = await readCodexQuota();
    vi.advanceTimersByTime(29_000);
    expect(await readCodexQuota()).toBe(first);
    expect(runSession).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    const second = await readCodexQuota();
    expect(runSession).toHaveBeenCalledTimes(2);
    expect(second.fetchedAt).toBeGreaterThan(first.fetchedAt);
  });
});
