import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runInstall } from "../commands/install.js";
import { runUninstall } from "../commands/uninstall.js";
import { DaintreeUnavailableError } from "../ipc/client.js";

let tmpDir: string;
let socketPath: string;
let server: net.Server | null = null;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-install-test-"));
  socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\daintree-install-test-${process.pid}-${randomUUID()}`
      : path.join(tmpDir, "cli.sock");
  process.env.DAINTREE_CLI_SOCKET = socketPath;
  // Point control-file discovery at a path that never exists so the client
  // can't accidentally read a real `~/.daintree/cli-control.json` on a dev box
  // — the socket override drives the connection in these tests.
  process.env.DAINTREE_CLI_CONTROL_FILE = path.join(tmpDir, "cli-control.json");
});

afterEach(async () => {
  delete process.env.DAINTREE_CLI_SOCKET;
  delete process.env.DAINTREE_CLI_CONTROL_FILE;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

/** Stand up a one-shot server that replies to the first request with `reply`. */
async function serve(
  onRequest: (req: { method: string; params?: unknown }) => Record<string, unknown>
): Promise<void> {
  server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx < 0) return;
      const req = JSON.parse(buffer.slice(0, idx));
      const reply = onRequest(req);
      socket.write(JSON.stringify({ id: req.id, ...reply }) + "\n");
    });
  });
  await new Promise<void>((resolve) => server!.listen(socketPath, () => resolve()));
}

describe("runInstall", () => {
  it("resolves a local path and reports success", async () => {
    let received: { method: string; params?: unknown } | null = null;
    await serve((req) => {
      received = req;
      return { result: { status: "installed", pluginId: "acme.demo" } };
    });

    await runInstall("./my-plugin.dntr");
    expect(received!.method).toBe("plugin.install");
    expect((received!.params as { path: string }).path).toBe(
      path.resolve(process.cwd(), "./my-plugin.dntr")
    );
  });

  it("passes URLs through unchanged", async () => {
    let received: { params?: unknown } | null = null;
    await serve((req) => {
      received = req;
      return { result: { status: "installed", pluginId: "acme.demo" } };
    });

    await runInstall("https://example.com/plugin.dntr");
    expect((received!.params as { url: string }).url).toBe("https://example.com/plugin.dntr");
  });

  it("throws with the host's error detail on failure", async () => {
    await serve(() => ({
      result: { status: "failed", errors: [{ message: "bad archive" }] },
    }));
    await expect(runInstall("./x.dntr")).rejects.toThrow(/bad archive/);
  });

  it("gives a friendly 'not running' error naming the socket when nothing listens", async () => {
    // No server started — ENOENT on the socket path.
    await expect(runInstall("./x.dntr")).rejects.toBeInstanceOf(DaintreeUnavailableError);
    await expect(runInstall("./x.dntr")).rejects.toThrow(socketPath);
  });

  it("rejects promptly when the server accepts then closes without responding", async () => {
    server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server!.listen(socketPath, () => resolve()));
    await expect(runInstall("./x.dntr")).rejects.toBeInstanceOf(DaintreeUnavailableError);
  });

  it("trims surrounding whitespace before deciding path vs url", async () => {
    let received: { params?: unknown } | null = null;
    await serve((req) => {
      received = req;
      return { result: { status: "installed", pluginId: "acme.demo" } };
    });
    await runInstall("  https://example.com/p.dntr  ");
    expect((received!.params as { url: string }).url).toBe("https://example.com/p.dntr");
  });
});

describe("runUninstall", () => {
  it("sends the pluginId and resolves on ok", async () => {
    let received: { method: string; params?: unknown } | null = null;
    await serve((req) => {
      received = req;
      return { result: { status: "ok" } };
    });

    await runUninstall("acme.demo");
    expect(received!.method).toBe("plugin.uninstall");
    expect((received!.params as { pluginId: string }).pluginId).toBe("acme.demo");
  });

  it("surfaces a host rejection (e.g. bad id) as an error", async () => {
    await serve(() => ({ error: { message: "pluginId must be a scoped plugin name" } }));
    await expect(runUninstall("bogus")).rejects.toThrow(/scoped plugin name/);
  });
});
