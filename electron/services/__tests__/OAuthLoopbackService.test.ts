import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";

// Mock electron before importing the service
vi.mock("electron", () => ({
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
  app: {
    on: vi.fn(),
  },
}));

import {
  startOAuthLoopback,
  cancelOAuthLoopback,
  looksLikeOAuthUrl,
} from "../OAuthLoopbackService.js";
import { shell } from "electron";

function fetchUrl(url: string, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .request(url, { method }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject)
      .end();
  });
}

async function startAndCaptureRedirect(
  authUrl: string
): Promise<{ promise: ReturnType<typeof startOAuthLoopback>; redirect: string }> {
  const promise = startOAuthLoopback(authUrl, "test-panel");
  await vi.waitFor(() => {
    expect(shell.openExternal).toHaveBeenCalledTimes(1);
  });
  const rewrittenUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
  return { promise, redirect: new URL(rewrittenUrl).searchParams.get("redirect_uri")! };
}

// Raw request target: `http.get(url)` normalizes, so pass the path verbatim.
function rawRequest(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .request({ host: "127.0.0.1", port, path, agent: false }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      })
      .on("error", reject)
      .end();
  });
}

describe("OAuthLoopbackService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Cancel any lingering sessions
    cancelOAuthLoopback("test-panel");
    cancelOAuthLoopback("panel-a");
    cancelOAuthLoopback("panel-b");
  });

  describe("looksLikeOAuthUrl", () => {
    it("detects standard OAuth authorization URLs with response_type + redirect_uri", () => {
      expect(
        looksLikeOAuthUrl(
          "https://auth.example.com/authorize?client_id=abc&response_type=code&redirect_uri=http://localhost:3000/callback"
        )
      ).toBe(true);
    });

    it("detects PKCE OAuth URLs with code_challenge", () => {
      expect(
        looksLikeOAuthUrl(
          "https://auth.example.com/authorize?client_id=abc&redirect_uri=http://localhost:3000/callback&code_challenge=abc123&code_challenge_method=S256"
        )
      ).toBe(true);
    });

    it("detects full OAuth URL with response_type + code_challenge", () => {
      expect(
        looksLikeOAuthUrl(
          "https://auth.example.com/authorize?client_id=abc&response_type=code&code_challenge=abc123"
        )
      ).toBe(true);
    });

    it("rejects URLs with only client_id + redirect_uri (no response_type or code_challenge)", () => {
      expect(
        looksLikeOAuthUrl(
          "https://auth.example.com/authorize?client_id=abc&redirect_uri=http://localhost:3000/callback"
        )
      ).toBe(false);
    });

    it("rejects URLs without client_id", () => {
      expect(looksLikeOAuthUrl("https://auth.example.com/authorize?response_type=code")).toBe(
        false
      );
    });

    it("rejects invalid URLs", () => {
      expect(looksLikeOAuthUrl("not a url")).toBe(false);
    });
  });

  describe("startOAuthLoopback", () => {
    it("returns server-error when auth URL has no redirect_uri", async () => {
      const result = await startOAuthLoopback(
        "https://auth.example.com/authorize?client_id=abc&response_type=code",
        "test-panel"
      );
      expect(result).toEqual({ success: false, cause: "server-error" });
      expect(shell.openExternal).not.toHaveBeenCalled();
    });

    it("returns server-error without throwing on a malformed auth URL", async () => {
      const result = await startOAuthLoopback("not a url", "test-panel");
      expect(result).toEqual({ success: false, cause: "server-error" });
      expect(shell.openExternal).not.toHaveBeenCalled();
    });

    it.each([
      ["a malformed auth URL", "not a url", "server-error"],
      [
        "no redirect_uri",
        "https://auth.example.com/authorize?client_id=abc&response_type=code",
        "server-error",
      ],
      [
        "an unparseable redirect_uri",
        "https://auth.example.com/authorize?client_id=abc&response_type=code&redirect_uri=not-a-url",
        "server-error",
      ],
      [
        "a disallowed scheme",
        "file:///etc/passwd?redirect_uri=http://localhost:3000/auth/callback",
        "open-external-failed",
      ],
    ])(
      "keeps the in-flight session live when a later call has %s",
      async (_label, badUrl, cause) => {
        const authUrl =
          "https://auth.example.com/authorize?client_id=abc&response_type=code&redirect_uri=http://localhost:3000/auth/callback&state=s1";

        const firstPromise = startOAuthLoopback(authUrl, "test-panel");
        await vi.waitFor(() => {
          expect(shell.openExternal).toHaveBeenCalledTimes(1);
        });
        const loopbackRedirectUri = new URL(
          (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
        ).searchParams.get("redirect_uri")!;

        const badResult = await startOAuthLoopback(badUrl, "test-panel");
        expect(badResult).toEqual({ success: false, cause });
        expect(shell.openExternal).toHaveBeenCalledTimes(1);

        // The first listener must still accept a real callback and complete the flow.
        const response = await fetchUrl(`${loopbackRedirectUri}?code=FIRST_CODE&state=s1`);
        expect(response.status).toBe(200);

        const firstResult = await firstPromise;
        expect(firstResult.success).toBe(true);
        if (!firstResult.success) throw new Error("expected success");
        const resultUrl = new URL(firstResult.callbackUrl);
        expect(resultUrl.origin + resultUrl.pathname).toBe("http://localhost:3000/auth/callback");
        expect(resultUrl.searchParams.get("code")).toBe("FIRST_CODE");
        expect(firstResult.loopbackRedirectUri).toBe(loopbackRedirectUri);
      }
    );

    it("never opens a disallowed scheme even with a valid redirect_uri", async () => {
      const redirect = encodeURIComponent("http://localhost:3000/auth/callback");

      const fileResult = await startOAuthLoopback(
        `file:///etc/passwd?redirect_uri=${redirect}`,
        "test-panel"
      );
      expect(fileResult).toEqual({ success: false, cause: "open-external-failed" });

      const customResult = await startOAuthLoopback(
        `myapp://auth?redirect_uri=${redirect}`,
        "test-panel"
      );
      expect(customResult).toEqual({ success: false, cause: "open-external-failed" });

      expect(shell.openExternal).not.toHaveBeenCalled();
    });

    it("starts a loopback server and rewrites redirect_uri", async () => {
      const authUrl =
        "https://auth.example.com/authorize?client_id=abc&response_type=code&redirect_uri=http://localhost:3000/auth/callback&state=xyz123";

      // Start the loopback — it won't resolve until we hit the callback
      const loopbackPromise = startOAuthLoopback(authUrl, "test-panel");

      // Wait for shell.openExternal to be called
      await vi.waitFor(() => {
        expect(shell.openExternal).toHaveBeenCalledTimes(1);
      });

      // Verify the rewritten URL
      const rewrittenUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      const parsed = new URL(rewrittenUrl);

      // redirect_uri should now point to 127.0.0.1 with the loopback server port
      const newRedirectUri = parsed.searchParams.get("redirect_uri")!;
      expect(newRedirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);

      // Other params should be preserved
      expect(parsed.searchParams.get("client_id")).toBe("abc");
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(parsed.searchParams.get("state")).toBe("xyz123");

      // Simulate the IdP redirecting to the loopback server
      const callbackUrl = `${newRedirectUri}?code=AUTH_CODE_123&state=xyz123`;
      const response = await fetchUrl(callbackUrl);

      expect(response.status).toBe(200);
      expect(response.body).toContain("Authentication Complete");

      // The promise should resolve with the original callback URL + captured params
      const result = await loopbackPromise;
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("expected success");

      const resultUrl = new URL(result.callbackUrl);
      expect(resultUrl.origin).toBe("http://localhost:3000");
      expect(resultUrl.pathname).toBe("/auth/callback");
      expect(resultUrl.searchParams.get("code")).toBe("AUTH_CODE_123");
      expect(resultUrl.searchParams.get("state")).toBe("xyz123");
      expect(result.loopbackRedirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
      expect(result.originalRedirectUri).toBe("http://localhost:3000/auth/callback");
    });

    it("handles OAuth error responses from the IdP", async () => {
      const authUrl =
        "https://auth.example.com/authorize?client_id=abc&response_type=code&redirect_uri=http://localhost:3000/auth/callback";

      const loopbackPromise = startOAuthLoopback(authUrl, "test-panel");

      await vi.waitFor(() => {
        expect(shell.openExternal).toHaveBeenCalledTimes(1);
      });

      const rewrittenUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      const newRedirectUri = new URL(rewrittenUrl).searchParams.get("redirect_uri")!;

      // IdP returns an error instead of a code
      const errorCallback = `${newRedirectUri}?error=access_denied&error_description=User+cancelled`;
      const response = await fetchUrl(errorCallback);

      expect(response.status).toBe(200);
      expect(response.body).toContain("Authentication Failed");
      expect(response.body).toContain("User cancelled");

      // Should still resolve — the app handles the error params
      const result = await loopbackPromise;
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("expected success");

      const resultUrl = new URL(result.callbackUrl);
      expect(resultUrl.searchParams.get("error")).toBe("access_denied");
      expect(resultUrl.searchParams.get("error_description")).toBe("User cancelled");
    });

    it("escapes HTML in error_description to prevent XSS", async () => {
      const authUrl =
        "https://auth.example.com/authorize?client_id=abc&response_type=code&redirect_uri=http://localhost:3000/auth/callback";

      const loopbackPromise = startOAuthLoopback(authUrl, "test-panel");

      await vi.waitFor(() => {
        expect(shell.openExternal).toHaveBeenCalledTimes(1);
      });

      const rewrittenUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      const newRedirectUri = new URL(rewrittenUrl).searchParams.get("redirect_uri")!;

      const xssPayload = `<script>alert(1)</script><img onerror=alert(1) src=x>`;
      const errorCallback = `${newRedirectUri}?error=xss&error_description=${encodeURIComponent(xssPayload)}`;
      const response = await fetchUrl(errorCallback);

      expect(response.status).toBe(200);
      expect(response.body).not.toContain("<script>");
      expect(response.body).not.toContain("<img");
      expect(response.body).toContain("&lt;script&gt;");
      expect(response.body).toContain("&lt;img");

      await loopbackPromise;
    });

    it("returns 404 for non-callback paths", async () => {
      const authUrl =
        "https://auth.example.com/authorize?client_id=abc&response_type=code&redirect_uri=http://localhost:3000/auth/callback";

      const loopbackPromise = startOAuthLoopback(authUrl, "test-panel");

      await vi.waitFor(() => {
        expect(shell.openExternal).toHaveBeenCalledTimes(1);
      });

      const rewrittenUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      const port = new URL(new URL(rewrittenUrl).searchParams.get("redirect_uri")!).port;

      // Hit a wrong path
      const response = await fetchUrl(`http://127.0.0.1:${port}/wrong-path`);
      expect(response.status).toBe(404);

      // Clean up — cancel so the promise resolves
      cancelOAuthLoopback("test-panel");
      const result = await loopbackPromise;
      expect(result).toEqual({ success: false, cause: "cancelled" });
    });

    it("answers malformed and foreign request targets with 400 without settling the flow", async () => {
      const authUrl =
        "https://auth.example.com/authorize?client_id=abc&response_type=code&redirect_uri=http://localhost:3000/auth/callback";
      const logSpies = [
        vi.spyOn(console, "log"),
        vi.spyOn(console, "warn"),
        vi.spyOn(console, "error"),
      ];

      try {
        const loopbackPromise = startOAuthLoopback(authUrl, "test-panel");
        let settled = false;
        void loopbackPromise.then(() => {
          settled = true;
        });

        await vi.waitFor(() => {
          expect(shell.openExternal).toHaveBeenCalledTimes(1);
        });
        const rewrittenUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock
          .calls[0][0] as string;
        const redirectUri = new URL(rewrittenUrl).searchParams.get("redirect_uri")!;
        const port = Number(new URL(redirectUri).port);

        for (const target of [
          "//[",
          "//[/oauth/callback?code=LEAKED_CODE",
          "//evil.example/oauth/callback?code=LEAKED_CODE",
          "/\\evil.example/oauth/callback?code=LEAKED_CODE",
          "http://[/oauth/callback?code=LEAKED_CODE",
          "http://evil.example/oauth/callback?code=LEAKED_CODE",
          `http://127.0.0.1:${port}/oauth/callback?code=LEAKED_CODE`,
        ]) {
          expect(await rawRequest(port, target)).toBe(400);
        }
        expect(settled).toBe(false);

        // The listener survives and the real callback still completes the flow.
        const response = await fetchUrl(`${redirectUri}?code=REAL_CODE`);
        expect(response.status).toBe(200);
        const result = await loopbackPromise;
        expect(result.success).toBe(true);
        if (!result.success) throw new Error("expected success");
        expect(new URL(result.callbackUrl).searchParams.get("code")).toBe("REAL_CODE");

        const logged = logSpies.flatMap((spy) => spy.mock.calls.flat().map(String)).join("\n");
        expect(logged).not.toContain("LEAKED_CODE");
      } finally {
        for (const spy of logSpies) spy.mockRestore();
      }
    });

    it("cancels a previous flow when starting a new one for the same panel", async () => {
      const authUrl =
        "https://auth.example.com/authorize?client_id=abc&response_type=code&redirect_uri=http://localhost:3000/auth/callback";

      const firstPromise = startOAuthLoopback(authUrl, "test-panel");

      await vi.waitFor(() => {
        expect(shell.openExternal).toHaveBeenCalledTimes(1);
      });

      // Start a second flow for the same panel — should cancel the first
      const secondPromise = startOAuthLoopback(authUrl, "test-panel");

      // First should resolve as cancelled
      const firstResult = await firstPromise;
      expect(firstResult).toEqual({ success: false, cause: "cancelled" });

      // Clean up second
      cancelOAuthLoopback("test-panel");
      const secondResult = await secondPromise;
      expect(secondResult).toEqual({ success: false, cause: "cancelled" });
    });

    it("allows concurrent flows on different panels", async () => {
      const authUrl =
        "https://auth.example.com/authorize?client_id=abc&response_type=code&redirect_uri=http://localhost:3000/auth/callback";

      const promiseA = startOAuthLoopback(`${authUrl}&state=a`, "panel-a");
      const promiseB = startOAuthLoopback(`${authUrl}&state=b`, "panel-b");

      await vi.waitFor(() => {
        expect(shell.openExternal).toHaveBeenCalledTimes(2);
      });

      // Both should have different ports
      const urlA = (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const urlB = (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
      const portA = new URL(new URL(urlA).searchParams.get("redirect_uri")!).port;
      const portB = new URL(new URL(urlB).searchParams.get("redirect_uri")!).port;
      expect(portA).not.toBe(portB);

      // Complete both
      const redirectA = new URL(urlA).searchParams.get("redirect_uri")!;
      const redirectB = new URL(urlB).searchParams.get("redirect_uri")!;

      await fetchUrl(`${redirectA}?code=CODE_A&state=a`);
      await fetchUrl(`${redirectB}?code=CODE_B&state=b`);

      const resultA = await promiseA;
      const resultB = await promiseB;

      expect(resultA.success).toBe(true);
      expect(resultB.success).toBe(true);
      if (!resultA.success || !resultB.success) throw new Error("expected success");

      expect(new URL(resultA.callbackUrl).searchParams.get("code")).toBe("CODE_A");
      expect(new URL(resultB.callbackUrl).searchParams.get("code")).toBe("CODE_B");
    });
  });

  describe("callback admission", () => {
    const statefulAuthUrl =
      "https://auth.example.com/authorize?client_id=abc&response_type=code&redirect_uri=http://localhost:3000/auth/callback&state=expected";
    const statelessAuthUrl =
      "https://auth.example.com/authorize?client_id=abc&response_type=code&redirect_uri=http://localhost:3000/auth/callback";

    it.each([
      ["a wrong state", "?code=UNRELATED&state=wrong"],
      ["a missing state", "?code=UNRELATED"],
      ["a repeated state", "?code=UNRELATED&state=expected&state=wrong"],
      ["an error with a wrong state", "?error=access_denied&state=wrong"],
      ["a state with no code or error", "?state=expected"],
      ["both code and error", "?code=X&error=access_denied&state=expected"],
      ["a repeated code", "?code=X&code=Y&state=expected"],
      ["an empty code", "?code=&state=expected"],
    ])("refuses %s and keeps the flow open for the real callback", async (_label, query) => {
      const { promise, redirect } = await startAndCaptureRedirect(statefulAuthUrl);

      const refused = await fetchUrl(`${redirect}${query}`);
      expect(refused.status).toBe(400);
      expect(refused.body).not.toContain("Authentication");

      const accepted = await fetchUrl(`${redirect}?code=REAL&state=expected`);
      expect(accepted.status).toBe(200);

      const result = await promise;
      if (!result.success) throw new Error("expected success");
      expect(new URL(result.callbackUrl).searchParams.get("code")).toBe("REAL");
    });

    it("refuses a POST to the callback path without consuming the flow", async () => {
      const { promise, redirect } = await startAndCaptureRedirect(statefulAuthUrl);

      const refused = await fetchUrl(`${redirect}?code=REAL&state=expected`, "POST");
      expect(refused.status).toBe(405);

      await fetchUrl(`${redirect}?code=REAL&state=expected`);
      const result = await promise;
      expect(result.success).toBe(true);
    });

    it("forwards an error response whose state matches", async () => {
      const { promise, redirect } = await startAndCaptureRedirect(statefulAuthUrl);

      const response = await fetchUrl(`${redirect}?error=access_denied&state=expected`);
      expect(response.status).toBe(200);

      const result = await promise;
      if (!result.success) throw new Error("expected success");
      const resultUrl = new URL(result.callbackUrl);
      expect(resultUrl.searchParams.get("error")).toBe("access_denied");
      expect(resultUrl.searchParams.get("state")).toBe("expected");
    });

    it("accepts a stateless callback only when the auth URL carried no state", async () => {
      const { promise, redirect } = await startAndCaptureRedirect(statelessAuthUrl);

      const refused = await fetchUrl(`${redirect}?code=FORGED&state=unsolicited`);
      expect(refused.status).toBe(400);

      await fetchUrl(`${redirect}?code=REAL`);
      const result = await promise;
      if (!result.success) throw new Error("expected success");
      expect(new URL(result.callbackUrl).searchParams.get("code")).toBe("REAL");
    });

    it.each([
      ["repeats state", `${statefulAuthUrl}&state=other`],
      ["has an empty state", `${statelessAuthUrl}&state=`],
    ])("refuses to start when the auth URL %s", async (_label, authUrl) => {
      const result = await startOAuthLoopback(authUrl, "test-panel");
      expect(result).toEqual({ success: false, cause: "server-error" });
      expect(shell.openExternal).not.toHaveBeenCalled();
    });

    it("refuses a callback whose Host is not the loopback literal", async () => {
      const { promise, redirect } = await startAndCaptureRedirect(statefulAuthUrl);
      const port = new URL(redirect).port;

      const refused = await new Promise<number>((resolve, reject) => {
        http
          .request(
            {
              host: "127.0.0.1",
              port,
              path: "/oauth/callback?code=REAL&state=expected",
              headers: { Host: `localhost:${port}` },
            },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            }
          )
          .on("error", reject)
          .end();
      });
      expect(refused).toBe(400);

      await fetchUrl(`${redirect}?code=REAL&state=expected`);
      const result = await promise;
      expect(result.success).toBe(true);
    });

    it("refuses HEAD on the callback path", async () => {
      const { promise, redirect } = await startAndCaptureRedirect(statefulAuthUrl);

      const refused = await fetchUrl(`${redirect}?code=REAL&state=expected`, "HEAD");
      expect(refused.status).toBe(405);

      cancelOAuthLoopback("test-panel");
      expect(await promise).toEqual({ success: false, cause: "cancelled" });
    });
  });
});
