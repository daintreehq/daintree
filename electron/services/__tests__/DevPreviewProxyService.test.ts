import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { DevPreviewProxyService } from "../DevPreviewProxyService.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

// Bind a server to the IPv6 loopback ONLY (no IPv4) — reproduces Vite 8 on macOS, which resolves
// `localhost` to [::1] and binds IPv6-only. A proxy that hardcodes a 127.0.0.1 upstream can't
// reach this (#9747).
function listenIpv6Only(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "::1", port: 0, ipv6Only: true }, () =>
      resolve((server.address() as AddressInfo).port)
    );
  });
}

// Confirm the IPv6-only bind genuinely reproduces the bug: nothing is on IPv4, so a direct
// 127.0.0.1 connection (what the old proxy did) is refused. Guards the new tests against silently
// passing on a dual-stack upstream.
function expectIpv4Refused(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/", agent: false }, (res) => {
      res.destroy();
      req.destroy();
      reject(new Error(`expected ECONNREFUSED on 127.0.0.1:${port} but the request connected`));
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED") resolve();
      else reject(err);
    });
    req.end();
  });
}

// Some sandboxed/exotic environments can't bind [::1] at all — probe once and skip the IPv6-only
// cases there rather than reporting a misleading pass. Ubuntu/macOS CI runners support it.
const canBindIpv6Only = await new Promise<boolean>((resolve) => {
  const probe = http.createServer();
  probe.once("error", () => resolve(false));
  probe.listen({ host: "::1", port: 0, ipv6Only: true }, () => {
    probe.close(() => resolve(true));
  });
});

interface ProxyResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function request(
  proxyPort: number,
  host: string,
  path = "/",
  method = "GET"
): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      // agent: false — disable the global keep-alive pool so a socket pooled to the fixed
      // proxy port from a prior test (whose proxy was disposed) is never reused.
      { host: "127.0.0.1", port: proxyPort, path, method, headers: { host }, agent: false },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// Split a minted bootstrap URL into the (host, path+query) a loopback request
// needs — Node doesn't resolve *.localhost, so we hit 127.0.0.1 and pass the
// subdomain via the Host header.
function splitBootstrapUrl(bootstrapUrl: string): { host: string; path: string } {
  const u = new URL(bootstrapUrl);
  return { host: u.host, path: `${u.pathname}${u.search}` };
}

describe("DevPreviewProxyService", () => {
  let proxy: DevPreviewProxyService | null = null;
  let upstream: http.Server | null = null;
  let wss: WebSocketServer | null = null;

  afterEach(() => {
    proxy?.dispose();
    proxy = null;
    upstream?.close();
    upstream = null;
    wss?.close();
    wss = null;
  });

  it("forwards an HTTP request to the resolved upstream port and rewrites Host", async () => {
    let seenHost: string | undefined;
    upstream = http.createServer((req, res) => {
      seenHost = req.headers.host;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello from upstream");
    });
    const upstreamPort = await listen(upstream);

    proxy = new DevPreviewProxyService((sub) => (sub === "dp-test" ? upstreamPort : null));
    const proxyPort = await proxy.start();

    const res = await request(proxyPort, `dp-test.localhost:${proxyPort}`);

    expect(res.status).toBe(200);
    expect(res.body).toBe("hello from upstream");
    // changeOrigin rewrote the Host away from the proxy subdomain to the upstream — Vite/Next
    // host checks depend on this. The upstream target host is "localhost" (#9747), so the
    // rewritten Host carries that hostname rather than the proxy's `dp-*` subdomain.
    expect(seenHost).not.toContain("dp-test");
    expect(seenHost).toContain("localhost");
    expect(seenHost).toContain(String(upstreamPort));
  });

  it.skipIf(!canBindIpv6Only)(
    "forwards an HTTP request to an IPv6-only upstream (Vite IPv6-only bind, #9747)",
    async () => {
      upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("hello over ipv6");
      });
      const upstreamPort = await listenIpv6Only(upstream);
      // Sanity-check the fixture: the old 127.0.0.1 upstream target can't reach this server.
      await expectIpv4Refused(upstreamPort);

      proxy = new DevPreviewProxyService((sub) => (sub === "dp-test" ? upstreamPort : null));
      const proxyPort = await proxy.start();

      const res = await request(proxyPort, `dp-test.localhost:${proxyPort}`);

      // The proxy now targets `localhost`, so Node's Happy Eyeballs reaches the IPv6-only
      // upstream instead of 502ing.
      expect(res.status).toBe(200);
      expect(res.body).toBe("hello over ipv6");
    }
  );

  it.skipIf(!canBindIpv6Only)(
    "forwards a WebSocket upgrade to an IPv6-only upstream (HMR over IPv6, #9747)",
    async () => {
      // ws's port option doesn't forward ipv6Only, so bind the http server ourselves and hand it
      // to WebSocketServer. Assigning it to `upstream` lets afterEach close it.
      const httpServer = http.createServer();
      const upstreamPort = await listenIpv6Only(httpServer);
      await expectIpv4Refused(upstreamPort);
      upstream = httpServer;
      wss = new WebSocketServer({ server: httpServer });
      wss.on("connection", (socket) => {
        socket.on("message", (msg) => socket.send(`echo:${msg}`));
      });

      proxy = new DevPreviewProxyService(() => upstreamPort);
      const proxyPort = await proxy.start();

      const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/`, {
        headers: { host: `dp-test.localhost:${proxyPort}` },
      });
      const reply = await new Promise<string>((resolve, reject) => {
        client.on("open", () => client.send("ping"));
        client.on("message", (data) => resolve(data.toString()));
        client.on("error", reject);
      });
      client.close();

      expect(reply).toBe("echo:ping");
    }
  );

  it("strips the Domain attribute from upstream Set-Cookie headers", async () => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "Set-Cookie": "sid=abc; Domain=localhost; Path=/" });
      res.end("ok");
    });
    const upstreamPort = await listen(upstream);

    proxy = new DevPreviewProxyService(() => upstreamPort);
    const proxyPort = await proxy.start();

    const res = await request(proxyPort, `dp-test.localhost:${proxyPort}`);
    const setCookie = res.headers["set-cookie"]?.[0] ?? "";

    expect(setCookie).toContain("sid=abc");
    expect(setCookie.toLowerCase()).not.toContain("domain=");
  });

  it("strips Domain from every Set-Cookie header (multiple cookies, incl. Domain=.localhost)", async () => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Set-Cookie": [
          "sid=abc; Domain=.localhost; Path=/",
          "uid=xyz; Domain=localhost; SameSite=None",
        ],
      });
      res.end("ok");
    });
    const upstreamPort = await listen(upstream);

    proxy = new DevPreviewProxyService(() => upstreamPort);
    const proxyPort = await proxy.start();

    const res = await request(proxyPort, `dp-test.localhost:${proxyPort}`);
    const cookies = res.headers["set-cookie"] ?? [];

    expect(cookies).toHaveLength(2);
    expect(cookies.join(" ")).toContain("sid=abc");
    expect(cookies.join(" ")).toContain("uid=xyz");
    for (const cookie of cookies) {
      expect(cookie.toLowerCase()).not.toContain("domain=");
    }
  });

  it("returns 502 when no upstream is registered for the subdomain", async () => {
    proxy = new DevPreviewProxyService(() => null);
    const proxyPort = await proxy.start();

    const res = await request(proxyPort, `dp-missing.localhost:${proxyPort}`);
    expect(res.status).toBe(502);
  });

  it("returns 502 for a host that is not a dev-preview proxy subdomain", async () => {
    proxy = new DevPreviewProxyService(() => 9999);
    const proxyPort = await proxy.start();

    const res = await request(proxyPort, "example.com");
    expect(res.status).toBe(502);
  });

  it("returns 502 when the upstream is unreachable", async () => {
    // Resolve to a port nothing is listening on.
    proxy = new DevPreviewProxyService(() => 1);
    const proxyPort = await proxy.start();

    const res = await request(proxyPort, `dp-test.localhost:${proxyPort}`);
    expect(res.status).toBe(502);
  });

  it("exposes the bound port and is idempotent on start", async () => {
    proxy = new DevPreviewProxyService(() => null);
    const first = await proxy.start();
    const second = await proxy.start();

    expect(first).toBe(second);
    expect(proxy.port).toBe(first);
  });

  it("forwards a WebSocket upgrade to the resolved upstream", async () => {
    wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss!.on("listening", resolve));
    const upstreamPort = (wss.address() as AddressInfo).port;
    wss.on("connection", (socket) => {
      socket.on("message", (msg) => socket.send(`echo:${msg}`));
    });

    proxy = new DevPreviewProxyService(() => upstreamPort);
    const proxyPort = await proxy.start();

    // Node doesn't map *.localhost to loopback (only Chromium does), so connect to the loopback
    // address and override the Host header to the proxy subdomain.
    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/`, {
      headers: { host: `dp-test.localhost:${proxyPort}` },
    });
    const reply = await new Promise<string>((resolve, reject) => {
      client.on("open", () => client.send("ping"));
      client.on("message", (data) => resolve(data.toString()));
      client.on("error", reject);
    });
    client.close();

    expect(reply).toBe("echo:ping");
  });

  it("preserves the request path and query string on a WS upgrade (HMR)", async () => {
    let seenUrl: string | undefined;
    wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss!.on("listening", resolve));
    const upstreamPort = (wss.address() as AddressInfo).port;
    wss.on("connection", (socket, req) => {
      seenUrl = req.url;
      socket.send("ok");
    });

    proxy = new DevPreviewProxyService(() => upstreamPort);
    const proxyPort = await proxy.start();

    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/@vite/client?t=123`, {
      headers: { host: `dp-test.localhost:${proxyPort}` },
    });
    await new Promise<void>((resolve, reject) => {
      client.on("message", () => resolve());
      client.on("error", reject);
    });
    client.close();

    expect(seenUrl).toBe("/@vite/client?t=123");
  });

  it("destroys the upgrade socket when no upstream is registered", async () => {
    proxy = new DevPreviewProxyService(() => null);
    const proxyPort = await proxy.start();

    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/`, {
      headers: { host: `dp-missing.localhost:${proxyPort}` },
    });
    await expect(
      new Promise((_resolve, reject) => {
        client.on("open", () => reject(new Error("unexpected open")));
        client.on("error", reject);
        client.on("close", () => reject(new Error("closed")));
      })
    ).rejects.toBeTruthy();
  });

  it("stops accepting connections after dispose", async () => {
    proxy = new DevPreviewProxyService(() => null);
    const proxyPort = await proxy.start();
    proxy.dispose();

    await expect(request(proxyPort, `dp-x.localhost:${proxyPort}`)).rejects.toBeTruthy();
  });

  describe("browser handoff bootstrap (#9101)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("302-redirects a valid token to its payload path and sets a scoped session cookie", async () => {
      proxy = new DevPreviewProxyService(() => null);
      const proxyPort = await proxy.start();

      const bootstrapUrl = proxy.mintBrowserToken("panel-1", "proj-1", "/dashboard?tab=2");
      const { host, path } = splitBootstrapUrl(bootstrapUrl);
      const res = await request(proxyPort, host, path);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/dashboard?tab=2");
      const cookie = res.headers["set-cookie"]?.[0] ?? "";
      expect(cookie).toContain("__dp_sess=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Max-Age=60");
      // Domain= would be rejected by Chromium on .localhost — the cookie must be host-only.
      expect(cookie.toLowerCase()).not.toContain("domain=");
    });

    it("mints a bootstrap URL on the panel's stable origin", async () => {
      proxy = new DevPreviewProxyService(() => null);
      await proxy.start();

      const bootstrapUrl = proxy.mintBrowserToken("panel-1", "proj-1", "/x");
      const u = new URL(bootstrapUrl);
      expect(u.hostname).toBe(`dp-proj-1-panel-1.localhost`);
      expect(u.pathname).toBe("/_daintree/bootstrap");
      expect(u.searchParams.get("token")).toBeTruthy();
    });

    it("rejects a token on its second use (single-use)", async () => {
      proxy = new DevPreviewProxyService(() => null);
      const proxyPort = await proxy.start();

      const bootstrapUrl = proxy.mintBrowserToken("panel-1", "proj-1", "/");
      const { host, path } = splitBootstrapUrl(bootstrapUrl);

      const first = await request(proxyPort, host, path);
      expect(first.status).toBe(302);

      const second = await request(proxyPort, host, path);
      expect(second.status).toBe(403);
    });

    it("redirects to the signed payload path, ignoring a tampered rd query param", async () => {
      proxy = new DevPreviewProxyService(() => null);
      const proxyPort = await proxy.start();

      const bootstrapUrl = proxy.mintBrowserToken("panel-1", "proj-1", "/safe");
      const u = new URL(bootstrapUrl);
      // Attacker swaps rd to an open-redirect target; the proxy must use the
      // payload's path, not the query param.
      u.searchParams.set("rd", "//evil.com");
      const res = await request(proxyPort, u.host, `${u.pathname}${u.search}`);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/safe");
    });

    it("rejects a forged/garbage token with 403", async () => {
      proxy = new DevPreviewProxyService(() => null);
      const proxyPort = await proxy.start();

      const res = await request(
        proxyPort,
        `dp-proj-1-panel-1.localhost:${proxyPort}`,
        "/_daintree/bootstrap?token=not-a-real-token"
      );
      expect(res.status).toBe(403);
    });

    it("rejects a request with no token with 403", async () => {
      proxy = new DevPreviewProxyService(() => null);
      const proxyPort = await proxy.start();

      const res = await request(
        proxyPort,
        `dp-proj-1-panel-1.localhost:${proxyPort}`,
        "/_daintree/bootstrap"
      );
      expect(res.status).toBe(403);
    });

    it("rejects an expired token with 403", async () => {
      // Fake only the Date clock so HTTP/socket timers stay real; advance past the
      // 60s TTL between minting and redeeming.
      vi.useFakeTimers({ toFake: ["Date"] });
      proxy = new DevPreviewProxyService(() => null);
      const proxyPort = await proxy.start();

      const bootstrapUrl = proxy.mintBrowserToken("panel-1", "proj-1", "/");
      const { host, path } = splitBootstrapUrl(bootstrapUrl);

      vi.setSystemTime(Date.now() + 61_000);
      const res = await request(proxyPort, host, path);
      expect(res.status).toBe(403);
    });

    it("rejects a token redeemed against a different panel's origin (panel binding)", async () => {
      proxy = new DevPreviewProxyService(() => null);
      const proxyPort = await proxy.start();

      const bootstrapUrl = proxy.mintBrowserToken("panel-1", "proj-1", "/");
      const { path } = splitBootstrapUrl(bootstrapUrl);
      // Same token, but hit panel-2's origin — must be rejected and set no cookie.
      const res = await request(proxyPort, `dp-proj-1-panel-2.localhost:${proxyPort}`, path);

      expect(res.status).toBe(403);
      expect(res.headers["set-cookie"]).toBeUndefined();

      // And the token must still be valid for its real panel afterwards (a wrong-host
      // attempt must not burn it).
      const { host, path: realPath } = splitBootstrapUrl(bootstrapUrl);
      const real = await request(proxyPort, host, realPath);
      expect(real.status).toBe(302);
    });

    it("rejects HEAD without consuming the token, so the real GET still succeeds", async () => {
      proxy = new DevPreviewProxyService(() => null);
      const proxyPort = await proxy.start();

      const bootstrapUrl = proxy.mintBrowserToken("panel-1", "proj-1", "/");
      const { host, path } = splitBootstrapUrl(bootstrapUrl);

      const head = await request(proxyPort, host, path, "HEAD");
      expect(head.status).toBe(405);

      const get = await request(proxyPort, host, path);
      expect(get.status).toBe(302);
    });

    it("rejects a non-GET method on the bootstrap route with 405 without consuming the token", async () => {
      proxy = new DevPreviewProxyService(() => null);
      const proxyPort = await proxy.start();

      const bootstrapUrl = proxy.mintBrowserToken("panel-1", "proj-1", "/");
      const { host, path } = splitBootstrapUrl(bootstrapUrl);

      const post = await request(proxyPort, host, path, "POST");
      expect(post.status).toBe(405);

      // The rejected POST must not have burned the single-use token.
      const get = await request(proxyPort, host, path);
      expect(get.status).toBe(302);
    });

    it("treats a token at exactly its expiry as expired (boundary)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      proxy = new DevPreviewProxyService(() => null);
      const proxyPort = await proxy.start();

      const bootstrapUrl = proxy.mintBrowserToken("panel-1", "proj-1", "/");
      const { host, path } = splitBootstrapUrl(bootstrapUrl);

      // Advance to exactly the 60s TTL — verify and reaper both treat this as expired.
      vi.setSystemTime(Date.now() + 60_000);
      const res = await request(proxyPort, host, path);
      expect(res.status).toBe(403);
    });
  });
});
