import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { GitHubAuth, getLastAuthMetadata } from "../GitHubAuth.js";
import {
  gitHubTokenHealthService,
  HEALTH_CHECK_FOCUS_COOLDOWN_MS,
} from "../GitHubTokenHealthService.js";
import type { GitHubTokenHealthPayload } from "../../../../shared/types/ipc/github.js";

function createStorage() {
  let token: string | undefined;
  return {
    get: () => token,
    set: (nextToken: string) => {
      token = nextToken;
    },
    delete: () => {
      token = undefined;
    },
  };
}

function buildResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response("{}", { status, headers });
}

describe("GitHubTokenHealthService", () => {
  const listener = vi.fn<(state: GitHubTokenHealthPayload) => void>();
  let unsubscribe: (() => void) | null = null;
  let fetchMock: Mock;

  beforeEach(() => {
    GitHubAuth.initializeStorage(createStorage());
    GitHubAuth.clearToken();
    gitHubTokenHealthService._resetForTests();
    listener.mockClear();
    fetchMock = vi.fn();
    gitHubTokenHealthService._setFetchForTests(fetchMock as unknown as typeof globalThis.fetch);
    unsubscribe = gitHubTokenHealthService.onStateChange(listener);
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    gitHubTokenHealthService._resetForTests();
  });

  describe("refresh()", () => {
    it("does nothing when no token is configured", async () => {
      await gitHubTokenHealthService.refresh({ force: true });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(gitHubTokenHealthService.getState().status).toBe("unknown");
    });

    it("marks state healthy on a 2xx probe response", async () => {
      GitHubAuth.setToken("ghp_testtoken0000000000000000000000000000000");
      fetchMock.mockResolvedValue(buildResponse(200));

      await gitHubTokenHealthService.refresh({ force: true });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/rate_limit",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining("token "),
          }),
          signal: expect.any(AbortSignal),
        })
      );
      expect(gitHubTokenHealthService.getState().status).toBe("healthy");
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: "healthy" }));
    });

    it("marks state unhealthy on a 401 probe response", async () => {
      GitHubAuth.setToken("ghp_testtoken0000000000000000000000000000000");
      fetchMock.mockResolvedValue(buildResponse(401));

      await gitHubTokenHealthService.refresh({ force: true });

      expect(gitHubTokenHealthService.getState().status).toBe("unhealthy");
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: "unhealthy" }));
    });

    it("leaves state unchanged on network failures", async () => {
      GitHubAuth.setToken("ghp_testtoken0000000000000000000000000000000");
      fetchMock.mockRejectedValue(new Error("ENOTFOUND api.github.com"));

      await gitHubTokenHealthService.refresh({ force: true });

      expect(gitHubTokenHealthService.getState().status).toBe("unknown");
      expect(listener).not.toHaveBeenCalled();
    });

    it("leaves state unchanged on inconclusive 5xx responses", async () => {
      GitHubAuth.setToken("ghp_testtoken0000000000000000000000000000000");
      fetchMock.mockResolvedValue(buildResponse(503));

      await gitHubTokenHealthService.refresh({ force: true });

      expect(gitHubTokenHealthService.getState().status).toBe("unknown");
      expect(listener).not.toHaveBeenCalled();
    });

    it("coalesces concurrent probes into one in-flight request", async () => {
      GitHubAuth.setToken("ghp_testtoken0000000000000000000000000000000");
      let resolveFetch: ((value: Response) => void) | null = null;
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      );

      const first = gitHubTokenHealthService.refresh({ force: true });
      const second = gitHubTokenHealthService.refresh({ force: true });

      expect(fetchMock).toHaveBeenCalledTimes(1);

      resolveFetch!(buildResponse(200));
      await Promise.all([first, second]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("respects the 5-minute focus cooldown by default", async () => {
      GitHubAuth.setToken("ghp_testtoken0000000000000000000000000000000");
      let now = 1_000_000;
      gitHubTokenHealthService._setNowForTests(() => now);
      fetchMock.mockResolvedValue(buildResponse(200));

      await gitHubTokenHealthService.refresh({ force: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Within cooldown window — no additional probe.
      now += HEALTH_CHECK_FOCUS_COOLDOWN_MS - 1_000;
      await gitHubTokenHealthService.refresh();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Past cooldown window — probe runs again.
      now += 2_000;
      await gitHubTokenHealthService.refresh();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("force refresh bypasses the cooldown", async () => {
      GitHubAuth.setToken("ghp_testtoken0000000000000000000000000000000");
      const now = 1_000_000;
      gitHubTokenHealthService._setNowForTests(() => now);
      fetchMock.mockResolvedValue(buildResponse(200));

      await gitHubTokenHealthService.refresh({ force: true });
      await gitHubTokenHealthService.refresh({ force: true });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("token version guard", () => {
    it("discards a probe result after the token changed mid-flight", async () => {
      GitHubAuth.setToken("ghp_stale00000000000000000000000000000000000");

      let resolveFetch: ((value: Response) => void) | null = null;
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      );

      const probe = gitHubTokenHealthService.refresh({ force: true });

      // User updates their token while the probe is in flight.
      GitHubAuth.setToken("ghp_fresh00000000000000000000000000000000000");

      resolveFetch!(buildResponse(401));
      await probe;

      expect(gitHubTokenHealthService.getState().status).toBe("unknown");
      expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ status: "unhealthy" }));
    });

    it("does not repopulate stale auth metadata after mid-flight token rotation", async () => {
      GitHubAuth.setToken("ghp_stale00000000000000000000000000000000000");

      let resolveFetch: ((value: Response) => void) | null = null;
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      );

      const probe = gitHubTokenHealthService.refresh({ force: true });

      // New token rotates in — this must clear `lastAuthMetadata` via
      // `clearAuthMetadata()`. A late-arriving response from the old token
      // carrying an `X-GitHub-SSO` header would otherwise repopulate the
      // metadata store with a URL that belongs to a session we no longer
      // care about.
      GitHubAuth.setToken("ghp_fresh00000000000000000000000000000000000");

      resolveFetch!(
        buildResponse(403, {
          "x-github-sso":
            "required; url=https://github.com/orgs/stale/sso?authorization_request=abc",
        })
      );
      await probe;

      expect(getLastAuthMetadata()).toBeNull();
    });
  });

  describe("transitions", () => {
    it("does not re-emit when the probe result matches the current status", async () => {
      GitHubAuth.setToken("ghp_testtoken0000000000000000000000000000000");
      fetchMock.mockResolvedValue(buildResponse(401));

      await gitHubTokenHealthService.refresh({ force: true });
      expect(listener).toHaveBeenCalledTimes(1);

      await gitHubTokenHealthService.refresh({ force: true });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("emits when transitioning from unhealthy back to healthy", async () => {
      GitHubAuth.setToken("ghp_testtoken0000000000000000000000000000000");
      fetchMock.mockResolvedValueOnce(buildResponse(401));
      await gitHubTokenHealthService.refresh({ force: true });
      listener.mockClear();

      fetchMock.mockResolvedValueOnce(buildResponse(200));
      await gitHubTokenHealthService.refresh({ force: true });

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: "healthy" }));
    });
  });

  describe("resetState()", () => {
    it("returns the service to unknown and notifies listeners", async () => {
      GitHubAuth.setToken("ghp_testtoken0000000000000000000000000000000");
      fetchMock.mockResolvedValue(buildResponse(401));
      await gitHubTokenHealthService.refresh({ force: true });
      listener.mockClear();

      gitHubTokenHealthService.resetState();

      expect(gitHubTokenHealthService.getState().status).toBe("unknown");
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: "unknown" }));
    });

    it("is a no-op when the state is already unknown", () => {
      gitHubTokenHealthService.resetState();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("SSO URL capture", () => {
    it("surfaces the captured SSO URL in the state payload", async () => {
      GitHubAuth.setToken("ghp_testtoken0000000000000000000000000000000");
      fetchMock.mockResolvedValue(
        buildResponse(200, {
          "x-github-sso":
            "required; url=https://github.com/orgs/acme/sso?authorization_request=abc123",
        })
      );

      await gitHubTokenHealthService.refresh({ force: true });

      const state = gitHubTokenHealthService.getState();
      expect(state.ssoUrl).toBe("https://github.com/orgs/acme/sso?authorization_request=abc123");
    });
  });
});
