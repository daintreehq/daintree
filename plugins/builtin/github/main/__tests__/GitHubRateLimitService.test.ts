import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  gitHubRateLimitService,
  computeThrottleMultiplier,
  INTERACTIVE_RESERVE,
  MAX_THROTTLE_MULTIPLIER,
} from "../GitHubRateLimitService.js";
import type { GitHubRateLimitPayload } from "../../shared/types.js";

vi.mock("fs", () => ({
  appendFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === "userData") return "/mock/user/data";
      throw new Error(`Unexpected getPath arg: ${name}`);
    }),
  },
}));

const mockedAppendFileSync = vi.mocked(appendFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

function makeHeaders(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

const ONE_HOUR_MS = 60 * 60 * 1000;

/** Build a GraphQL `rateLimit`-carrying payload with a reset one hour out. */
function graphQLData(remaining: number, limit?: number): Record<string, unknown> {
  return {
    rateLimit: {
      cost: 1,
      remaining,
      resetAt: new Date(Date.now() + ONE_HOUR_MS).toISOString(),
      ...(limit !== undefined ? { limit } : {}),
    },
  };
}

describe("GitHubRateLimitService", () => {
  const listener = vi.fn<(state: GitHubRateLimitPayload) => void>();
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    gitHubRateLimitService._resetForTests();
    listener.mockClear();
    unsubscribe = gitHubRateLimitService.onStateChange(listener);
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
  });

  describe("update()", () => {
    it("marks a secondary block when retry-after is present", () => {
      gitHubRateLimitService.update(makeHeaders({ "retry-after": "30" }), 403);

      const block = gitHubRateLimitService.shouldBlockRequest();
      expect(block.blocked).toBe(true);
      expect(block.reason).toBe("secondary");
      expect(block.resumeAt).toBeGreaterThan(Date.now() + 25_000);
      expect(block.resumeAt).toBeLessThanOrEqual(Date.now() + 30_500);
    });

    it("prefers retry-after over x-ratelimit-remaining=0", () => {
      gitHubRateLimitService.update(
        makeHeaders({
          "retry-after": "15",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3_600),
        }),
        429
      );

      const block = gitHubRateLimitService.shouldBlockRequest();
      expect(block.reason).toBe("secondary");
    });

    it("marks a primary block when x-ratelimit-remaining is 0", () => {
      const resetSeconds = Math.floor(Date.now() / 1000) + 600;
      gitHubRateLimitService.update(
        makeHeaders({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetSeconds),
        }),
        200
      );

      const block = gitHubRateLimitService.shouldBlockRequest();
      expect(block.blocked).toBe(true);
      expect(block.reason).toBe("primary");
      expect(block.resumeAt).toBeGreaterThanOrEqual(resetSeconds * 1000);
      expect(block.resumeAt).toBeLessThanOrEqual(resetSeconds * 1000 + 10_000);
    });

    it("falls back to secondary on 403 with abuse-limit body when no retry-after", () => {
      gitHubRateLimitService.update(
        makeHeaders({ "x-ratelimit-remaining": "100" }),
        403,
        "You have exceeded a secondary rate limit. Please wait a few minutes before you try again."
      );

      const block = gitHubRateLimitService.shouldBlockRequest();
      expect(block.blocked).toBe(true);
      expect(block.reason).toBe("secondary");
      expect(block.resumeAt).toBeGreaterThan(Date.now() + 50_000);
    });

    it("clears only the matching resource on 2xx with remaining > 0 and x-ratelimit-resource header", () => {
      gitHubRateLimitService.update(makeHeaders({ "retry-after": "30" }), 429);
      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(true);

      // 2xx with x-ratelimit-resource header — clears only that resource.
      // Since the secondary block is under __global__ (not the resource in the header),
      // it is not affected. The service stays blocked.
      gitHubRateLimitService.update(
        makeHeaders({
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3_600),
          "x-ratelimit-resource": "core",
        }),
        200
      );

      // Secondary block is still active — 2xx on "core" doesn't clear __global__.
      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(true);
    });

    it("does not mark a block when no headers suggest a limit", () => {
      gitHubRateLimitService.update(makeHeaders({}), 200);
      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(false);
    });

    it("parses http-date retry-after values", () => {
      const future = new Date(Date.now() + 45_000).toUTCString();
      gitHubRateLimitService.update(makeHeaders({ "retry-after": future }), 429);

      const block = gitHubRateLimitService.shouldBlockRequest();
      expect(block.blocked).toBe(true);
      expect(block.reason).toBe("secondary");
      expect(block.resumeAt).toBeGreaterThan(Date.now() + 30_000);
    });
  });

  describe("shouldBlockRequest()", () => {
    it("auto-clears expired blocks", () => {
      // Primary reset in the past (minus even the buffer).
      gitHubRateLimitService.update(
        makeHeaders({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) - 120),
        }),
        200
      );

      const block = gitHubRateLimitService.shouldBlockRequest();
      expect(block.blocked).toBe(false);
    });
  });

  describe("proactive block expiry timer", () => {
    it("clears the block on its own when the reset elapses without any lazy call", () => {
      vi.useFakeTimers();
      try {
        const resetSeconds = Math.floor(Date.now() / 1000) + 60;
        gitHubRateLimitService.update(
          makeHeaders({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetSeconds),
            "x-ratelimit-resource": "core",
          }),
          200
        );
        listener.mockClear();

        vi.advanceTimersByTime(60_000 + 7_500);

        expect(listener).toHaveBeenCalledWith(
          expect.objectContaining({ blocked: false, kind: null })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-arms to the next-soonest expiry after the first block clears", () => {
      vi.useFakeTimers();
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        gitHubRateLimitService.update(
          makeHeaders({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(nowSec + 60),
            "x-ratelimit-resource": "core",
          }),
          200
        );
        gitHubRateLimitService.update(
          makeHeaders({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(nowSec + 600),
            "x-ratelimit-resource": "graphql",
          }),
          200
        );
        listener.mockClear();

        vi.advanceTimersByTime(60_000 + 7_500);

        expect(gitHubRateLimitService.shouldBlockRequest("core").blocked).toBe(false);
        expect(gitHubRateLimitService.shouldBlockRequest("graphql").blocked).toBe(true);

        listener.mockClear();
        vi.advanceTimersByTime(540_000);

        expect(gitHubRateLimitService.shouldBlockRequest("graphql").blocked).toBe(false);
        expect(listener).toHaveBeenCalledWith(
          expect.objectContaining({ blocked: false, kind: null })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not fire stale callbacks after clear()", () => {
      vi.useFakeTimers();
      try {
        gitHubRateLimitService.update(
          makeHeaders({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
            "x-ratelimit-resource": "core",
          }),
          200
        );
        gitHubRateLimitService.clear();
        listener.mockClear();

        vi.advanceTimersByTime(120_000);

        expect(listener).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-arms to an earlier time when the same resource is re-blocked sooner", () => {
      vi.useFakeTimers();
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        gitHubRateLimitService.update(
          makeHeaders({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(nowSec + 600),
            "x-ratelimit-resource": "core",
          }),
          200
        );
        gitHubRateLimitService.update(
          makeHeaders({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(nowSec + 60),
            "x-ratelimit-resource": "core",
          }),
          200
        );

        vi.advanceTimersByTime(60_000 + 7_500);

        expect(gitHubRateLimitService.shouldBlockRequest("core").blocked).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not clear early when the same resource is re-blocked later", () => {
      vi.useFakeTimers();
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        gitHubRateLimitService.update(
          makeHeaders({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(nowSec + 60),
            "x-ratelimit-resource": "core",
          }),
          200
        );
        gitHubRateLimitService.update(
          makeHeaders({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(nowSec + 600),
            "x-ratelimit-resource": "core",
          }),
          200
        );

        vi.advanceTimersByTime(60_000 + 7_500);

        expect(gitHubRateLimitService.shouldBlockRequest("core").blocked).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clearResource() cancels the pending block timer", () => {
      vi.useFakeTimers();
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        gitHubRateLimitService.update(
          makeHeaders({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(nowSec + 60),
            "x-ratelimit-resource": "core",
          }),
          200
        );
        gitHubRateLimitService.update(
          makeHeaders({
            "x-ratelimit-remaining": "4999",
            "x-ratelimit-reset": String(nowSec + 3600),
            "x-ratelimit-resource": "core",
          }),
          200
        );
        listener.mockClear();

        vi.advanceTimersByTime(120_000);

        expect(listener).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a later block does not delay an earlier block's timer", () => {
      vi.useFakeTimers();
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        gitHubRateLimitService.update(
          makeHeaders({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(nowSec + 60),
            "x-ratelimit-resource": "core",
          }),
          200
        );
        gitHubRateLimitService.update(
          makeHeaders({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(nowSec + 600),
            "x-ratelimit-resource": "graphql",
          }),
          200
        );

        vi.advanceTimersByTime(60_000 + 7_500);

        expect(gitHubRateLimitService.shouldBlockRequest("core").blocked).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("onStateChange listeners", () => {
    it("notifies on transition into blocked state", () => {
      gitHubRateLimitService.update(makeHeaders({ "retry-after": "30" }), 429);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ blocked: true, kind: "secondary" })
      );
    });

    it("notifies on clear()", () => {
      gitHubRateLimitService.update(makeHeaders({ "retry-after": "30" }), 429);
      listener.mockClear();
      gitHubRateLimitService.clear();
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ blocked: false }));
    });

    it("does not re-notify when a new update produces the same state", () => {
      const now = Math.floor(Date.now() / 1000);
      gitHubRateLimitService.update(
        makeHeaders({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now + 600) }),
        200
      );
      const initialCalls = listener.mock.calls.length;
      // Identical update: same kind, same resumeAt within 1s tolerance.
      gitHubRateLimitService.update(
        makeHeaders({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now + 600) }),
        200
      );
      expect(listener.mock.calls.length).toBe(initialCalls);
    });

    it("survives a misbehaving listener without breaking other listeners", () => {
      const good = vi.fn<(s: GitHubRateLimitPayload) => void>();
      gitHubRateLimitService.onStateChange(() => {
        throw new Error("boom");
      });
      gitHubRateLimitService.onStateChange(good);

      gitHubRateLimitService.update(makeHeaders({ "retry-after": "30" }), 429);

      expect(good).toHaveBeenCalledWith(
        expect.objectContaining({ blocked: true, kind: "secondary" })
      );
    });
  });

  describe("applyRemoteState()", () => {
    it("marks a block from a remote payload and notifies local listeners", () => {
      const resetAt = Date.now() + 45_000;
      gitHubRateLimitService.applyRemoteState({
        blocked: true,
        kind: "secondary",
        resetAt,
      });

      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(true);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ blocked: true, kind: "secondary" })
      );
    });

    it("clears local state when the remote payload is unblocked", () => {
      gitHubRateLimitService.update(makeHeaders({ "retry-after": "30" }), 429);
      listener.mockClear();

      gitHubRateLimitService.applyRemoteState({ blocked: false, kind: null });

      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(false);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ blocked: false }));
    });

    it("preserves resource identity from remote payload so resource-specific callers are gated", () => {
      const resetAt = Date.now() + 45_000;
      gitHubRateLimitService.applyRemoteState({
        blocked: true,
        kind: "primary",
        resetAt,
        resource: "graphql",
      });

      expect(gitHubRateLimitService.shouldBlockRequest("graphql").blocked).toBe(true);
      expect(gitHubRateLimitService.shouldBlockRequest("graphql").reason).toBe("primary");
    });

    it("falls back to __global__ when remote payload has no resource", () => {
      const resetAt = Date.now() + 45_000;
      gitHubRateLimitService.applyRemoteState({
        blocked: true,
        kind: "primary",
        resetAt,
      });

      // Without resource, stored under __global__ — gates all callers.
      expect(gitHubRateLimitService.shouldBlockRequest("graphql").blocked).toBe(true);
      expect(gitHubRateLimitService.shouldBlockRequest("core").blocked).toBe(true);
    });
  });

  describe("getState()", () => {
    it("reports unblocked when no state is active", () => {
      const state = gitHubRateLimitService.getState();
      expect(state).toEqual({ blocked: false, kind: null });
    });

    it("reports resumeAt and kind when blocked", () => {
      gitHubRateLimitService.update(makeHeaders({ "retry-after": "30" }), 429);
      const state = gitHubRateLimitService.getState();
      expect(state.blocked).toBe(true);
      expect(state.kind).toBe("secondary");
      expect(state.resetAt).toBeGreaterThan(Date.now());
    });
  });

  describe("updateFromGraphQL()", () => {
    it("marks primary block when remaining is 0", () => {
      const resetAt = new Date(Date.now() + 30_000).toISOString();
      gitHubRateLimitService.updateFromGraphQL({
        rateLimit: { cost: 1, remaining: 0, resetAt },
      });

      const block = gitHubRateLimitService.shouldBlockRequest();
      expect(block.blocked).toBe(true);
      expect(block.reason).toBe("primary");
    });

    it("does not block on a healthy budget", () => {
      gitHubRateLimitService.updateFromGraphQL(graphQLData(4995, 5000));

      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(false);
      const budget = gitHubRateLimitService._getBudgetStateForTests();
      expect(budget?.engaged).toBe(false);
      expect(budget?.multiplier).toBe(1);
    });

    it("ignores missing rateLimit object", () => {
      gitHubRateLimitService.updateFromGraphQL({ repository: {} });
      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(false);
    });

    it("ignores malformed rateLimit (missing fields)", () => {
      gitHubRateLimitService.updateFromGraphQL({ rateLimit: { cost: 1 } });
      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(false);
    });

    it("ignores non-numeric remaining", () => {
      gitHubRateLimitService.updateFromGraphQL({
        rateLimit: { remaining: "0", resetAt: new Date().toISOString() },
      });
      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(false);
    });

    it("hard-blocks at or below the hard-block threshold", () => {
      gitHubRateLimitService.updateFromGraphQL(graphQLData(30, 5000));

      const block = gitHubRateLimitService.shouldBlockRequest("graphql");
      expect(block.blocked).toBe(true);
      expect(block.reason).toBe("primary");
      expect(gitHubRateLimitService._getBudgetStateForTests()?.multiplier).toBe(
        MAX_THROTTLE_MULTIPLIER
      );
    });

    it("does not throttle without a reported limit", () => {
      gitHubRateLimitService.updateFromGraphQL(graphQLData(200));
      gitHubRateLimitService.updateFromGraphQL(graphQLData(200));

      // No `limit` → no depletion ratio → budget state never recorded.
      expect(gitHubRateLimitService._getBudgetStateForTests()).toBeNull();
    });

    it("does not engage the throttle on a single depleted reading", () => {
      gitHubRateLimitService.updateFromGraphQL(graphQLData(150, 5000));

      const budget = gitHubRateLimitService._getBudgetStateForTests();
      expect(budget?.engaged).toBe(false);
      expect(budget?.consecutiveDepletedReadings).toBe(1);
      expect(budget?.multiplier).toBe(1);
    });

    it("engages a graduated throttle after two consecutive depleted readings", () => {
      gitHubRateLimitService.updateFromGraphQL(graphQLData(150, 5000));
      gitHubRateLimitService.updateFromGraphQL(graphQLData(150, 5000));

      const budget = gitHubRateLimitService._getBudgetStateForTests();
      expect(budget?.engaged).toBe(true);
      // remaining 150, reserve 100 → 50 spendable over ~1h → ~2.4x cadence.
      expect(budget?.multiplier).toBeGreaterThan(1);
      expect(budget?.multiplier).toBeLessThanOrEqual(MAX_THROTTLE_MULTIPLIER);
      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(false);
    });

    it("releases the throttle once the budget recovers above the release ratio", () => {
      gitHubRateLimitService.updateFromGraphQL(graphQLData(150, 5000));
      gitHubRateLimitService.updateFromGraphQL(graphQLData(150, 5000));
      expect(gitHubRateLimitService._getBudgetStateForTests()?.engaged).toBe(true);

      // 3500 / 5000 = 70% — above the 60% release ratio.
      gitHubRateLimitService.updateFromGraphQL(graphQLData(3500, 5000));

      const budget = gitHubRateLimitService._getBudgetStateForTests();
      expect(budget?.engaged).toBe(false);
      expect(budget?.multiplier).toBe(1);
    });

    it("stays engaged within the hysteresis band (50–60%)", () => {
      gitHubRateLimitService.updateFromGraphQL(graphQLData(150, 5000));
      gitHubRateLimitService.updateFromGraphQL(graphQLData(150, 5000));

      // 2800 / 5000 = 56% — between engage (50%) and release (60%).
      gitHubRateLimitService.updateFromGraphQL(graphQLData(2800, 5000));

      expect(gitHubRateLimitService._getBudgetStateForTests()?.engaged).toBe(true);
    });

    it("carries remaining, limit, and throttleMultiplier in the pushed payload", () => {
      gitHubRateLimitService.updateFromGraphQL(graphQLData(150, 5000));
      gitHubRateLimitService.updateFromGraphQL(graphQLData(150, 5000));

      const state = gitHubRateLimitService.getState();
      expect(state.blocked).toBe(false);
      expect(state.remaining).toBe(150);
      expect(state.limit).toBe(5000);
      expect(state.throttleMultiplier).toBeGreaterThan(1);
    });

    it("does not re-notify on a sub-threshold budget reading", () => {
      gitHubRateLimitService.updateFromGraphQL(graphQLData(150, 5000));
      gitHubRateLimitService.updateFromGraphQL(graphQLData(150, 5000));
      const callsAfterEngage = listener.mock.calls.length;

      // Identical reading — multiplier unchanged, so no fresh notification.
      gitHubRateLimitService.updateFromGraphQL(graphQLData(150, 5000));

      expect(listener.mock.calls.length).toBe(callsAfterEngage);
    });

    it("snaps the throttle back when the budget window resets (passive sweep)", () => {
      vi.useFakeTimers();
      try {
        gitHubRateLimitService.updateFromGraphQL(graphQLData(150, 5000));
        gitHubRateLimitService.updateFromGraphQL(graphQLData(150, 5000));
        expect(gitHubRateLimitService._getBudgetStateForTests()?.engaged).toBe(true);
        listener.mockClear();

        // Advance past the window reset without any further GitHub call — the
        // one-shot sweep must clear the stale budget on its own.
        vi.advanceTimersByTime(ONE_HOUR_MS + 60_000);

        expect(gitHubRateLimitService._getBudgetStateForTests()).toBeNull();
        expect(listener).toHaveBeenCalledWith(
          expect.objectContaining({ blocked: false, kind: null })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    describe("per-query cost logging (DAINTREE_DEBUG_GITHUB_GRAPHQL)", () => {
      const label = "TEST_QUERY";
      const debugDir = join("/mock/user/data", "debug");
      const logPath = join(debugDir, "github-graphql-costs.log");
      let previousUserData: string | undefined;

      function setDebugEnv(value: string) {
        process.env.DAINTREE_DEBUG_GITHUB_GRAPHQL = value;
      }

      beforeEach(() => {
        previousUserData = process.env.DAINTREE_USER_DATA;
        process.env.DAINTREE_USER_DATA = "/mock/user/data";
        delete process.env.DAINTREE_DEBUG_GITHUB_GRAPHQL;
        mockedAppendFileSync.mockReset();
        mockedExistsSync.mockReset();
        mockedMkdirSync.mockReset();
        mockedExistsSync.mockReturnValue(true);
      });

      afterEach(() => {
        delete process.env.DAINTREE_DEBUG_GITHUB_GRAPHQL;
        if (previousUserData === undefined) {
          delete process.env.DAINTREE_USER_DATA;
        } else {
          process.env.DAINTREE_USER_DATA = previousUserData;
        }
      });

      it("does not write when env var is unset", () => {
        gitHubRateLimitService.updateFromGraphQL(graphQLData(4995, 5000), label);
        expect(mockedAppendFileSync).not.toHaveBeenCalled();
      });

      it("writes one log line when env var is set and label and cost are present", () => {
        setDebugEnv("1");
        const data = graphQLData(4995, 5000);
        gitHubRateLimitService.updateFromGraphQL(data, label);

        expect(mockedAppendFileSync).toHaveBeenCalledTimes(1);
        const call = mockedAppendFileSync.mock.calls[0];
        expect(call[0]).toBe(logPath);
        const line = call[1] as string;
        expect(line).toContain(`label="${label}"`);
        expect(line).toContain("cost=1");
        expect(line).toContain("remaining=4995");
        expect(line).toContain("limit=5000");
        expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
      });

      it("does not write when label is missing", () => {
        setDebugEnv("1");
        gitHubRateLimitService.updateFromGraphQL(graphQLData(4995, 5000));
        expect(mockedAppendFileSync).not.toHaveBeenCalled();
      });

      it("does not write when rateLimit.cost is missing", () => {
        setDebugEnv("1");
        const data = {
          rateLimit: {
            remaining: 4995,
            resetAt: new Date(Date.now() + ONE_HOUR_MS).toISOString(),
            limit: 5000,
          },
        };
        gitHubRateLimitService.updateFromGraphQL(data, label);
        expect(mockedAppendFileSync).not.toHaveBeenCalled();
        expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(false);
      });

      it("creates the debug directory if it does not exist", () => {
        setDebugEnv("1");
        mockedAppendFileSync.mockClear();
        mockedExistsSync.mockImplementation((p) => p !== debugDir);
        gitHubRateLimitService.updateFromGraphQL(graphQLData(4995, 5000), label);

        expect(mockedMkdirSync).toHaveBeenCalledWith(debugDir, { recursive: true });
        expect(mockedAppendFileSync).toHaveBeenCalled();
      });

      it("does not throw when appendFileSync throws", () => {
        setDebugEnv("1");
        mockedAppendFileSync.mockImplementation(() => {
          throw new Error("disk full");
        });

        expect(() =>
          gitHubRateLimitService.updateFromGraphQL(graphQLData(4995, 5000), label)
        ).not.toThrow();
        expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(false);
      });

      it("strips quotes and newlines from the label", () => {
        setDebugEnv("1");
        mockedAppendFileSync.mockClear();
        gitHubRateLimitService.updateFromGraphQL(graphQLData(4995, 5000), 'label"with\nquotes"');

        expect(mockedAppendFileSync).toHaveBeenCalled();
        const line = mockedAppendFileSync.mock.calls[0][1] as string;
        expect(line).toContain('label="labelwithquotes"');
      });
    });
  });

  describe("computeThrottleMultiplier()", () => {
    const now = Date.now();

    it("returns 1 for a healthy budget", () => {
      expect(computeThrottleMultiplier(4000, 5000, now + ONE_HOUR_MS, now)).toBe(1);
    });

    it("returns a multiplier above 1 for a depleted budget", () => {
      // 150 remaining − 100 reserve = 50 spendable over 1h → 72s/poll → 2.4x.
      const m = computeThrottleMultiplier(150, 5000, now + ONE_HOUR_MS, now);
      expect(m).toBeCloseTo(2.4, 1);
    });

    it("returns the max multiplier when the spendable budget is exhausted", () => {
      expect(computeThrottleMultiplier(INTERACTIVE_RESERVE, 5000, now + ONE_HOUR_MS, now)).toBe(
        MAX_THROTTLE_MULTIPLIER
      );
      expect(computeThrottleMultiplier(40, 5000, now + ONE_HOUR_MS, now)).toBe(
        MAX_THROTTLE_MULTIPLIER
      );
    });

    it("clamps an extreme stretch to the max multiplier", () => {
      expect(computeThrottleMultiplier(101, 5000, now + 24 * ONE_HOUR_MS, now)).toBe(
        MAX_THROTTLE_MULTIPLIER
      );
    });

    it("returns 1 when the reset is already in the past", () => {
      expect(computeThrottleMultiplier(150, 5000, now - 1000, now)).toBe(1);
    });

    it("returns 1 for invalid inputs", () => {
      expect(computeThrottleMultiplier(Number.NaN, 5000, now + ONE_HOUR_MS, now)).toBe(1);
      expect(computeThrottleMultiplier(150, 0, now + ONE_HOUR_MS, now)).toBe(1);
      expect(computeThrottleMultiplier(150, 5000, Number.NaN, now)).toBe(1);
    });
  });

  describe("per-resource blocking", () => {
    it('blocks shouldBlockRequest("graphql") when graphql bucket is exhausted but not shouldBlockRequest("core")', () => {
      const resetSeconds = Math.floor(Date.now() / 1000) + 600;
      gitHubRateLimitService.update(
        makeHeaders({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetSeconds),
          "x-ratelimit-resource": "graphql",
        }),
        200
      );

      expect(gitHubRateLimitService.shouldBlockRequest("graphql").blocked).toBe(true);
      expect(gitHubRateLimitService.shouldBlockRequest("graphql").reason).toBe("primary");

      expect(gitHubRateLimitService.shouldBlockRequest("core").blocked).toBe(false);

      // No-arg check is conservative: blocked if any resource is blocked.
      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(true);
    });

    it("clears only the matching resource on 2xx with remaining > 0", () => {
      const resetSeconds = Math.floor(Date.now() / 1000) + 600;

      // Exhaust both graphql and core.
      gitHubRateLimitService.update(
        makeHeaders({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetSeconds),
          "x-ratelimit-resource": "graphql",
        }),
        200
      );
      gitHubRateLimitService.update(
        makeHeaders({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetSeconds),
          "x-ratelimit-resource": "core",
        }),
        200
      );

      // 2xx on graphql clears only graphql.
      gitHubRateLimitService.update(
        makeHeaders({
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": String(resetSeconds),
          "x-ratelimit-resource": "graphql",
        }),
        200
      );

      expect(gitHubRateLimitService.shouldBlockRequest("graphql").blocked).toBe(false);
      expect(gitHubRateLimitService.shouldBlockRequest("core").blocked).toBe(true);
    });

    it("marks primary block under __global__ when x-ratelimit-resource header is absent", () => {
      const resetSeconds = Math.floor(Date.now() / 1000) + 600;
      gitHubRateLimitService.update(
        makeHeaders({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetSeconds),
        }),
        200
      );

      // Without resource param, the global entry gates.
      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(true);
    });

    it("secondary block gates resource-specific check", () => {
      gitHubRateLimitService.update(makeHeaders({ "retry-after": "30" }), 429);

      // Secondary trumps everything, even when passing a resource.
      expect(gitHubRateLimitService.shouldBlockRequest("core").blocked).toBe(true);
      expect(gitHubRateLimitService.shouldBlockRequest("core").reason).toBe("secondary");
    });

    it("unknown-resource primary block gates resource-specific callers", () => {
      const resetSeconds = Math.floor(Date.now() / 1000) + 600;
      gitHubRateLimitService.update(
        makeHeaders({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetSeconds),
        }),
        200
      );

      // No x-ratelimit-resource header → stored under __global__.
      // Resource-specific callers must still be gated.
      expect(gitHubRateLimitService.shouldBlockRequest("graphql").blocked).toBe(true);
      expect(gitHubRateLimitService.shouldBlockRequest("core").blocked).toBe(true);
    });

    it("2xx without x-ratelimit-resource does not clear secondary block", () => {
      gitHubRateLimitService.update(makeHeaders({ "retry-after": "30" }), 429);
      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(true);

      gitHubRateLimitService.update(
        makeHeaders({
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3_600),
        }),
        200
      );

      // No x-ratelimit-resource header → secondary block under __global__ is preserved.
      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(true);
      expect(gitHubRateLimitService.shouldBlockRequest().reason).toBe("secondary");
    });
  });

  describe("requestId tracking", () => {
    it("does not throw when requestId is passed to update()", () => {
      gitHubRateLimitService.update(
        makeHeaders({ "retry-after": "30" }),
        429,
        undefined,
        "beef-dead"
      );

      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(true);
    });

    it("does not break when requestId is undefined", () => {
      gitHubRateLimitService.update(makeHeaders({ "retry-after": "30" }), 429);
      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(true);
    });
  });

  describe("jittered exponential backoff on consecutive secondary hits", () => {
    it("increments consecutive-hits counter on retry-after secondary block", () => {
      gitHubRateLimitService.update(makeHeaders({ "retry-after": "30" }), 429);
      expect(gitHubRateLimitService._getConsecutiveSecondaryHitsForTests()).toBe(1);

      gitHubRateLimitService.update(makeHeaders({ "retry-after": "30" }), 429);
      expect(gitHubRateLimitService._getConsecutiveSecondaryHitsForTests()).toBe(2);
    });

    it("increments counter on body-classified secondary block", () => {
      gitHubRateLimitService.update(
        makeHeaders({}),
        403,
        "You have exceeded a secondary rate limit."
      );
      expect(gitHubRateLimitService._getConsecutiveSecondaryHitsForTests()).toBe(1);

      gitHubRateLimitService.update(makeHeaders({}), 403, "abuse detection");
      expect(gitHubRateLimitService._getConsecutiveSecondaryHitsForTests()).toBe(2);
    });

    it("applies exponential backoff on each consecutive body-classified secondary block", () => {
      // Pin jitter to 0 so the lower bound is the bare exponential schedule.
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        gitHubRateLimitService.update(makeHeaders({}), 403, "secondary rate limit");
        const hit1 = gitHubRateLimitService.shouldBlockRequest().resumeAt!;
        const wait1 = hit1 - Date.now();
        // Hit 1 base: 60s.
        expect(wait1).toBeGreaterThanOrEqual(58_000);
        expect(wait1).toBeLessThanOrEqual(62_000);

        // Need to clear the block to register the next hit (otherwise
        // the same global block is just refreshed in place).
        gitHubRateLimitService._resetForTests();
        // _resetForTests zeroes the counter, so re-seed to hit count 2.
        gitHubRateLimitService.update(makeHeaders({}), 403, "secondary rate limit");
        // Now we're at hit 1 after reset; do one more to reach hit 2.
        gitHubRateLimitService.update(makeHeaders({}), 403, "secondary rate limit");
        const hit2 = gitHubRateLimitService.shouldBlockRequest().resumeAt!;
        const wait2 = hit2 - Date.now();
        // Hit 2 base: 120s.
        expect(wait2).toBeGreaterThanOrEqual(118_000);
        expect(wait2).toBeLessThanOrEqual(122_000);
      } finally {
        randomSpy.mockRestore();
      }
    });

    it("caps fallback delay at 5 minutes regardless of consecutive hit count", () => {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
      try {
        // Force counter high.
        for (let i = 0; i < 10; i++) {
          gitHubRateLimitService.update(makeHeaders({}), 403, "secondary rate limit");
        }
        const resumeAt = gitHubRateLimitService.shouldBlockRequest().resumeAt!;
        const wait = resumeAt - Date.now();
        // Cap is 5 min = 300_000ms.
        expect(wait).toBeLessThanOrEqual(300_500);
      } finally {
        randomSpy.mockRestore();
      }
    });

    it("resets counter on clear()", () => {
      gitHubRateLimitService.update(makeHeaders({ "retry-after": "30" }), 429);
      expect(gitHubRateLimitService._getConsecutiveSecondaryHitsForTests()).toBe(1);

      gitHubRateLimitService.clear();
      expect(gitHubRateLimitService._getConsecutiveSecondaryHitsForTests()).toBe(0);
    });

    it("resets counter on a successful 2xx with remaining > 0", () => {
      gitHubRateLimitService.update(makeHeaders({ "retry-after": "30" }), 429);
      expect(gitHubRateLimitService._getConsecutiveSecondaryHitsForTests()).toBe(1);

      gitHubRateLimitService.update(
        makeHeaders({
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
        }),
        200
      );

      expect(gitHubRateLimitService._getConsecutiveSecondaryHitsForTests()).toBe(0);
    });

    it("honors explicit retry-after value without applying jitter override", () => {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
      try {
        gitHubRateLimitService.update(makeHeaders({ "retry-after": "30" }), 429);
        const resumeAt = gitHubRateLimitService.shouldBlockRequest().resumeAt!;
        const wait = resumeAt - Date.now();
        // Should be ~30s, not 60s+ from the jittered fallback.
        expect(wait).toBeGreaterThan(25_000);
        expect(wait).toBeLessThanOrEqual(30_500);
      } finally {
        randomSpy.mockRestore();
      }
    });
  });
});
