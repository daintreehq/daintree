import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { GitHubAuth, getLastAuthMetadata } from "../GitHubAuth.js";
import {
  gitHubTokenHealthService,
  HEALTH_CHECK_FOCUS_COOLDOWN_MS,
} from "../GitHubTokenHealthService.js";
import type { GitHubTokenHealthPayload } from "../../shared/types.js";

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

    it("sends User-Agent, X-GitHub-Api-Version, and Bearer headers", async () => {
      GitHubAuth.setToken("ghp_testtoken0000000000000000000000000000000");
      fetchMock.mockResolvedValue(buildResponse(200));

      await gitHubTokenHealthService.refresh({ force: true });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/rate_limit",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer ghp_testtoken0000000000000000000000000000000",
            "User-Agent": "Daintree-Electron",
            "X-GitHub-Api-Version": "2022-11-28",
          }),
        })
      );
    });

    it("marks state healthy on a 2xx probe response", async () => {
      GitHubAuth.setToken("ghp_testtoken0000000000000000000000000000000");
      fetchMock.mockResolvedValue(buildResponse(200));

      await gitHubTokenHealthService.refresh({ force: true });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/rate_limit",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining("Bearer "),
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

  describe("credential change during an in-flight probe (#12325)", () => {
    const TOKEN_A = "ghp_stale00000000000000000000000000000000000";
    const TOKEN_B = "ghp_fresh00000000000000000000000000000000000";
    const TOKEN_C = "ghp_newest0000000000000000000000000000000000";

    /**
     * Drive the service to a settled verdict for `token`, then clear the call
     * records. Every case here starts from a real verdict — a service still at
     * `unknown` hides the banner already, so it cannot show that the fix
     * cleared one.
     */
    async function seed(token: string, probeStatus: number) {
      GitHubAuth.setToken(token);
      fetchMock.mockResolvedValue(buildResponse(probeStatus));
      await gitHubTokenHealthService.refresh({ force: true });
      fetchMock.mockClear();
      listener.mockClear();
    }

    /** A fetch stub whose every call stays pending until settled by index. */
    function deferredFetch() {
      const settlers: Array<{ resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve, reject) => {
            settlers.push({ resolve, reject });
          })
      );
      return settlers;
    }

    it("re-probes with the new credential instead of folding into the stale probe", async () => {
      // The stuck state from the issue: the expired token's verdict is in.
      await seed(TOKEN_A, 401);
      expect(gitHubTokenHealthService.getState().status).toBe("unhealthy");
      const settlers = deferredFetch();

      const stale = gitHubTokenHealthService.refresh({ force: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // The credential-save path: deliver the new token, then ask for a probe.
      GitHubAuth.setToken(TOKEN_B);
      const reprobe = gitHubTokenHealthService.refresh({ force: true });

      // Nothing new goes on the wire while the stale probe is still out.
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // The stale probe answers 401 for the *old* token; the version guard
      // discards it, which is exactly why joining it would have lost the
      // re-probe and left the "token expired" banner up.
      settlers[0].resolve(buildResponse(401));
      await stale;
      // Still unhealthy: the stale 401 was discarded and nothing has confirmed
      // the new token yet. Saving a credential must not clear the banner on
      // its own — only a probe of the new token may.
      expect(gitHubTokenHealthService.getState().status).toBe("unhealthy");

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(fetchMock).toHaveBeenLastCalledWith(
        "https://api.github.com/rate_limit",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN_B}` }),
        })
      );

      settlers[1].resolve(buildResponse(200));
      await reprobe;

      expect(gitHubTokenHealthService.getState().status).toBe("healthy");
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: "healthy" }));
    });

    it("leaves the new credential unhealthy when its own probe returns 401", async () => {
      await seed(TOKEN_A, 200);
      expect(gitHubTokenHealthService.getState().status).toBe("healthy");
      const settlers = deferredFetch();

      const stale = gitHubTokenHealthService.refresh({ force: true });
      GitHubAuth.setToken(TOKEN_B);
      const reprobe = gitHubTokenHealthService.refresh({ force: true });

      settlers[0].resolve(buildResponse(200));
      await stale;
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      // The replacement credential is the one that decides — a save alone
      // never establishes health.
      settlers[1].resolve(buildResponse(401));
      await reprobe;

      expect(gitHubTokenHealthService.getState().status).toBe("unhealthy");
    });

    it("folds piled-up refreshes into a single probe for the latest credential", async () => {
      GitHubAuth.setToken(TOKEN_A);
      const settlers = deferredFetch();

      const stale = gitHubTokenHealthService.refresh({ force: true });
      GitHubAuth.setToken(TOKEN_B);
      const first = gitHubTokenHealthService.refresh({ force: true });
      const second = gitHubTokenHealthService.refresh({ force: true });
      const third = gitHubTokenHealthService.refresh({ force: true });

      settlers[0].resolve(buildResponse(401));
      await stale;
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      settlers[1].resolve(buildResponse(200));
      await Promise.all([first, second, third]);

      // One follow-up, not three — the queued re-probe is shared.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(gitHubTokenHealthService.getState().status).toBe("healthy");
    });

    it("still re-probes when the stale probe fails in transport", async () => {
      GitHubAuth.setToken(TOKEN_A);
      const settlers = deferredFetch();

      const stale = gitHubTokenHealthService.refresh({ force: true });
      GitHubAuth.setToken(TOKEN_B);
      const reprobe = gitHubTokenHealthService.refresh({ force: true });

      // A network failure on the displaced probe must not cancel the re-probe
      // it displaced.
      settlers[0].reject(new Error("ENOTFOUND"));
      await stale;
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      settlers[1].resolve(buildResponse(200));
      await reprobe;

      expect(gitHubTokenHealthService.getState().status).toBe("healthy");
    });

    it("drops a stale unhealthy verdict to unknown when the credential is cleared", async () => {
      await seed(TOKEN_A, 401);
      expect(gitHubTokenHealthService.getState().status).toBe("unhealthy");
      const settlers = deferredFetch();

      const stale = gitHubTokenHealthService.refresh({ force: true });
      // Clearing during an in-flight probe: the follow-up finds no token and
      // settles on `unknown` rather than leaving the expired verdict — and the
      // banner — standing.
      GitHubAuth.clearToken();
      const reprobe = gitHubTokenHealthService.refresh({ force: true });

      settlers[0].resolve(buildResponse(401));
      await stale;
      await reprobe;

      expect(gitHubTokenHealthService.getState().status).toBe("unknown");
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: "unknown" }));
      // No token means no request — the verdict is dropped, not re-probed.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("probes the newest credential when two replacements land during one probe", async () => {
      await seed(TOKEN_A, 401);
      const settlers = deferredFetch();

      const stale = gitHubTokenHealthService.refresh({ force: true });
      GitHubAuth.setToken(TOKEN_B);
      const afterB = gitHubTokenHealthService.refresh({ force: true });
      GitHubAuth.setToken(TOKEN_C);
      const afterC = gitHubTokenHealthService.refresh({ force: true });

      settlers[0].resolve(buildResponse(401));
      await stale;
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      // The queued probe re-reads the current credential rather than capturing
      // the one its caller saw, so it can never authenticate with a token that
      // was already superseded while it waited.
      expect(fetchMock).toHaveBeenLastCalledWith(
        "https://api.github.com/rate_limit",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN_C}` }),
        })
      );

      settlers[1].resolve(buildResponse(200));
      await Promise.all([afterB, afterC]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(gitHubTokenHealthService.getState().status).toBe("healthy");
    });

    it("drops the queued re-probe when the plugin stops before it runs", async () => {
      GitHubAuth.setToken(TOKEN_A);
      const settlers = deferredFetch();

      const stale = gitHubTokenHealthService.refresh({ force: true });
      GitHubAuth.setToken(TOKEN_B);
      const reprobe = gitHubTokenHealthService.refresh({ force: true });

      // Plugin disabled while the stale probe is still on the wire — the
      // queued re-probe must go back through the lifecycle gate, not around it.
      gitHubTokenHealthService.stop();
      settlers[0].resolve(buildResponse(401));
      await stale;
      // Give the queued continuation its turn before asserting. A follow-up
      // that skipped the gate would issue a fetch nothing ever settles, so
      // `await reprobe` alone would hang to the suite timeout rather than
      // failing on the count.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await reprobe;
      expect(fetchMock).toHaveBeenCalledTimes(1);
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

  describe("plugin-owned lifecycle gate", () => {
    beforeEach(() => {
      GitHubAuth.setToken("ghp_testtoken0000000000000000000000000000000");
      fetchMock.mockResolvedValue(buildResponse(200));
    });

    it("skips probes while stopped — even forced focus/wake refreshes", async () => {
      gitHubTokenHealthService.stop();

      await gitHubTokenHealthService.refresh({ force: true });
      await gitHubTokenHealthService.refresh();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("probes again after a stop → start cycle (plugin re-enable)", async () => {
      gitHubTokenHealthService.stop();
      await gitHubTokenHealthService.refresh({ force: true });
      expect(fetchMock).not.toHaveBeenCalled();

      gitHubTokenHealthService.start();
      await gitHubTokenHealthService.refresh({ force: true });
      expect(fetchMock).toHaveBeenCalled();
    });

    it("stop() keeps host transport listeners wired for a later re-enable", async () => {
      gitHubTokenHealthService.stop();
      gitHubTokenHealthService.start();

      await gitHubTokenHealthService.refresh({ force: true });

      // The relay listener registered in beforeEach must still observe the
      // healthy transition — a disable/enable cycle must not orphan it.
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: "healthy" }));
    });

    it("discards a probe that completes after stop() — no late state publish", async () => {
      let resolveProbe: (r: Response) => void = () => {};
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveProbe = resolve;
          })
      );

      const inFlight = gitHubTokenHealthService.refresh({ force: true });
      // Plugin disabled while the probe is on the wire.
      gitHubTokenHealthService.stop();
      resolveProbe(buildResponse(401));
      await inFlight;

      // A late 401 must not resurrect an unhealthy banner for an integration
      // the user just turned off.
      expect(gitHubTokenHealthService.getState().status).toBe("unknown");
      expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ status: "unhealthy" }));
    });
  });
});
