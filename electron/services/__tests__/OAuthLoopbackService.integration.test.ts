import { describe, it, expect, vi, afterEach } from "vitest";
import http from "http";

/**
 * Integration test: Full OAuth redirect chain with a fake IdP.
 *
 * Simulates the real-world scenario:
 * 1. App redirects to external IdP (fake HTTP server)
 * 2. User "authenticates" (fake IdP auto-approves)
 * 3. IdP redirects to Canopy's loopback server with code + state
 * 4. Canopy captures the callback and builds the original callback URL
 *
 * No real Keycloak, no real browser — pure HTTP round-trip.
 */

let fakeIdpServer: http.Server | null = null;
let capturedOpenExternalUrl: string | null = null;

vi.mock("electron", () => ({
  shell: {
    // Instead of opening a real browser, simulate the IdP redirect chain
    openExternal: vi.fn(async (url: string) => {
      capturedOpenExternalUrl = url;
      // Parse the auth URL to extract redirect_uri (Canopy's loopback)
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get("redirect_uri");
      const state = parsed.searchParams.get("state");

      if (!redirectUri) throw new Error("No redirect_uri in auth URL");

      // Simulate IdP: after "authentication", redirect to the loopback with a code
      // Small delay to simulate network round-trip
      setTimeout(() => {
        const callbackUrl = `${redirectUri}?code=FAKE_AUTH_CODE_${Date.now()}&state=${state || ""}`;
        http.get(callbackUrl).on("error", () => {
          // Connection may be refused if server already shut down — that's fine
        });
      }, 50);
    }),
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

/**
 * Start a fake IdP server that mimics an OAuth authorization endpoint.
 * When it receives a GET /authorize request, it:
 * 1. Validates client_id, response_type, redirect_uri, state
 * 2. "Authenticates" the user (auto-approve)
 * 3. Redirects to redirect_uri with code + state
 */
function startFakeIdp(): Promise<{ port: number; url: string }> {
  return new Promise((resolve) => {
    fakeIdpServer = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");

      if (reqUrl.pathname === "/authorize") {
        const redirectUri = reqUrl.searchParams.get("redirect_uri");
        const state = reqUrl.searchParams.get("state");
        const clientId = reqUrl.searchParams.get("client_id");
        const responseType = reqUrl.searchParams.get("response_type");

        if (!redirectUri || !clientId || responseType !== "code") {
          res.writeHead(400);
          res.end("Missing required OAuth params");
          return;
        }

        // "Authenticate" — issue a code and redirect
        const code = `FAKEIDP_CODE_${Date.now()}`;
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", code);
        if (state) callback.searchParams.set("state", state);

        res.writeHead(302, { Location: callback.toString() });
        res.end();
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });

    fakeIdpServer.listen(0, "127.0.0.1", () => {
      const addr = fakeIdpServer!.address();
      if (!addr || typeof addr === "string") throw new Error("Failed to start fake IdP");
      const port = addr.port;
      resolve({ port, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stopFakeIdp(): void {
  if (fakeIdpServer) {
    fakeIdpServer.close();
    fakeIdpServer = null;
  }
}

function httpGet(
  url: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        // Don't follow redirects — capture the 302
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
      .on("error", reject);
  });
}

describe("OAuthLoopbackService — Integration with Fake IdP", () => {
  afterEach(() => {
    cancelOAuthLoopback("integration-panel");
    stopFakeIdp();
    capturedOpenExternalUrl = null;
    vi.clearAllMocks();
  });

  it("full chain: app → loopback → fake IdP → loopback → original callback URL", async () => {
    // Start fake IdP
    const idp = await startFakeIdp();

    // Build an auth URL like a real app would
    const originalCallbackUrl = "http://localhost:3000/auth/callback";
    const authUrl =
      `${idp.url}/authorize?client_id=test-app&response_type=code` +
      `&redirect_uri=${encodeURIComponent(originalCallbackUrl)}` +
      `&state=random_state_abc&scope=openid+email+profile` +
      `&code_challenge=fakechallenge123&code_challenge_method=S256`;

    // Verify detection
    expect(looksLikeOAuthUrl(authUrl)).toBe(true);

    // Start the loopback flow — the mocked shell.openExternal will
    // simulate the IdP by hitting the loopback callback directly
    const result = await startOAuthLoopback(authUrl, "integration-panel");

    // Should have captured the rewritten URL
    expect(capturedOpenExternalUrl).not.toBeNull();
    const rewrittenUrl = new URL(capturedOpenExternalUrl!);

    // Verify redirect_uri was rewritten to loopback
    const rewrittenRedirect = rewrittenUrl.searchParams.get("redirect_uri")!;
    expect(rewrittenRedirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);

    // Verify all other params preserved
    expect(rewrittenUrl.searchParams.get("client_id")).toBe("test-app");
    expect(rewrittenUrl.searchParams.get("response_type")).toBe("code");
    expect(rewrittenUrl.searchParams.get("state")).toBe("random_state_abc");
    expect(rewrittenUrl.searchParams.get("scope")).toBe("openid email profile");
    expect(rewrittenUrl.searchParams.get("code_challenge")).toBe("fakechallenge123");
    expect(rewrittenUrl.searchParams.get("code_challenge_method")).toBe("S256");

    // Verify the result is the ORIGINAL callback URL with captured params
    expect(result).not.toBeNull();
    const resultUrl = new URL(result!.callbackUrl);
    expect(resultUrl.origin).toBe("http://localhost:3000");
    expect(resultUrl.pathname).toBe("/auth/callback");
    expect(resultUrl.searchParams.get("code")).toMatch(/^FAKE_AUTH_CODE_/);
    expect(resultUrl.searchParams.get("state")).toBe("random_state_abc");
  });

  it("fake IdP validates required params and returns 400 on missing client_id", async () => {
    const idp = await startFakeIdp();

    // Missing client_id
    const response = await httpGet(
      `${idp.url}/authorize?response_type=code&redirect_uri=http://localhost:3000/callback`
    );
    expect(response.status).toBe(400);
  });

  it("fake IdP issues 302 redirect with code and state", async () => {
    const idp = await startFakeIdp();

    const response = await httpGet(
      `${idp.url}/authorize?client_id=app&response_type=code` +
        `&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}` +
        `&state=mystate`
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.location!);
    expect(location.origin).toBe("http://localhost:3000");
    expect(location.pathname).toBe("/callback");
    expect(location.searchParams.get("code")).toMatch(/^FAKEIDP_CODE_/);
    expect(location.searchParams.get("state")).toBe("mystate");
  });

  it("preserves complex redirect_uri with existing query params", async () => {
    const originalCallback = "http://localhost:5173/api/auth/callback?provider=keycloak";
    const authUrl =
      `https://auth.example.com/realms/test/protocol/openid-connect/auth` +
      `?client_id=my-app&response_type=code` +
      `&redirect_uri=${encodeURIComponent(originalCallback)}` +
      `&state=complex_state`;

    const resultPromise = startOAuthLoopback(authUrl, "integration-panel");

    // Wait for shell.openExternal to be called, then resolve
    await vi.waitFor(() => {
      expect(capturedOpenExternalUrl).not.toBeNull();
    });

    // Manually hit the loopback server (simulating the IdP redirect)
    const rewrittenRedirect = new URL(capturedOpenExternalUrl!).searchParams.get("redirect_uri")!;
    await httpGet(`${rewrittenRedirect}?code=MYCODE&state=complex_state`);

    const result = await resultPromise;
    expect(result).not.toBeNull();

    const resultUrl = new URL(result!.callbackUrl);
    expect(resultUrl.origin).toBe("http://localhost:5173");
    expect(resultUrl.pathname).toBe("/api/auth/callback");
    // Original query param preserved
    expect(resultUrl.searchParams.get("provider")).toBe("keycloak");
    // Captured OAuth params added
    expect(resultUrl.searchParams.get("code")).toBe("MYCODE");
    expect(resultUrl.searchParams.get("state")).toBe("complex_state");
  });
});
