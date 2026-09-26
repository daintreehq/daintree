import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { isBoundLoopbackUrl } from "../../../../shared/utils/urlUtils.js";
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
    previewOwner: () => HOST,
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

    const bound = m.boundEndpointsFor(HOST);
    const port = forward.localPort;
    expect(bound).toContainEqual({ address: "127.0.0.1", port });
    expect(isBoundLoopbackUrl(`http://localhost:${port}/`, bound)).toBe(true);
    expect(isBoundLoopbackUrl(`http://127.0.0.1:${port}/x`, bound)).toBe(true);
    expect(isBoundLoopbackUrl(`http://[::ffff:127.0.0.1]:${port}/x`, bound)).toBe(true);
    // Loopback, but not an address the forward holds.
    expect(isBoundLoopbackUrl(`http://127.0.0.2:${port}/`, bound)).toBe(false);
    expect(isBoundLoopbackUrl(`http://localhost:${port + 1}/`, bound)).toBe(false);
    expect(isBoundLoopbackUrl(`http://example.com:${port}/`, bound)).toBe(false);
    expect(m.localPortsFor(HOST)).toEqual(new Set([port]));
    expect(m.boundEndpointsFor("other-host")).toEqual([]);
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

  it("asks nothing for a preview no view has claimed, or whose host isn't connected", () => {
    expect(manager({ previewOwner: () => null }).resolvePreview("dp-a-b")).toBeNull();
    expect(manager({ sessionFor: () => null }).resolvePreview("dp-a-b")).toBeNull();
  });

  it("asks only the host that owns the preview, however many are connected", async () => {
    const devServer = http.createServer((_req, res) => res.end("owner's page"));
    const devServerPort = await listen(devServer);
    cleanups.push(() => devServer.close());
    // The first host claims every preview it is asked about.
    previewResolution = { kind: "ok", port: devServerPort, isHttps: false };

    const other = await openSessionPair(dir);
    cleanups.push(() => {
      other.host.close("done");
      other.client.close("done");
    });
    const asked: string[] = [];
    cleanups.push(
      installHostPortService(
        {
          onSession(listener) {
            listener({ session: other.host });
            return () => {};
          },
        },
        {
          resolvePreview: async (subdomain) => {
            asked.push(subdomain);
            return { kind: "not-running", status: "stopped" };
          },
        }
      )
    );
    const OWNER = "studio-02";
    const m = manager({
      sessionFor: (hostId) => (hostId === HOST ? client : hostId === OWNER ? other.client : null),
      isKnownHost: (hostId) => hostId === HOST || hostId === OWNER,
      previewOwner: (subdomain) => (subdomain === "dp-proj-panel" ? OWNER : null),
    });

    await expect(m.resolvePreview("dp-proj-panel")).resolves.toEqual({
      kind: "not-running",
      status: "stopped",
    });
    expect(asked).toEqual(["dp-proj-panel"]);
    expect(m.list()).toEqual([]);
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
      `127.0.0.1:${remotePort}:localhost:${remotePort}`,
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
      `127.0.0.1:${remotePort}:localhost:${remotePort}`,
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

  it("retires a forward when its master's session closes and adds it again, on a free port, on the next", async () => {
    const calls: string[][] = [];
    const spawn = (args: string[]): SshChild => {
      calls.push(args);
      const child = new FakeSshChild();
      setImmediate(() => child.emit("exit", 0, null));
      return child as unknown as SshChild;
    };
    const changes: number[] = [];
    let current: LinkSession | null = client;
    const m = manager({
      sessionFor: (hostId) => (hostId === HOST && current?.isOpen ? current : null),
      sshMuxFor: () => ({ target: "studio-01", controlPath: "/tmp/rh/cm-abc" }),
      spawn,
      onChange: (forwards) => changes.push(forwards.length),
    });
    const probe = net.createServer();
    const remotePort = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));

    const forward = await m.forward({ hostId: HOST, remotePort, label: "API" });
    expect(forward.localPort).toBe(remotePort);
    expect(m.localPortsFor(HOST)).toEqual(new Set([remotePort]));

    // The master dies with the session: the port stops being the host's at once.
    client.close("master gone");
    expect(m.list()).toEqual([]);
    expect(m.localPortsFor(HOST).size).toBe(0);
    expect(m.boundEndpointsFor(HOST)).toEqual([]);
    expect(changes.at(-1)).toBe(0);

    // Something else on this machine takes the port the master held.
    const squatter = net.createServer((socket) => {
      // The free-port probe connects and hangs up at once.
      socket.on("error", () => {});
      socket.end("not the host");
    });
    await new Promise<void>((resolve) => squatter.listen(remotePort, "127.0.0.1", resolve));
    cleanups.push(() => squatter.close());

    const next = await openSessionPair(dir);
    cleanups.push(() => {
      next.host.close("done");
      next.client.close("done");
    });
    current = next.client;
    await m.reestablish(HOST);

    const [again] = m.list();
    expect(again).toMatchObject({ hostId: HOST, remotePort, label: "API" });
    expect(again!.localPort).not.toBe(remotePort);
    expect(m.localPortsFor(HOST)).toEqual(new Set([again!.localPort]));
    expect(calls.at(-1)).toContain(`127.0.0.1:${again!.localPort}:localhost:${remotePort}`);
    // The old forward is cancelled before the new one is added, so a late cancel can't undo it.
    expect(calls.map((args) => args[3])).toEqual(["forward", "cancel", "forward"]);
  });

  it("holds the IPv6 side of an ssh forward itself and relays it to the IPv4 side ssh holds", async () => {
    const spawn = (): SshChild => {
      const child = new FakeSshChild();
      setImmediate(() => child.emit("exit", 0, null));
      return child as unknown as SshChild;
    };
    const m = manager({
      sshMuxFor: () => ({ target: "studio-01", controlPath: "/tmp/rh/cm-abc" }),
      spawn,
    });
    const probe = net.createServer();
    const remotePort = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    const forward = await m.forward({ hostId: HOST, remotePort });
    const bound = m.boundEndpointsFor(HOST);
    expect(bound).toContainEqual({ address: "127.0.0.1", port: forward.localPort });
    if (!bound.some((endpoint) => endpoint.address === "::1")) return; // no IPv6 loopback here

    // Stand in for ssh on the IPv4 side.
    const ssh = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.end("via ssh");
    });
    await new Promise<void>((resolve) => ssh.listen(forward.localPort, "127.0.0.1", resolve));
    cleanups.push(() => ssh.close());
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(forward.localPort, "::1");
      let text = "";
      socket.on("data", (chunk) => (text += chunk));
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
    });
    expect(reply).toBe("via ssh");
  });

  it("forgets a retired ssh forward the user stops, and keeps one whose re-add failed", async () => {
    const spawn = (): SshChild => {
      const child = new FakeSshChild();
      setImmediate(() => child.emit("exit", 0, null));
      return child as unknown as SshChild;
    };
    let current: LinkSession | null = client;
    const m = manager({
      sessionFor: (hostId) => (hostId === HOST && current?.isOpen ? current : null),
      sshMuxFor: () => ({ target: "studio-01", controlPath: "/tmp/rh/cm-abc" }),
      spawn,
    });
    const first = await m.forward({ hostId: HOST, remotePort: 40123 });
    const second = await m.forward({ hostId: HOST, remotePort: 40124 });
    client.close("master gone");
    await m.stop(first.forwardId);

    // Asked for again before a session is back: it fails, and must stay due for the next one.
    await expect(m.forward({ hostId: HOST, remotePort: 40124 })).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });

    const next = await openSessionPair(dir);
    cleanups.push(() => {
      next.host.close("done");
      next.client.close("done");
    });
    current = next.client;
    await m.reestablish(HOST);
    expect(m.list().map((forward) => forward.remotePort)).toEqual([second.remotePort]);
  });

  it("honours a Stop that arrives while a retired forward is being added again", async () => {
    const calls: string[][] = [];
    let hold = false;
    const held: Array<() => void> = [];
    const spawn = (args: string[]): SshChild => {
      calls.push(args);
      const child = new FakeSshChild();
      const exit = () => child.emit("exit", 0, null);
      if (hold && args[3] === "forward") held.push(exit);
      else setImmediate(exit);
      return child as unknown as SshChild;
    };
    const changes: number[] = [];
    let current: LinkSession | null = client;
    const m = manager({
      sessionFor: (hostId) => (hostId === HOST && current?.isOpen ? current : null),
      sshMuxFor: () => ({ target: "studio-01", controlPath: "/tmp/rh/cm-abc" }),
      spawn,
      onChange: (forwards) => changes.push(forwards.length),
    });
    const probe = net.createServer();
    const remotePort = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    const forward = await m.forward({ hostId: HOST, remotePort });
    client.close("master gone");

    const next = await openSessionPair(dir);
    cleanups.push(() => {
      next.host.close("done");
      next.client.close("done");
    });
    current = next.client;
    hold = true;
    const reestablishing = m.reestablish(HOST);
    await waitFor(() => held.length === 1);
    const changesBefore = changes.length;
    const stopping = m.stop(forward.forwardId);
    held.shift()!();
    await Promise.all([reestablishing, stopping]);

    expect(m.list()).toEqual([]);
    expect(m.localPortsFor(HOST).size).toBe(0);
    // Never advertised while it existed.
    expect(changes.slice(changesBefore).every((count) => count === 0)).toBe(true);
    // The re-added forward was cancelled on the new master.
    expect(calls.at(-1)![3]).toBe("cancel");
    hold = false;
    await m.reestablish(HOST);
    expect(m.list()).toEqual([]);
  });

  it("honours a Stop for a retired forward that a user's own forward() is adding again", async () => {
    let hold = false;
    const held: Array<() => void> = [];
    const spawn = (args: string[]): SshChild => {
      const child = new FakeSshChild();
      const exit = () => child.emit("exit", 0, null);
      if (hold && args[3] === "forward") held.push(exit);
      else setImmediate(exit);
      return child as unknown as SshChild;
    };
    let current: LinkSession | null = client;
    const m = manager({
      sessionFor: (hostId) => (hostId === HOST && current?.isOpen ? current : null),
      sshMuxFor: () => ({ target: "studio-01", controlPath: "/tmp/rh/cm-abc" }),
      spawn,
    });
    const forward = await m.forward({ hostId: HOST, remotePort: 40125 });
    client.close("master gone");
    const next = await openSessionPair(dir);
    cleanups.push(() => {
      next.host.close("done");
      next.client.close("done");
    });
    current = next.client;
    hold = true;
    const adding = m.forward({ hostId: HOST, remotePort: 40125 });
    await waitFor(() => held.length === 1);
    const stopping = m.stop(forward.forwardId);
    held.shift()!();
    await expect(adding).rejects.toMatchObject({ code: "CANCELLED" });
    await stopping;
    expect(m.list()).toEqual([]);
    hold = false;
    await m.reestablish(HOST);
    expect(m.list()).toEqual([]);
  });

  it("does not bring back a retired forward stopped while an earlier one is being added", async () => {
    let hold = false;
    const held: Array<() => void> = [];
    const spawn = (args: string[]): SshChild => {
      const child = new FakeSshChild();
      const exit = () => child.emit("exit", 0, null);
      if (hold && args[3] === "forward") held.push(exit);
      else setImmediate(exit);
      return child as unknown as SshChild;
    };
    let current: LinkSession | null = client;
    const m = manager({
      sessionFor: (hostId) => (hostId === HOST && current?.isOpen ? current : null),
      sshMuxFor: () => ({ target: "studio-01", controlPath: "/tmp/rh/cm-abc" }),
      spawn,
    });
    const first = await m.forward({ hostId: HOST, remotePort: 40127 });
    const second = await m.forward({ hostId: HOST, remotePort: 40128 });
    client.close("master gone");
    const next = await openSessionPair(dir);
    cleanups.push(() => {
      next.host.close("done");
      next.client.close("done");
    });
    current = next.client;
    hold = true;
    const reestablishing = m.reestablish(HOST);
    await waitFor(() => held.length === 1);
    await m.stop(second.forwardId);
    hold = false;
    held.shift()!();
    await reestablishing;
    expect(m.list().map((forward) => forward.forwardId)).toEqual([first.forwardId]);
  });

  it("keeps a re-added forward's id, so a Stop made on hearing of it lands", async () => {
    const spawn = (): SshChild => {
      const child = new FakeSshChild();
      setImmediate(() => child.emit("exit", 0, null));
      return child as unknown as SshChild;
    };
    let current: LinkSession | null = client;
    let stopOnChange: string | null = null;
    let stopped: Promise<void> | null = null;
    const m: PortForwardManager = manager({
      sessionFor: (hostId) => (hostId === HOST && current?.isOpen ? current : null),
      sshMuxFor: () => ({ target: "studio-01", controlPath: "/tmp/rh/cm-abc" }),
      spawn,
      onChange: (forwards) => {
        if (stopOnChange && forwards.some((f) => f.forwardId === stopOnChange)) {
          stopped = m.stop(stopOnChange);
          stopOnChange = null;
        }
      },
    });
    const forward = await m.forward({ hostId: HOST, remotePort: 40126 });
    client.close("master gone");
    const next = await openSessionPair(dir);
    cleanups.push(() => {
      next.host.close("done");
      next.client.close("done");
    });
    current = next.client;
    stopOnChange = forward.forwardId;
    await m.reestablish(HOST);
    expect(stopped).not.toBeNull();
    await stopped;
    expect(m.list()).toEqual([]);
  });

  it("stops counting a stream forward while its host has no session", async () => {
    const upstream = http.createServer((_req, res) => res.end("ok"));
    const remotePort = await listen(upstream);
    cleanups.push(() => upstream.close());
    let current: LinkSession | null = client;
    const m = manager({
      sessionFor: (hostId) => (hostId === HOST && current?.isOpen ? current : null),
    });
    const forward = await m.forward({ hostId: HOST, remotePort });
    client.close("gone");
    expect(m.localPortsFor(HOST).size).toBe(0);
    expect(m.list()).toEqual([]);
    await expect(m.forward({ hostId: HOST, remotePort })).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });

    const next = await openSessionPair(dir);
    cleanups.push(() => {
      next.host.close("done");
      next.client.close("done");
    });
    current = next.client;
    await m.reestablish(HOST);
    expect(m.list()).toEqual([expect.objectContaining({ forwardId: forward.forwardId })]);
    expect(m.localPortsFor(HOST)).toEqual(new Set([forward.localPort]));
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
