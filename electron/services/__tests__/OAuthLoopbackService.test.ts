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

function fetchUrl(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
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

    it("rejects non-OAuth URLs", () => {
      expect(looksLikeOAuthUrl("https://example.com/page?foo=bar")).toBe(false);
    });

    it("rejects invalid URLs", () => {
      expect(looksLikeOAuthUrl("not a url")).toBe(false);
    });
  });

  describe("startOAuthLoopback", () => {
    it("returns null when auth URL has no redirect_uri", async () => {
      const result = await startOAuthLoopback(
        "https://auth.example.com/authorize?client_id=abc&response_type=code",
        "test-panel"
      );
      expect(result).toBeNull();
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
      expect(result).not.toBeNull();

      const resultUrl = new URL(result!.callbackUrl);
      expect(resultUrl.origin).toBe("http://localhost:3000");
      expect(resultUrl.pathname).toBe("/auth/callback");
      expect(resultUrl.searchParams.get("code")).toBe("AUTH_CODE_123");
      expect(resultUrl.searchParams.get("state")).toBe("xyz123");
      expect(result!.loopbackRedirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
      expect(result!.originalRedirectUri).toBe("http://localhost:3000/auth/callback");
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
      expect(result).not.toBeNull();

      const resultUrl = new URL(result!.callbackUrl);
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
      expect(result).toBeNull();
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

      // First should resolve as null (cancelled)
      const firstResult = await firstPromise;
      expect(firstResult).toBeNull();

      // Clean up second
      cancelOAuthLoopback("test-panel");
      const secondResult = await secondPromise;
      expect(secondResult).toBeNull();
    });

    it("allows concurrent flows on different panels", async () => {
      const authUrl =
        "https://auth.example.com/authorize?client_id=abc&response_type=code&redirect_uri=http://localhost:3000/auth/callback";

      const promiseA = startOAuthLoopback(authUrl, "panel-a");
      const promiseB = startOAuthLoopback(authUrl, "panel-b");

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

      expect(new URL(resultA!.callbackUrl).searchParams.get("code")).toBe("CODE_A");
      expect(new URL(resultB!.callbackUrl).searchParams.get("code")).toBe("CODE_B");
    });

    it("resolves null on cancel", async () => {
      const authUrl =
        "https://auth.example.com/authorize?client_id=abc&response_type=code&redirect_uri=http://localhost:3000/auth/callback";

      const promise = startOAuthLoopback(authUrl, "test-panel");

      await vi.waitFor(() => {
        expect(shell.openExternal).toHaveBeenCalledTimes(1);
      });

      cancelOAuthLoopback("test-panel");
      const result = await promise;
      expect(result).toBeNull();
    });
  });
});
