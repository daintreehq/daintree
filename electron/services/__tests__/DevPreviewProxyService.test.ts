import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  DevPreviewProxyService,
  type DevPreviewProxyDiagnostic,
} from "../DevPreviewProxyService.js";
import { DEV_PREVIEW_PROXY_PORT } from "../../../shared/utils/devPreviewProxy.js";

// A self-signed cert/key for `localhost`, valid for 100 years, used to stand up a real TLS
// upstream so the proxy's HTTPS path (#9974) is exercised end-to-end. The proxy dials with
// `secure: false`, so cert validity is never checked on the proxy→upstream leg — the only
// requirement is that https.createServer accepts the pair. Static so the test needs no openssl
// or extra dependency at run time.
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUd5lHuFW2jPIhjMPtLtk+qyD6nV4wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDYwNjE4NTUxOFoYDzIxMjYw
NTEzMTg1NTE4WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDKUZfRfHBM/L/qO8t1YUyiXytEb2K7CiyeNjtg1P3v
O31d9yJez1S5h8Bsdf0/aGmKh8awxTA712A7D3xeioPYPCgzogeGhlXLIlMvEMDM
mcP9dCJdEeqeWxFpJBDmMtQ6ye3OGGdYAd5WXJ38uGpcbifiL1xnPM3czft0efWD
JklK7ou0QZhiliVLuDTJSb/KE5tSCo9HV4ognxyY1BEk25HgQT6YsGtJBgtG1QW4
swzdRGCbbbTdSBE0Vf0c/C66VwReSmPaqyiQytxNtjuF/CjmtXUkselRoiPPileF
/kUsOQJPo/T+eE7XlqPYZo8oeH2jX0+TYYERJ5ktrS3vAgMBAAGjbzBtMB0GA1Ud
DgQWBBRP0Q6ccyHBJCBvkQwvMXKmvVIEgDAfBgNVHSMEGDAWgBRP0Q6ccyHBJCBv
kQwvMXKmvVIEgDAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAuEPF9RQD1gSDulkRHe+Yosm5dCvv
JM8oz+h/QFPSboEaDc/+IGFGzQoVNiAqoJJnFMT2N/Fr/c5rAG7pn9JlFR5ZGskM
aMBfUDUZ3sNDRGW4Ck7hCpNM4P6Ng40STy68QoChIW+HJUyFPOmnSQCTg0pAGYtD
ctdDEYvgjudRbtc77vJH1eB79mnyHStg+KbrKkvP5KKDfJIx9xUbc61sEomFlSqw
CqQ2POpyTKAVRq4DynrN19R5FgRg9fjze0+k6iRc9nReB/As7XD3KA04qFXTpuIB
8aUneA5Et8htP8zGKtPvZ2seWZobUf5GxFX3RYl+CFEMDSifjmq68BKnVQ==
-----END CERTIFICATE-----
`;
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDKUZfRfHBM/L/q
O8t1YUyiXytEb2K7CiyeNjtg1P3vO31d9yJez1S5h8Bsdf0/aGmKh8awxTA712A7
D3xeioPYPCgzogeGhlXLIlMvEMDMmcP9dCJdEeqeWxFpJBDmMtQ6ye3OGGdYAd5W
XJ38uGpcbifiL1xnPM3czft0efWDJklK7ou0QZhiliVLuDTJSb/KE5tSCo9HV4og
nxyY1BEk25HgQT6YsGtJBgtG1QW4swzdRGCbbbTdSBE0Vf0c/C66VwReSmPaqyiQ
ytxNtjuF/CjmtXUkselRoiPPileF/kUsOQJPo/T+eE7XlqPYZo8oeH2jX0+TYYER
J5ktrS3vAgMBAAECggEAPP9ypW8+MIf3mLhkdERcpYvJ8L0gaEH+B8lUB7LPyMQH
3T+4dhtOcQ1zv3+nVem2AFVFW2BoVXJvCf92QM7ER3qDqGWOnUl9Llxv9f24Eze8
9nqALc1MDmhojGmaSr1CbWMaNov3BHqzvRf5bgtvzeRMVA5xbpLPgmX8DTcEBYEJ
TIgUZJwbIC7HE00fQkRl2JUewG40HHxhKi4V933C71D9RzveZ8PBEfbADf8+QSiM
PxceeGqmtE47dCqMGiYzZaO6Q5fgUKGnDJ/+saoZta5lpCRPLE23Kz9B0OVZxUuD
H5zqTYyhWZxwMCLN+nPaChcZezvizC7OO7m2q2MpMQKBgQDpI6e6N9Ub1pR4epHV
4E0rVJ/ZYqHFxnuJND6TfLVMU2InazVvfW8GaC6rPgR1+3TeKVOLrCV80qM4R2s6
cHZ2slQE4UTKKNrWMlIMZfRVd1gI4Ht6SgyS1qCbcjOHLEp0LsayxV2Wz/ysotbK
zGqZtvuugN9KD+PIIKA3ggtjpwKBgQDeKET0HywPJESkVGfh8XozdOHunRzU0W1Z
kyhyVqWByENyJnchFagFibAUN+6nwTJzr5vRxDbhzmLGNi8TGLO4DyzBv5AM+LkY
dutnptzk9XCowZk6rlMMIDQ3WRZcikwSP5ZHKho6SjzZ0bnSXv8MhNeZJG0AZSPa
do+DSk7MeQKBgQDMaPOlpVBXcSOKIsV9BYYDqNXibsUyN92WpdT70YrQGgfkUe5v
C0ZuEqhggia9HzUPmKJkwxG3SKPNM2lDutlTJvXdtXlv2rRMu6AOuNGqodHxLol0
5jnyAPaedFnTebTp+x1CHyP4l/GNl9TFyMbqcXJoRRwBvr7TeC+hm4bK3wKBgDHh
gtH5adAgiZUIKqcNrC1/kfccqcuTFmVlaFB76f+A8rvfrSHtleNgbfusL1bVRzm4
dVkdIGGFEKKGqf00r62lIpyCIZr4Ab9ffC2yxqhV/6y0g24slBMF7BN9Wkr+9mOm
iVyDNI5f+tfBgmKc19F8xlfpWNwc2XcE5eZJufWpAoGAAUl4oGptD1l4cM15Jt3O
2GTUNwI14gU/+A/Ht0tFz4L0L059PrE0e+5tpPPH6YHDQQBCQywSSYz6a4hnOovA
eKhMdxcFUL4ump1TiBK9mci/EeN5QPFQ5MirHkPgm5Hqi/4MK3pbF+yWHHNuKN1v
+gRGPjjegyhNAcadNKTocko=
-----END PRIVATE KEY-----
`;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function listenTls(server: https.Server): Promise<number> {
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
  let tlsUpstream: https.Server | null = null;
  let wss: WebSocketServer | null = null;

  afterEach(() => {
    proxy?.dispose();
    proxy = null;
    upstream?.close();
    upstream = null;
    tlsUpstream?.close();
    tlsUpstream = null;
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

    proxy = new DevPreviewProxyService((sub) =>
      sub === "dp-test" ? { port: upstreamPort, isHttps: false } : null
    );
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

      proxy = new DevPreviewProxyService((sub) =>
        sub === "dp-test" ? { port: upstreamPort, isHttps: false } : null
      );
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

      proxy = new DevPreviewProxyService(() => ({ port: upstreamPort, isHttps: false }));
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

  it("forwards an HTTP request to an HTTPS (TLS) upstream with a self-signed cert (#9974)", async () => {
    let seenHost: string | undefined;
    tlsUpstream = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (req, res) => {
      seenHost = req.headers.host;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello over tls");
    });
    const upstreamPort = await listenTls(tlsUpstream);

    proxy = new DevPreviewProxyService((sub) =>
      sub === "dp-test" ? { port: upstreamPort, isHttps: true } : null
    );
    const proxyPort = await proxy.start();

    const res = await request(proxyPort, `dp-test.localhost:${proxyPort}`);

    // Without the isHttps fix the proxy dials http:// against a TLS socket and 502s. The fix
    // dials https:// with secure:false, so the self-signed cert is accepted and the request lands.
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello over tls");
    expect(seenHost).toContain("localhost");
    expect(seenHost).toContain(String(upstreamPort));
  });

  it("forwards a WebSocket upgrade to a WSS (TLS) upstream with a self-signed cert (#9974)", async () => {
    tlsUpstream = https.createServer({ cert: TLS_CERT, key: TLS_KEY });
    const upstreamPort = await listenTls(tlsUpstream);
    wss = new WebSocketServer({ server: tlsUpstream });
    wss.on("connection", (socket) => {
      socket.on("message", (msg) => socket.send(`echo:${msg}`));
    });

    proxy = new DevPreviewProxyService(() => ({ port: upstreamPort, isHttps: true }));
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

    // The upgrade must target wss:// (not http://) so the HMR socket reaches the TLS upstream.
    expect(reply).toBe("echo:ping");
  });

  it("preserves the request path and query string on a WSS (TLS) upgrade (#9974)", async () => {
    let seenUrl: string | undefined;
    tlsUpstream = https.createServer({ cert: TLS_CERT, key: TLS_KEY });
    const upstreamPort = await listenTls(tlsUpstream);
    wss = new WebSocketServer({ server: tlsUpstream });
    wss.on("connection", (socket, req) => {
      seenUrl = req.url;
      socket.send("ok");
    });

    proxy = new DevPreviewProxyService(() => ({ port: upstreamPort, isHttps: true }));
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

  it("strips the Domain attribute from upstream Set-Cookie headers", async () => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "Set-Cookie": "sid=abc; Domain=localhost; Path=/" });
      res.end("ok");
    });
    const upstreamPort = await listen(upstream);

    proxy = new DevPreviewProxyService(() => ({ port: upstreamPort, isHttps: false }));
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

    proxy = new DevPreviewProxyService(() => ({ port: upstreamPort, isHttps: false }));
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
    proxy = new DevPreviewProxyService(() => ({ port: 9999, isHttps: false }));
    const proxyPort = await proxy.start();

    const res = await request(proxyPort, "example.com");
    expect(res.status).toBe(502);
  });

  it("returns 502 when the upstream is unreachable", async () => {
    // Resolve to a port nothing is listening on.
    proxy = new DevPreviewProxyService(() => ({ port: 1, isHttps: false }));
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

    proxy = new DevPreviewProxyService(() => ({ port: upstreamPort, isHttps: false }));
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

    proxy = new DevPreviewProxyService(() => ({ port: upstreamPort, isHttps: false }));
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

  describe("failure classification and diagnostics", () => {
    it("502s a not-running session with distinct copy and reports the cause", async () => {
      const onDiagnostic = vi.fn<(event: DevPreviewProxyDiagnostic) => void>();
      proxy = new DevPreviewProxyService(
        () => ({ kind: "not-running", status: "stopped" }),
        onDiagnostic
      );
      const proxyPort = await proxy.start();

      const res = await request(proxyPort, `dp-test.localhost:${proxyPort}`);

      expect(res.status).toBe(502);
      expect(res.body).toContain("isn't running");
      expect(onDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ subdomain: "dp-test", kind: "http", cause: "not-running" })
      );
    });

    it("reports no-session for an unknown subdomain and keeps the legacy copy", async () => {
      const onDiagnostic = vi.fn<(event: DevPreviewProxyDiagnostic) => void>();
      proxy = new DevPreviewProxyService(() => null, onDiagnostic);
      const proxyPort = await proxy.start();

      const res = await request(proxyPort, `dp-missing.localhost:${proxyPort}`);

      expect(res.status).toBe(502);
      expect(res.body).toContain("No dev server is registered");
      expect(onDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ subdomain: "dp-missing", kind: "http", cause: "no-session" })
      );
    });

    it("classifies a refused upstream dial as upstream-refused", async () => {
      const onDiagnostic = vi.fn<(event: DevPreviewProxyDiagnostic) => void>();
      // Port 1 is never listening — the dial is refused, not timed out.
      proxy = new DevPreviewProxyService(() => ({ port: 1, isHttps: false }), onDiagnostic);
      const proxyPort = await proxy.start();

      const res = await request(proxyPort, `dp-test.localhost:${proxyPort}`);

      expect(res.status).toBe(502);
      await vi.waitFor(() => {
        expect(onDiagnostic).toHaveBeenCalledWith(
          expect.objectContaining({ subdomain: "dp-test", kind: "http", cause: "upstream-refused" })
        );
      });
    });

    it("reports a WebSocket upgrade against a not-running session and destroys the socket", async () => {
      const onDiagnostic = vi.fn<(event: DevPreviewProxyDiagnostic) => void>();
      proxy = new DevPreviewProxyService(
        () => ({ kind: "not-running", status: "starting" }),
        onDiagnostic
      );
      const proxyPort = await proxy.start();

      const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/`, {
        headers: { host: `dp-test.localhost:${proxyPort}` },
      });
      await new Promise<void>((resolve) => {
        client.on("error", () => resolve());
        client.on("close", () => resolve());
      });

      expect(onDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ subdomain: "dp-test", kind: "ws", cause: "not-running" })
      );
    });

    it("never lets a throwing diagnostics listener break proxying", async () => {
      upstream = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      });
      const upstreamPort = await listen(upstream);
      proxy = new DevPreviewProxyService(
        (sub) => (sub === "dp-test" ? { port: upstreamPort, isHttps: false } : null),
        () => {
          throw new Error("listener exploded");
        }
      );
      const proxyPort = await proxy.start();

      const missing = await request(proxyPort, `dp-missing.localhost:${proxyPort}`);
      expect(missing.status).toBe(502);

      const ok = await request(proxyPort, `dp-test.localhost:${proxyPort}`);
      expect(ok.status).toBe(200);
    });

    it("marks the fallback port when the fixed proxy port is taken", async () => {
      // Occupy the fixed port ourselves; if some other process (a running
      // Daintree) already holds it, the fallback still engages — either way
      // the proxy must land elsewhere and say so.
      const blocker = http.createServer();
      await new Promise<void>((resolve) => {
        blocker.once("error", () => resolve());
        blocker.listen(DEV_PREVIEW_PROXY_PORT, "127.0.0.1", () => resolve());
      });
      try {
        proxy = new DevPreviewProxyService(() => null);
        const proxyPort = await proxy.start();

        expect(proxyPort).not.toBe(DEV_PREVIEW_PROXY_PORT);
        expect(proxy.usedPortFallback).toBe(true);
      } finally {
        blocker.close();
      }
    });
  });
});
