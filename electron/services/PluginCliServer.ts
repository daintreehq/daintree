import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { getCliSocketPath } from "../../shared/utils/cliSocketPath.js";

/**
 * Local control socket that lets the `daintree-plugin` CLI drive a running
 * Daintree instance for `install` / `uninstall` (F32). The CLI connects over a
 * Unix domain socket (`~/.daintree/cli.sock`) or a Windows named pipe
 * (`\\.\pipe\daintree-cli`) and exchanges newline-delimited JSON frames:
 *
 *   request:  { "id": <string|number>, "method": <string>, "params"?: <object> }
 *   response: { "id": <id>, "result": <value> }  |  { "id": <id>, "error": { "message": <string> } }
 *
 * Every CLI install/uninstall routes through the SAME handler functions the IPC
 * surface uses, so the path/magic-byte/`.dntr` guards and the scoped-name check
 * are never re-implemented or bypassed. The server only binds after the plugin
 * service has finished initializing — a `plugin.install` arriving mid-activation
 * would otherwise race the load path.
 */

const MAX_FRAME_BYTES = 64 * 1024;

/** Request envelope. `params` shape is validated per-method. */
const RequestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

const InstallParamsSchema = z
  .object({
    path: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
  })
  // Exactly one source: both-present silently preferred 'url' before, which
  // hid a caller bug. Reject the ambiguous frame at the boundary instead.
  .refine((p) => Boolean(p.path) !== Boolean(p.url), {
    message: "install requires exactly one of 'path' or 'url'",
  });

const UninstallParamsSchema = z.object({
  pluginId: z.string().min(1),
  deleteSettings: z.boolean().optional(),
});

export interface PluginCliServerHandlers {
  install: (params: { path?: string; url?: string }) => Promise<unknown>;
  uninstall: (params: { pluginId: string; deleteSettings?: boolean }) => Promise<void>;
}

export interface PluginCliServerConfig {
  socketPath: string;
  /** Resolves once the host is ready to accept install/uninstall calls. */
  waitForReady: () => Promise<void>;
  handlers: PluginCliServerHandlers;
}

export interface PluginCliServer {
  listen: () => Promise<void>;
  close: () => Promise<void>;
  readonly socketPath: string;
}

// Re-exported from `shared/utils/cliSocketPath.ts` so the host and the
// `daintree-plugin` CLI client resolve the control socket from a single source
// of truth rather than two byte-for-byte copies that drift.
export { getCliSocketPath };

/** True for filesystem-backed sockets (everything but Windows named pipes). */
function isFileSocket(socketPath: string): boolean {
  return process.platform !== "win32" && !socketPath.startsWith("\\\\");
}

function writeResponse(socket: net.Socket, payload: Record<string, unknown>): void {
  if (socket.destroyed) return;
  try {
    socket.write(JSON.stringify(payload) + "\n");
  } catch {
    // Client vanished mid-write — nothing to recover, the connection is dead.
  }
}

/**
 * Create (but do not yet bind) a CLI control server. `listen()` awaits
 * `waitForReady()` before binding so no request is serviced before the host
 * can honor it; `close()` tears the socket down and removes the on-disk file.
 */
export function createPluginCliServer(config: PluginCliServerConfig): PluginCliServer {
  const { socketPath, waitForReady, handlers } = config;

  async function dispatchMethod(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "plugin.ping":
        return { status: "ok", pid: process.pid };
      case "plugin.install": {
        const p = InstallParamsSchema.parse(params ?? {});
        return handlers.install(p);
      }
      case "plugin.uninstall": {
        const p = UninstallParamsSchema.parse(params ?? {});
        await handlers.uninstall(p);
        return { status: "ok" };
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  async function dispatchFrame(socket: net.Socket, line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      writeResponse(socket, { id: null, error: { message: "Malformed JSON request" } });
      return;
    }

    const req = RequestSchema.safeParse(parsed);
    if (!req.success) {
      writeResponse(socket, { id: null, error: { message: "Invalid request shape" } });
      return;
    }

    const { id, method, params } = req.data;
    try {
      const result = await dispatchMethod(method, params);
      writeResponse(socket, { id, result });
    } catch (err) {
      writeResponse(socket, {
        id,
        error: { message: formatErrorMessage(err, "Plugin CLI request failed") },
      });
    }
  }

  function handleConnection(socket: net.Socket): void {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    let overflowed = false;

    socket.on("data", (chunk: string) => {
      if (overflowed) return;
      buffer += chunk;
      if (buffer.length > MAX_FRAME_BYTES) {
        overflowed = true;
        writeResponse(socket, { id: null, error: { message: "Request exceeds size limit" } });
        socket.destroy();
        return;
      }
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const frame = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        // Fire concurrently — each response carries its own id so the client
        // matches replies; install/uninstall serialize on the plugin lock.
        void dispatchFrame(socket, frame);
        newlineIndex = buffer.indexOf("\n");
      }
    });

    // A client that disconnects (or errors) mid-request is normal; swallow so
    // it can't crash the host.
    socket.on("error", () => {});
  }

  let server: net.Server | null = null;
  const openSockets = new Set<net.Socket>();

  async function listen(): Promise<void> {
    if (server) return;
    await waitForReady();

    const fileSocket = isFileSocket(socketPath);
    if (fileSocket) {
      // Lock the control channel to the owning user: it dispatches plugin
      // install/uninstall (arbitrary path/URL) straight to the trust-gated host
      // handlers with no peer-credential check, and plugins run in-process in
      // the host's trust model. 0700 dir / 0600 socket keep other local users
      // off the socket on shared Unix hosts.
      await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      // Remove any stale socket left by a crashed prior run; otherwise listen()
      // fails with EADDRINUSE on a file that no process is bound to.
      await fs.rm(socketPath, { force: true }).catch(() => {});
    }

    const srv = net.createServer(handleConnection);
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      srv.once("error", onError);
      srv.listen(socketPath, () => {
        srv.off("error", onError);
        resolve();
      });
    });
    if (fileSocket) {
      await fs.chmod(socketPath, 0o600);
    }
    server = srv;
  }

  async function close(): Promise<void> {
    const srv = server;
    server = null;
    if (!srv) return;
    // Drop any half-open client connections so `server.close()` resolves
    // promptly instead of waiting on a client that never sent a full frame.
    for (const socket of openSockets) {
      socket.destroy();
    }
    openSockets.clear();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    if (isFileSocket(socketPath)) {
      await fs.rm(socketPath, { force: true }).catch(() => {});
    }
  }

  return { listen, close, socketPath };
}

// ── Process-wide singleton wiring ──────────────────────────────────────────

let singleton: PluginCliServer | null = null;

/**
 * Start the CLI control server for this app instance. Idempotent. Wires the
 * real socket path, gates binding behind `pluginService.waitForInit()`, and
 * routes install/uninstall through the existing IPC handler trust gates.
 */
export async function startPluginCliServer(): Promise<void> {
  if (singleton) return;
  const { pluginService } = await import("./PluginService.js");
  const { handleInstallFromPath, handleInstallFromUrl, handleUninstall } =
    await import("../ipc/handlers/plugin.js");

  const server = createPluginCliServer({
    socketPath: getCliSocketPath(),
    waitForReady: () => pluginService.waitForInit(),
    handlers: {
      install: ({ path: installPath, url }) => {
        // Schema guarantees exactly one source; these branches are defensive.
        if (url) return handleInstallFromUrl(url);
        if (installPath) return handleInstallFromPath(installPath);
        return Promise.reject(new Error("install requires exactly one of 'path' or 'url'"));
      },
      uninstall: ({ pluginId, deleteSettings }) => handleUninstall(pluginId, deleteSettings),
    },
  });
  // Only claim the singleton once the socket is actually bound — if listen()
  // throws (EADDRINUSE, permissions), a later retry must not be blocked by a
  // dead reference.
  await server.listen();
  singleton = server;
}

/** Stop the singleton CLI control server (best-effort). */
export async function stopPluginCliServer(): Promise<void> {
  const server = singleton;
  singleton = null;
  if (!server) return;
  await server.close();
}
