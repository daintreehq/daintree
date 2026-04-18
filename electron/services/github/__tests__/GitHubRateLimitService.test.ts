import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gitHubRateLimitService } from "../GitHubRateLimitService.js";
import type { GitHubRateLimitPayload } from "../../../../shared/types/ipc/github.js";

function makeHeaders(entries: Record<string, string>): Headers {
  return new Headers(entries);
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

    it("ignores 2xx responses with remaining > 0 and clears existing blocks", () => {
      gitHubRateLimitService.update(makeHeaders({ "retry-after": "30" }), 429);
      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(true);

      gitHubRateLimitService.update(
        makeHeaders({
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3_600),
        }),
        200
      );

      expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(false);
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
});
