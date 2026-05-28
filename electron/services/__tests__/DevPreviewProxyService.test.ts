import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { DevPreviewProxyService } from "../DevPreviewProxyService.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

interface ProxyResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function request(proxyPort: number, host: string, path = "/"): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      // agent: false — disable the global keep-alive pool so a socket pooled to the fixed
      // proxy port from a prior test (whose proxy was disposed) is never reused.
      { host: "127.0.0.1", port: proxyPort, path, headers: { host }, agent: false },
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
    // host checks depend on this.
    expect(seenHost).toContain("127.0.0.1");
    expect(seenHost).toContain(String(upstreamPort));
  });

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
});
