import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createPluginCliServer, type PluginCliServer } from "../PluginCliServer.js";

// Windows named pipes don't live on disk, so the file-socket lifecycle assertions
// only make sense on POSIX. The dispatch assertions run everywhere.
const isWindows = process.platform === "win32";

let tmpDir: string;
let socketPath: string;
let server: PluginCliServer | null = null;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-cli-sock-"));
  socketPath = isWindows
    ? `\\\\.\\pipe\\daintree-cli-test-${process.pid}-${Math.floor(performance.now())}`
    : path.join(tmpDir, "cli.sock");
});

afterEach(async () => {
  if (server) {
    await server.close().catch(() => {});
    server = null;
  }
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

/** Send one NDJSON request and resolve with the parsed response frame. */
function request(payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(JSON.stringify(payload) + "\n");
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

function noopHandlers() {
  return {
    install: vi.fn(async () => ({ status: "installed" })),
    uninstall: vi.fn(async () => {}),
  };
}

describe("createPluginCliServer", () => {
  it("does not bind until waitForReady resolves", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server = createPluginCliServer({
      socketPath,
      waitForReady: () => gate,
      handlers: noopHandlers(),
    });

    const listenPromise = server.listen();
    // Give the event loop a tick; the server must not be listening yet.
    await new Promise((r) => setTimeout(r, 20));
    if (!isWindows) {
      await expect(fs.access(socketPath)).rejects.toBeTruthy();
    }

    release();
    await listenPromise;
    if (!isWindows) {
      await expect(fs.access(socketPath)).resolves.toBeUndefined();
    }
  });

  it("routes plugin.install to the install handler and returns the result", async () => {
    const handlers = noopHandlers();
    server = createPluginCliServer({
      socketPath,
      waitForReady: () => Promise.resolve(),
      handlers,
    });
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

  it("routes plugin.uninstall to the uninstall handler", async () => {
    const handlers = noopHandlers();
    server = createPluginCliServer({
      socketPath,
      waitForReady: () => Promise.resolve(),
      handlers,
    });
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

  it("answers plugin.ping for liveness checks", async () => {
    server = createPluginCliServer({
      socketPath,
      waitForReady: () => Promise.resolve(),
      handlers: noopHandlers(),
    });
    await server.listen();

    const res = await request({ id: 9, method: "plugin.ping" });
    expect(res.id).toBe(9);
    expect((res.result as { status: string }).status).toBe("ok");
  });

  it("returns an error frame for malformed JSON", async () => {
    server = createPluginCliServer({
      socketPath,
      waitForReady: () => Promise.resolve(),
      handlers: noopHandlers(),
    });
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
    server = createPluginCliServer({
      socketPath,
      waitForReady: () => Promise.resolve(),
      handlers: noopHandlers(),
    });
    await server.listen();

    const res = await request({ id: 2, method: "plugin.bogus" });
    expect(res.id).toBe(2);
    expect((res.error as { message: string }).message).toMatch(/Unknown method/);
  });

  it("returns an error frame when install params are missing path and url", async () => {
    const handlers = noopHandlers();
    server = createPluginCliServer({
      socketPath,
      waitForReady: () => Promise.resolve(),
      handlers,
    });
    await server.listen();

    const res = await request({ id: 3, method: "plugin.install", params: {} });
    expect(res.id).toBe(3);
    expect(res.error).toBeTruthy();
    expect((res.error as { message: string }).message).toMatch(/exactly one of 'path' or 'url'/);
    expect(handlers.install).not.toHaveBeenCalled();
  });

  it("rejects install params carrying both path and url instead of preferring one", async () => {
    const handlers = noopHandlers();
    server = createPluginCliServer({
      socketPath,
      waitForReady: () => Promise.resolve(),
      handlers,
    });
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
    server = createPluginCliServer({
      socketPath,
      waitForReady: () => Promise.resolve(),
      handlers,
    });
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
    server = createPluginCliServer({
      socketPath,
      waitForReady: () => Promise.resolve(),
      handlers: {
        install: vi.fn(async () => {
          throw new Error("disk on fire");
        }),
        uninstall: vi.fn(async () => {}),
      },
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
    server = createPluginCliServer({
      socketPath,
      waitForReady: () => Promise.resolve(),
      handlers: {
        install: vi.fn(async () => ({ status: "installed" })),
        uninstall: vi.fn(async () => {}),
      },
    });
    await server.listen();

    const responses = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath });
      const frames: Record<string, unknown>[] = [];
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(JSON.stringify({ id: 1, method: "plugin.ping" }) + "\n");
        socket.write(JSON.stringify({ id: 2, method: "plugin.ping" }) + "\n");
        socket.write(JSON.stringify({ id: 3, method: "plugin.ping" }) + "\n");
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

  it("close() tears down the server and removes the socket file", async () => {
    server = createPluginCliServer({
      socketPath,
      waitForReady: () => Promise.resolve(),
      handlers: noopHandlers(),
    });
    await server.listen();
    if (!isWindows) {
      await expect(fs.access(socketPath)).resolves.toBeUndefined();
    }
    await server.close();
    server = null;
    if (!isWindows) {
      await expect(fs.access(socketPath)).rejects.toBeTruthy();
    }
  });
});
