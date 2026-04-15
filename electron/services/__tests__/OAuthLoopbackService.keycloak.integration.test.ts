/**
 * OAuthLoopbackService — Real Keycloak Integration Test
 *
 * Spins up a Keycloak container in Docker, configures a test realm/client/user,
 * and runs the full OAuth authorization code + PKCE flow through a loopback
 * server to verify:
 *
 * 1. Keycloak accepts http://127.0.0.1:* as a valid redirect_uri
 * 2. The authorization code exchange SUCCEEDS with matching redirect_uri (after CDP rewrite)
 * 3. The authorization code exchange FAILS with mismatched redirect_uri (without CDP rewrite)
 *
 * Requires: Docker running. Skips gracefully if Docker is unavailable.
 *
 * Run with:
 *   npx vitest run --config vitest.integration.config.ts electron/services/__tests__/OAuthLoopbackService.keycloak.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import http from "http";
import { createServer } from "http";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const KEYCLOAK_IMAGE = "quay.io/keycloak/keycloak:26.1";
const CONTAINER_NAME = "daintree-oauth-test-kc";
const KC_PORT = 18080;
const KC_ADMIN_USER = "admin";
const KC_ADMIN_PASS = "admin";
const KC_BASE = `http://127.0.0.1:${KC_PORT}`;

const REALM = "daintree-test";
const CLIENT_ID = "test-frontend";
const TEST_USER = "testuser";
const TEST_PASS = "testpass123";

// ---------------------------------------------------------------------------
// Docker helpers
// ---------------------------------------------------------------------------

function isDockerAvailable(): boolean {
  try {
    execFileSync("docker", ["ps"], { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function startKeycloak(): void {
  try {
    execFileSync("docker", ["rm", "-f", CONTAINER_NAME], { encoding: "utf8", stdio: "pipe" });
  } catch {
    /* doesn't exist */
  }

  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      CONTAINER_NAME,
      "-p",
      `${KC_PORT}:8080`,
      "-e",
      `KC_BOOTSTRAP_ADMIN_USERNAME=${KC_ADMIN_USER}`,
      "-e",
      `KC_BOOTSTRAP_ADMIN_PASSWORD=${KC_ADMIN_PASS}`,
      "-e",
      "KC_HEALTH_ENABLED=true",
      "-e",
      "KC_HOSTNAME_STRICT=false",
      "-e",
      "KC_HTTP_ENABLED=true",
      KEYCLOAK_IMAGE,
      "start-dev",
      "--spi-cookie-default-secure=false",
    ],
    { encoding: "utf8", stdio: "pipe" }
  );
}

function stopKeycloak(): void {
  try {
    execFileSync("docker", ["rm", "-f", CONTAINER_NAME], { encoding: "utf8", stdio: "pipe" });
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// HTTP helper (no external deps)
// ---------------------------------------------------------------------------

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    followRedirects?: boolean;
  } = {}
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: options.method ?? "GET", headers: options.headers },
      (res) => {
        if (
          options.followRedirects &&
          res.statusCode &&
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location
        ) {
          const redirectUrl = new URL(res.headers.location, url).toString();
          resolve(httpRequest(redirectUrl, options));
          return;
        }

        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function waitForKeycloak(timeoutMs = 180_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Try health endpoint first, fall back to master realm discovery
      const healthRes = await httpRequest(`${KC_BASE}/health/ready`);
      if (healthRes.status === 200) return;

      const realmRes = await httpRequest(`${KC_BASE}/realms/master`);
      if (realmRes.status === 200) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Keycloak not ready after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Keycloak Admin API
// ---------------------------------------------------------------------------

async function getAdminToken(): Promise<string> {
  const res = await httpRequest(`${KC_BASE}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: KC_ADMIN_USER,
      password: KC_ADMIN_PASS,
    }).toString(),
  });
  if (res.status !== 200) throw new Error(`Admin token failed: ${res.status} ${res.body}`);
  return JSON.parse(res.body).access_token;
}

async function setupRealmClientUser(token: string): Promise<void> {
  // Create realm
  await httpRequest(`${KC_BASE}/admin/realms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ realm: REALM, enabled: true }),
  });

  // Create public client with loopback + localhost redirect URIs
  await httpRequest(`${KC_BASE}/admin/realms/${REALM}/clients`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: CLIENT_ID,
      enabled: true,
      publicClient: true,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      redirectUris: ["http://127.0.0.1:*", "http://localhost:*"],
      webOrigins: ["+"],
      attributes: { "pkce.code.challenge.method": "S256" },
    }),
  });

  // Disable VERIFY_PROFILE required action (Keycloak 26+ enables it by default)
  await httpRequest(
    `${KC_BASE}/admin/realms/${REALM}/authentication/required-actions/VERIFY_PROFILE`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        alias: "VERIFY_PROFILE",
        name: "Verify Profile",
        providerId: "VERIFY_PROFILE",
        enabled: false,
        defaultAction: false,
        priority: 90,
      }),
    }
  );

  // Create user with password + profile fields to avoid required actions
  await httpRequest(`${KC_BASE}/admin/realms/${REALM}/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      username: TEST_USER,
      enabled: true,
      emailVerified: true,
      email: `${TEST_USER}@test.local`,
      firstName: "Test",
      lastName: "User",
      credentials: [{ type: "password", value: TEST_PASS, temporary: false }],
    }),
  });
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Buffer.from(array).toString("base64url");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}

// ---------------------------------------------------------------------------
// Browser simulation — HTTP-based OAuth login
// ---------------------------------------------------------------------------

async function simulateBrowserLogin(authUrl: string): Promise<string> {
  // GET auth page
  const authPage = await httpRequest(authUrl);
  if (authPage.status !== 200) {
    throw new Error(`Auth page returned ${authPage.status}: ${authPage.body.slice(0, 200)}`);
  }

  // Extract cookies
  const setCookies = authPage.headers["set-cookie"] ?? [];
  const cookieJar = (Array.isArray(setCookies) ? setCookies : [setCookies])
    .map((c) => c.split(";")[0])
    .join("; ");

  // Parse form action URL
  const actionMatch = authPage.body.match(/action="([^"]+)"/);
  if (!actionMatch) throw new Error("No login form action URL found");
  const actionUrl = actionMatch[1].replace(/&amp;/g, "&");

  // POST credentials
  const loginRes = await httpRequest(actionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieJar },
    body: new URLSearchParams({ username: TEST_USER, password: TEST_PASS }).toString(),
    followRedirects: false,
  });

  if (loginRes.status !== 302) {
    throw new Error(
      `Login returned ${loginRes.status} (expected 302): ${loginRes.body.slice(0, 300)}`
    );
  }

  if (!loginRes.headers.location) throw new Error("No Location header in login redirect");
  return loginRes.headers.location;
}

/**
 * Run the full auth code flow: auth request → browser login → capture code on loopback
 */
async function getAuthCodeViaLoopback(
  codeChallenge: string,
  state: string
): Promise<{ code: string; loopbackUri: string }> {
  return new Promise((resolve, reject) => {
    let serverPort = 0;

    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = reqUrl.searchParams.get("code");
      res.writeHead(200);
      res.end("OK");
      server.close();
      if (code) {
        resolve({ code, loopbackUri: `http://127.0.0.1:${serverPort}/callback` });
      } else {
        reject(new Error(`No code in callback: ${req.url}`));
      }
    });

    server.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("No address"));
      serverPort = addr.port;

      const redirectUri = `http://127.0.0.1:${serverPort}/callback`;
      const authUrl =
        `${KC_BASE}/realms/${REALM}/protocol/openid-connect/auth` +
        `?client_id=${CLIENT_ID}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${state}` +
        `&scope=openid` +
        `&code_challenge=${codeChallenge}` +
        `&code_challenge_method=S256`;

      try {
        const callbackLocation = await simulateBrowserLogin(authUrl);
        // Hit the loopback server with the callback
        await httpRequest(callbackLocation);
      } catch (err) {
        server.close();
        reject(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OAuthLoopbackService — Real Keycloak", () => {
  const dockerAvailable = isDockerAvailable();

  beforeAll(async () => {
    if (!dockerAvailable) return;

    console.log("Starting Keycloak container...");
    startKeycloak();

    console.log("Waiting for Keycloak to be ready...");
    await waitForKeycloak();

    console.log("Configuring test realm, client, and user...");
    const token = await getAdminToken();
    await setupRealmClientUser(token);

    console.log("Keycloak ready.");
  }, 180_000);

  afterAll(() => {
    if (dockerAvailable) {
      console.log("Stopping Keycloak container...");
      stopKeycloak();
    }
  });

  it.skipIf(!dockerAvailable)(
    "PASS: token exchange succeeds with matching loopback redirect_uri + valid PKCE",
    async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const state = "match_" + Date.now();

      const { code, loopbackUri } = await getAuthCodeViaLoopback(codeChallenge, state);
      expect(code).toBeTruthy();

      // Exchange code with MATCHING redirect_uri (what CDP rewrite produces)
      const tokenRes = await httpRequest(
        `${KC_BASE}/realms/${REALM}/protocol/openid-connect/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code,
            redirect_uri: loopbackUri, // MATCHES auth request
            code_verifier: codeVerifier,
          }).toString(),
        }
      );

      if (tokenRes.status !== 200) {
        console.error("Token exchange failed:", tokenRes.status, tokenRes.body);
        console.error("redirect_uri sent:", loopbackUri);
        console.error("code:", code.substring(0, 20) + "...");
      }
      expect(tokenRes.status).toBe(200);
      const tokens = JSON.parse(tokenRes.body);
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.id_token).toBeTruthy();
      expect(tokens.token_type).toBe("Bearer");
    },
    60_000
  );

  it.skipIf(!dockerAvailable)(
    "FAIL: token exchange rejected with mismatched redirect_uri (proves CDP fix is necessary)",
    async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const state = "mismatch_" + Date.now();

      const { code } = await getAuthCodeViaLoopback(codeChallenge, state);
      expect(code).toBeTruthy();

      // Exchange with WRONG redirect_uri (what happens WITHOUT CDP fix)
      const tokenRes = await httpRequest(
        `${KC_BASE}/realms/${REALM}/protocol/openid-connect/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code,
            redirect_uri: "http://localhost:3000/auth/callback", // MISMATCH
            code_verifier: codeVerifier,
          }).toString(),
        }
      );

      expect(tokenRes.status).toBe(400);
      const error = JSON.parse(tokenRes.body);
      expect(error.error).toBe("invalid_grant");
    },
    60_000
  );

  it.skipIf(!dockerAvailable)(
    "FAIL: wrong PKCE code_verifier rejected even with correct redirect_uri",
    async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const state = "pkce_" + Date.now();

      const { code, loopbackUri } = await getAuthCodeViaLoopback(codeChallenge, state);
      expect(code).toBeTruthy();

      // Exchange with correct redirect_uri but WRONG code_verifier
      const tokenRes = await httpRequest(
        `${KC_BASE}/realms/${REALM}/protocol/openid-connect/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code,
            redirect_uri: loopbackUri,
            code_verifier: "WRONG_VERIFIER_" + Date.now(),
          }).toString(),
        }
      );

      expect(tokenRes.status).toBe(400);
      const error = JSON.parse(tokenRes.body);
      expect(error.error).toBe("invalid_grant");
    },
    60_000
  );
});
