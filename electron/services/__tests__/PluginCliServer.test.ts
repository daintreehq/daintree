import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  createPluginCliServer,
  type PluginCliServer,
  type PluginCliServerHandlers,
} from "../PluginCliServer.js";

// Windows named pipes don't live on disk, so the file-socket lifecycle assertions
// only make sense on POSIX. The dispatch assertions run everywhere.
const isWindows = process.platform === "win32";

let tmpDir: string;
let socketPath: string;
let controlFilePath: string;
let server: PluginCliServer | null = null;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-cli-sock-"));
  socketPath = isWindows
    ? `\\\\.\\pipe\\daintree-cli-test-${process.pid}-${Math.floor(performance.now())}`
    : path.join(tmpDir, "cli.sock");
  controlFilePath = path.join(tmpDir, "cli-control.json");
});

afterEach(async () => {
  if (server) {
    await server.close().catch(() => {});
    server = null;
  }
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

function noopHandlers(): PluginCliServerHandlers {
  return {
    install: vi.fn(async () => ({ status: "installed" })),
    uninstall: vi.fn(async () => {}),
    devStart: vi.fn(async () => {}),
    devStop: vi.fn(async () => {}),
    projectStatus: vi.fn(async () => ({ known: false, projectId: null, trust: null, plugins: [] })),
  };
}

/** Stand up a server bound to the temp socket + temp control file. */
function makeServer(
  handlers: PluginCliServerHandlers = noopHandlers(),
  waitForReady: () => Promise<void> = () => Promise.resolve()
): PluginCliServer {
  return createPluginCliServer({ socketPath, controlFilePath, waitForReady, handlers });
}

/**
 * Send one NDJSON request and resolve with the parsed response frame. The
 * per-launch auth token is injected automatically; pass `{ token }` to override
 * it (use `null` to omit the field entirely) for the auth-gate tests.
 */
function request(
  payload: Record<string, unknown>,
  opts?: { token?: string | null }
): Promise<Record<string, unknown>> {
  const token = opts && "token" in opts ? opts.token : (server?.authToken ?? null);
  const frame = token === null ? payload : { token, ...payload };
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(JSON.stringify(frame) + "\n");
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx >= 0) {
        const line = buffer.slice(0, idx);
        socket.end();
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(err);
        }
      }
    });
    socket.on("error", reject);
  });
}

describe("createPluginCliServer", () => {
  it("does not bind until waitForReady resolves", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server = makeServer(noopHandlers(), () => gate);

    const listenPromise = server.listen();
    // Give the event loop a tick; the server must not be listening yet.
    await new Promise((r) => setTimeout(r, 20));
    if (!isWindows) {
      await expect(fs.access(socketPath)).rejects.toBeTruthy();
    }
    // The control file is only written once the socket is live.
    await expect(fs.access(controlFilePath)).rejects.toBeTruthy();

    release();
    await listenPromise;
    if (!isWindows) {
      await expect(fs.access(socketPath)).resolves.toBeUndefined();
    }
    await expect(fs.access(controlFilePath)).resolves.toBeUndefined();
  });

  it("routes plugin.install to the install handler and returns the result", async () => {
    const handlers = noopHandlers();
    server = makeServer(handlers);
    await server.listen();

    const res = await request({
      id: 1,
      method: "plugin.install",
      params: { path: "/tmp/foo.dntr" },
    });
    expect(res.id).toBe(1);
    expect(res.result).toEqual({ status: "installed" });
    expect(handlers.install).toHaveBeenCalledWith({ path: "/tmp/foo.dntr" });
  });

  it("routes plugin.project.status to the project-status handler", async () => {
    const handlers = noopHandlers();
    server = makeServer(handlers);
    await server.listen();

    const res = await request({
      id: 7,
      method: "plugin.project.status",
      params: { projectRoot: "/tmp/some-project" },
    });
    expect(res.id).toBe(7);
    expect(res.result).toEqual({ known: false, projectId: null, trust: null, plugins: [] });
    expect(handlers.projectStatus).toHaveBeenCalledWith({ projectRoot: "/tmp/some-project" });
  });

  it("rejects plugin.project.status without a project root", async () => {
    server = makeServer();
    await server.listen();

    const res = await request({ id: 8, method: "plugin.project.status", params: {} });
    expect(res.error).toBeDefined();
  });

  it("routes plugin.uninstall to the uninstall handler", async () => {
    const handlers = noopHandlers();
    server = makeServer(handlers);
    await server.listen();

    const res = await request({
      id: "u1",
      method: "plugin.uninstall",
      params: { pluginId: "acme.demo", deleteSettings: true },
    });
    expect(res.id).toBe("u1");
    expect(res.result).toEqual({ status: "ok" });
    expect(handlers.uninstall).toHaveBeenCalledWith({
      pluginId: "acme.demo",
      deleteSettings: true,
    });
  });

  it("routes plugin.dev.start to the devStart handler", async () => {
    const handlers = noopHandlers();
    server = makeServer(handlers);
    await server.listen();

    const res = await request({
      id: "d1",
      method: "plugin.dev.start",
      params: { pluginId: "acme.demo" },
    });
    expect(res.id).toBe("d1");
    expect(res.result).toEqual({ status: "ok" });
    expect(handlers.devStart).toHaveBeenCalledWith({ pluginId: "acme.demo" });
  });

  it("routes plugin.dev.stop to the devStop handler", async () => {
    const handlers = noopHandlers();
    server = makeServer(handlers);
    await server.listen();

    const res = await request({
      id: "d2",
      method: "plugin.dev.stop",
      params: { pluginId: "acme.demo" },
    });
    expect(res.id).toBe("d2");
    expect(res.result).toEqual({ status: "ok" });
    expect(handlers.devStop).toHaveBeenCalledWith({ pluginId: "acme.demo" });
  });

  it("returns an error frame when a dev call is missing pluginId", async () => {
    const handlers = noopHandlers();
    server = makeServer(handlers);
    await server.listen();

    const res = await request({ id: "d3", method: "plugin.dev.start", params: {} });
    expect(res.id).toBe("d3");
    expect(res.error).toBeTruthy();
    expect(handlers.devStart).not.toHaveBeenCalled();
  });

  it("answers plugin.ping for liveness checks", async () => {
    server = makeServer();
    await server.listen();

    const res = await request({ id: 9, method: "plugin.ping" });
    expect(res.id).toBe(9);
    expect((res.result as { status: string }).status).toBe("ok");
  });

  // ── Auth gate (#10518) ────────────────────────────────────────────────────

  it("advertises the socket path and auth token in the control file", async () => {
    server = makeServer();
    await server.listen();

    const raw = await fs.readFile(controlFilePath, "utf8");
    const parsed = JSON.parse(raw) as { socketPath: string; token: string };
    expect(parsed.socketPath).toBe(socketPath);
    expect(parsed.token).toBe(server.authToken);
    expect(server.authToken.length).toBeGreaterThanOrEqual(32);
  });

  it("rejects a frame with no token and does not dispatch", async () => {
    const handlers = noopHandlers();
    server = makeServer(handlers);
    await server.listen();

    const res = await request(
      { id: 1, method: "plugin.install", params: { path: "/tmp/foo.dntr" } },
      { token: null }
    );
    expect(res.error).toBeTruthy();
    expect((res.error as { message: string }).message).toMatch(/Unauthorized/);
    expect(handlers.install).not.toHaveBeenCalled();
  });

  it("rejects a frame with the wrong token, even for plugin.ping", async () => {
    const handlers = noopHandlers();
    server = makeServer(handlers);
    await server.listen();

    const res = await request({ id: 2, method: "plugin.ping" }, { token: "not-the-token" });
    expect(res.error).toBeTruthy();
    expect((res.error as { message: string }).message).toMatch(/Unauthorized/);
  });

  it("rejects a token of the wrong length without throwing", async () => {
    const handlers = noopHandlers();
    server = makeServer(handlers);
    await server.listen();

    // A shorter token must not crash the timing-safe comparison.
    const res = await request(
      { id: 3, method: "plugin.uninstall", params: { pluginId: "acme.demo" } },
      { token: "abc" }
    );
    expect(res.error).toBeTruthy();
    expect((res.error as { message: string }).message).toMatch(/Unauthorized/);
    expect(handlers.uninstall).not.toHaveBeenCalled();
  });

  it("accepts the correct token and dispatches", async () => {
    const handlers = noopHandlers();
    server = makeServer(handlers);
    await server.listen();

    const res = await request(
      { id: 4, method: "plugin.install", params: { path: "/tmp/ok.dntr" } },
      { token: server.authToken }
    );
    expect(res.result).toEqual({ status: "installed" });
    expect(handlers.install).toHaveBeenCalledWith({ path: "/tmp/ok.dntr" });
  });

  it("does not dispatch a second (valid-token) frame after a first auth failure", async () => {
    // Proves the connection genuinely can't be probed frame-by-frame: a bad
    // first frame terminates the connection so a pipelined valid-token frame in
    // the same burst never reaches a handler.
    const handlers = noopHandlers();
    server = makeServer(handlers);
    await server.listen();
    const token = server.authToken;

    const frames = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath });
      const received: Record<string, unknown>[] = [];
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        // Frame 1: no token (rejected). Frame 2: valid token, pipelined in the
        // same write burst.
        socket.write(
          JSON.stringify({ id: 1, method: "plugin.install", params: { path: "/x.dntr" } }) + "\n"
        );
        socket.write(JSON.stringify({ token, id: 2, method: "plugin.ping" }) + "\n");
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          received.push(JSON.parse(buffer.slice(0, idx)));
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
        }
      });
      socket.on("close", () => resolve(received));
      socket.on("error", reject);
    });

    expect(frames).toHaveLength(1);
    expect((frames[0].error as { message: string }).message).toMatch(/Unauthorized/);
    expect(handlers.install).not.toHaveBeenCalled();
  });

  it("writes the control file owner-only (0600) on POSIX", async () => {
    if (isWindows) return;
    server = makeServer();
    await server.listen();
    const stat = await fs.stat(controlFilePath);
    // The file holds the auth token — only the owner may read it.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  // ──────────────────────────────────────────────────────────────────────────

  it("returns an error frame for malformed JSON", async () => {
    server = makeServer();
    await server.listen();

    const res = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath });
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write("{ not json\n"));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const idx = buffer.indexOf("\n");
        if (idx >= 0) {
          socket.end();
          resolve(JSON.parse(buffer.slice(0, idx)));
        }
      });
      socket.on("error", reject);
    });
    expect(res.error).toBeTruthy();
    expect((res.error as { message: string }).message).toMatch(/Malformed JSON/);
  });

  it("returns an error frame for an unknown method", async () => {
    server = makeServer();
    await server.listen();

    const res = await request({ id: 2, method: "plugin.bogus" });
    expect(res.id).toBe(2);
    expect((res.error as { message: string }).message).toMatch(/Unknown method/);
  });

  it("returns an error frame when install params are missing path and url", async () => {
    const handlers = noopHandlers();
    server = makeServer(handlers);
    await server.listen();

    const res = await request({ id: 3, method: "plugin.install", params: {} });
    expect(res.id).toBe(3);
    expect(res.error).toBeTruthy();
    expect((res.error as { message: string }).message).toMatch(/exactly one of 'path' or 'url'/);
    expect(handlers.install).not.toHaveBeenCalled();
  });

  it("rejects install params carrying both path and url instead of preferring one", async () => {
    const handlers = noopHandlers();
    server = makeServer(handlers);
    await server.listen();

    const res = await request({
      id: 5,
      method: "plugin.install",
      params: { path: "/tmp/foo.dntr", url: "https://example.com/foo.dntr" },
    });
    expect(res.id).toBe(5);
    expect(res.error).toBeTruthy();
    expect((res.error as { message: string }).message).toMatch(/exactly one of 'path' or 'url'/);
    expect(handlers.install).not.toHaveBeenCalled();
  });

  it("routes a url-only install to the install handler", async () => {
    const handlers = noopHandlers();
    server = makeServer(handlers);
    await server.listen();

    const res = await request({
      id: 6,
      method: "plugin.install",
      params: { url: "https://example.com/foo.dntr" },
    });
    expect(res.result).toEqual({ status: "installed" });
    expect(handlers.install).toHaveBeenCalledWith({ url: "https://example.com/foo.dntr" });
  });

  it("surfaces a handler rejection as an error frame", async () => {
    server = makeServer({
      install: vi.fn(async () => {
        throw new Error("disk on fire");
      }),
      uninstall: vi.fn(async () => {}),
      devStart: vi.fn(async () => {}),
      devStop: vi.fn(async () => {}),
    });
    await server.listen();

    const res = await request({
      id: 4,
      method: "plugin.install",
      params: { path: "/tmp/x.dntr" },
    });
    expect((res.error as { message: string }).message).toMatch(/disk on fire/);
  });

  it("handles concurrent requests on one connection, matching ids", async () => {
    server = makeServer({
      install: vi.fn(async () => ({ status: "installed" })),
      uninstall: vi.fn(async () => {}),
      devStart: vi.fn(async () => {}),
      devStop: vi.fn(async () => {}),
    });
    await server.listen();
    const token = server.authToken;

    const responses = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath });
      const frames: Record<string, unknown>[] = [];
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(JSON.stringify({ token, id: 1, method: "plugin.ping" }) + "\n");
        socket.write(JSON.stringify({ token, id: 2, method: "plugin.ping" }) + "\n");
        socket.write(JSON.stringify({ token, id: 3, method: "plugin.ping" }) + "\n");
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          frames.push(JSON.parse(buffer.slice(0, idx)));
          buffer = buffer.slice(idx + 1);
          if (frames.length === 3) {
            socket.end();
            resolve(frames);
            return;
          }
          idx = buffer.indexOf("\n");
        }
      });
      socket.on("error", reject);
    });

    expect(responses.map((r) => r.id).sort()).toEqual([1, 2, 3]);
  });

  it("close() tears down the server and removes the socket + control file", async () => {
    server = makeServer();
    await server.listen();
    if (!isWindows) {
      await expect(fs.access(socketPath)).resolves.toBeUndefined();
    }
    await expect(fs.access(controlFilePath)).resolves.toBeUndefined();
    await server.close();
    server = null;
    if (!isWindows) {
      await expect(fs.access(socketPath)).rejects.toBeTruthy();
    }
    await expect(fs.access(controlFilePath)).rejects.toBeTruthy();
  });
});
