import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { isForwardedLoopbackUrl } from "../../../../shared/utils/urlUtils.js";
import { DevPreviewProxyService } from "../../../services/DevPreviewProxyService.js";
import type { SshChild } from "../../client/sshTransport.js";
import type { LinkSession } from "../../link/session.js";
import {
  makeTempDir,
  openSessionPair,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import { installHostPortService } from "../hostPorts.js";
import { PortForwardManager, type PortForwardManagerDeps } from "../PortForwardManager.js";
import type { PreviewResolution } from "../linkMethods.js";

const HOST = "studio-01";

let dir: string;
let host: LinkSession;
let client: LinkSession;
const cleanups: Array<() => unknown> = [];

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
}

function manager(overrides: Partial<PortForwardManagerDeps> = {}): PortForwardManager {
  const m = new PortForwardManager({
    sessionFor: (hostId) => (hostId === HOST && client.isOpen ? client : null),
    connectedHosts: () => (client.isOpen ? [HOST] : []),
    isKnownHost: (hostId) => hostId === HOST,
    ...overrides,
  });
  cleanups.push(() => m.dispose());
  return m;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers, agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

let previewResolution: PreviewResolution = { kind: "unknown-subdomain" };

beforeEach(async () => {
  dir = await makeTempDir();
  ({ host, client } = await openSessionPair(dir));
  previewResolution = { kind: "unknown-subdomain" };
  const uninstall = installHostPortService(
    {
      onSession(listener) {
        listener({ session: host });
        return () => {};
      },
    },
    {
      scan: async () => [{ port: 5173, processName: "node", pid: 4242 }],
      resolvePreview: async () => previewResolution,
    }
  );
  cleanups.push(uninstall);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  host.close("test over");
  client.close("test over");
  await removeTempDir(dir);
});

describe("stream forwarding over the link", () => {
  it("forwards the host's actual port and carries HTTP with Host, cookies and redirects intact", async () => {
    const seen: Array<{ host?: string; cookie?: string }> = [];
    const upstream = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, cookie: req.headers.cookie });
      if (req.url === "/login") {
        res.writeHead(302, {
          Location: `http://${req.headers.host}/home`,
          "Set-Cookie": "sid=abc123; Path=/; HttpOnly",
        });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`home for ${req.headers.cookie ?? "nobody"}`);
    });
    const remotePort = await listen(upstream);
    cleanups.push(() => upstream.close());

    const m = manager();
    const forward = await m.forward({ hostId: HOST, remotePort });

    expect(forward.remotePort).toBe(remotePort);
    // The port is taken on this machine (the test's own upstream), so a free one is used.
    expect(forward.localPort).not.toBe(remotePort);

    const login = await get(forward.localPort, "/login", {
      Host: `localhost:${forward.localPort}`,
    });
    expect(login.status).toBe(302);
    expect(login.headers.location).toBe(`http://localhost:${forward.localPort}/home`);
    expect(login.headers["set-cookie"]).toEqual(["sid=abc123; Path=/; HttpOnly"]);

    const home = await get(forward.localPort, "/home", {
      Host: `localhost:${forward.localPort}`,
      Cookie: "sid=abc123",
    });
    expect(home.body).toBe("home for sid=abc123");
    expect(seen).toEqual([
      { host: `localhost:${forward.localPort}`, cookie: undefined },
      { host: `localhost:${forward.localPort}`, cookie: "sid=abc123" },
    ]);
  });

  it("upgrades a WebSocket and carries frames both ways", async () => {
    const upstream = http.createServer();
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", (socket) => {
      socket.send("hello from host");
      socket.on("message", (data) => socket.send(`echo:${String(data)}`));
    });
    const remotePort = await listen(upstream);
    cleanups.push(() => {
      wss.close();
      upstream.close();
    });

    const m = manager();
    const forward = await m.forward({ hostId: HOST, remotePort });
    const ws = new WebSocket(`ws://127.0.0.1:${forward.localPort}/hmr`);
    const received: string[] = [];
    ws.on("message", (data) => {
      received.push(String(data));
      if (received.length === 1) ws.send("ping");
    });
    await waitFor(() => received.length === 2);
    expect(received).toEqual(["hello from host", "echo:ping"]);
    ws.close();
  });

  it("carries a body larger than its flow-control window", async () => {
    const size = 3 * 1024 * 1024 + 17;
    const upstream = net.createServer((socket) => {
      let total = 0;
      socket.on("data", (chunk) => {
        total += chunk.byteLength;
        if (total === size) socket.end(Buffer.alloc(size, 7));
      });
    });
    const remotePort = await listen(upstream);
    cleanups.push(() => upstream.close());

    const m = manager();
    const forward = await m.forward({ hostId: HOST, remotePort });
    const socket = net.connect(forward.localPort, "127.0.0.1");
    socket.write(Buffer.alloc(size, 3));
    let received = 0;
    let allSevens = true;
    socket.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
      if (chunk.some((byte) => byte !== 7)) allSevens = false;
    });
    await new Promise((resolve) => socket.once("end", resolve));
    expect(received).toBe(size);
    expect(allSevens).toBe(true);
  });

  it("refuses a local connection cleanly when nothing listens on the host port", async () => {
    const probe = net.createServer();
    const deadPort = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));

    const m = manager();
    const forward = await m.forward({ hostId: HOST, remotePort: deadPort });
    const socket = net.connect(forward.localPort, "127.0.0.1");
    await new Promise((resolve) => socket.once("close", resolve));
    expect(host.isOpen && client.isOpen).toBe(true);
  });

  it("keeps one forward per host port and lets a lasting reason replace a sign-in's", async () => {
    const upstream = http.createServer((_req, res) => res.end("ok"));
    const remotePort = await listen(upstream);
    cleanups.push(() => upstream.close());
    const changes: number[] = [];
    const m = manager({ onChange: (forwards) => changes.push(forwards.length) });

    const first = await m.forward({ hostId: HOST, remotePort, origin: "oauth-callback" });
    const second = await m.forward({ hostId: HOST, remotePort, origin: "manual" });
    expect(second.forwardId).toBe(first.forwardId);
    expect(m.list()).toHaveLength(1);
    expect(m.list()[0]!.origin).toBe("manual");

    await m.stop(first.forwardId);
    expect(m.list()).toEqual([]);
    expect(changes.at(-1)).toBe(0);
  });

  it("closes a sign-in callback forward once it has gone idle", async () => {
    const upstream = http.createServer((_req, res) => res.end("callback received"));
    const remotePort = await listen(upstream);
    cleanups.push(() => upstream.close());

    const m = manager({ oauthIdleMs: 150 });
    const forward = await m.forward({ hostId: HOST, remotePort, origin: "oauth-callback" });
    const reply = await get(forward.localPort, "/callback?code=x");
    expect(reply.body).toBe("callback received");

    await waitFor(() => m.list().length === 0, 3_000);
    await expect(get(forward.localPort, "/callback")).rejects.toThrow();
  });

  it("refuses to forward for an unknown host or without a live link", async () => {
    const m = manager();
    await expect(m.forward({ hostId: "elsewhere", remotePort: 3000 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const offline = manager({ sessionFor: () => null });
    await expect(offline.forward({ hostId: HOST, remotePort: 3000 })).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
    await expect(m.forward({ hostId: "local", remotePort: 3000 })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("lists the host's listening ports", async () => {
    const m = manager();
    await expect(m.listHostPorts(HOST)).resolves.toEqual([
      { port: 5173, processName: "node", pid: 4242 },
    ]);
  });
});

describe("loopback mapping", () => {
  it("treats only registered forwards as the host's localhost", async () => {
    const upstream = http.createServer((_req, res) => res.end("ok"));
    const remotePort = await listen(upstream);
    cleanups.push(() => upstream.close());
    const m = manager();
    const forward = await m.forward({ hostId: HOST, remotePort });

    const ports = m.localPortsFor(HOST);
    expect(isForwardedLoopbackUrl(`http://localhost:${forward.localPort}/`, ports)).toBe(true);
    expect(isForwardedLoopbackUrl(`http://127.0.0.1:${forward.localPort}/x`, ports)).toBe(true);
    expect(isForwardedLoopbackUrl(`http://localhost:${forward.localPort + 1}/`, ports)).toBe(false);
    expect(isForwardedLoopbackUrl(`http://example.com:${forward.localPort}/`, ports)).toBe(false);
    expect(m.localPortsFor("other-host").size).toBe(0);
  });
});

describe("dev preview through a forward", () => {
  it("resolves a host's preview to a forward of the dev server's actual port, HMR included", async () => {
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`page at ${req.url}`);
    });
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", (socket) => socket.on("message", (d) => socket.send(`hmr:${String(d)}`)));
    const devServerPort = await listen(upstream);
    cleanups.push(() => {
      wss.close();
      upstream.close();
    });
    previewResolution = { kind: "ok", port: devServerPort, isHttps: false };

    const m = manager();
    const proxy = new DevPreviewProxyService(
      () => ({ kind: "unknown-subdomain" }),
      undefined,
      (subdomain) => m.resolvePreview(subdomain)
    );
    cleanups.push(() => proxy.dispose());
    const proxyPort = await proxy.start();

    const page = await get(proxyPort, "/app", { Host: `dp-proj-panel.localhost:${proxyPort}` });
    expect(page.status).toBe(200);
    expect(page.body).toBe("page at /app");
    const [forward] = m.list();
    expect(forward).toMatchObject({
      hostId: HOST,
      remotePort: devServerPort,
      origin: "dev-preview",
    });

    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/`, {
      headers: { Host: `dp-proj-panel.localhost:${proxyPort}` },
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const reply = new Promise<string>((resolve) => ws.once("message", (d) => resolve(String(d))));
    ws.send("update");
    await expect(reply).resolves.toBe("hmr:update");
    ws.close();
  });

  it("leaves an unknown preview to the local 502 and reports a stopped one as not running", async () => {
    let clock = 1_000;
    const m = manager({ now: () => clock });
    await expect(m.resolvePreview("dp-nothing-here")).resolves.toBeNull();
    previewResolution = { kind: "not-running", status: "stopped" };
    clock += 60_000;
    await expect(m.resolvePreview("dp-nothing-here")).resolves.toEqual({
      kind: "not-running",
      status: "stopped",
    });
    expect(m.list()).toEqual([]);
  });

  it("keeps a moved dev server's redirects on the preview origin and releases a stopped server's forward", async () => {
    let devServerPort = 0;
    const upstream = http.createServer((_req, res) => {
      // A dev server that names its own port, not the Host header it was sent.
      res.writeHead(302, { Location: `http://localhost:${devServerPort}/next` });
      res.end();
    });
    devServerPort = await listen(upstream);
    cleanups.push(() => upstream.close());
    previewResolution = { kind: "ok", port: devServerPort, isHttps: false };

    let clock = 1_000;
    const m = manager({ now: () => clock });
    const proxy = new DevPreviewProxyService(
      () => ({ kind: "unknown-subdomain" }),
      undefined,
      (subdomain) => m.resolvePreview(subdomain)
    );
    cleanups.push(() => proxy.dispose());
    const proxyPort = await proxy.start();

    const reply = await get(proxyPort, "/", { Host: `dp-proj-panel.localhost:${proxyPort}` });
    expect(m.list()[0]!.localPort).not.toBe(devServerPort);
    expect(reply.headers.location).toBe(`http://dp-proj-panel.localhost:${proxyPort}/next`);

    previewResolution = { kind: "not-running", status: "stopped" };
    clock += 60_000;
    await m.resolvePreview("dp-proj-panel");
    expect(m.list()).toEqual([]);
  });

  it("asks nothing when no host is connected", () => {
    const m = manager({ connectedHosts: () => [] });
    expect(m.resolvePreview("dp-a-b")).toBeNull();
  });
});

class FakeSshChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(): boolean {
    return true;
  }
}

describe("ssh -O forward on the ControlMaster", () => {
  it("adds and cancels the forward through the master with the ports it chose", async () => {
    const calls: string[][] = [];
    const spawn = (args: string[]): SshChild => {
      calls.push(args);
      const child = new FakeSshChild();
      setImmediate(() => child.emit("exit", 0, null));
      return child as unknown as SshChild;
    };
    const m = manager({
      sshMuxFor: () => ({ target: "greg@studio-01", controlPath: "/tmp/rh/cm-abc" }),
      spawn,
    });
    const probe = net.createServer();
    const remotePort = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));

    const forward = await m.forward({ hostId: HOST, remotePort });
    expect(forward.localPort).toBe(remotePort);
    expect(calls[0]).toEqual([
      "-o",
      "ControlPath=/tmp/rh/cm-abc",
      "-O",
      "forward",
      "-L",
      `localhost:${remotePort}:localhost:${remotePort}`,
      "--",
      "greg@studio-01",
    ]);

    await m.stop(forward.forwardId);
    expect(calls[1]).toEqual([
      "-o",
      "ControlPath=/tmp/rh/cm-abc",
      "-O",
      "cancel",
      "-L",
      `localhost:${remotePort}:localhost:${remotePort}`,
      "--",
      "greg@studio-01",
    ]);
  });

  it("keeps a forward listed when ssh refuses to cancel it", async () => {
    let exitCode = 0;
    const spawn = (): SshChild => {
      const child = new FakeSshChild();
      setImmediate(() => child.emit("exit", exitCode, null));
      return child as unknown as SshChild;
    };
    const m = manager({
      sshMuxFor: () => ({ target: "studio-01", controlPath: "/tmp/rh/cm-abc" }),
      spawn,
    });
    const forward = await m.forward({ hostId: HOST, remotePort: 40123 });
    exitCode = 255;
    await expect(m.stop(forward.forwardId)).rejects.toMatchObject({ code: "INTERNAL" });
    expect(m.list()).toHaveLength(1);
    exitCode = 0;
    await m.stop(forward.forwardId);
    expect(m.list()).toEqual([]);
  });

  it("falls back to link streams when the master refuses", async () => {
    const spawn = (): SshChild => {
      const child = new FakeSshChild();
      setImmediate(() => child.emit("exit", 255, null));
      return child as unknown as SshChild;
    };
    const upstream = http.createServer((_req, res) => res.end("via the link"));
    const remotePort = await listen(upstream);
    cleanups.push(() => upstream.close());

    const m = manager({
      sshMuxFor: () => ({ target: "studio-01", controlPath: "/tmp/rh/cm-abc" }),
      spawn,
    });
    const forward = await m.forward({ hostId: HOST, remotePort });
    await expect(get(forward.localPort, "/")).resolves.toMatchObject({ body: "via the link" });
  });
});
