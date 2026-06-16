import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { z } from "zod";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import {
  getCliSocketPath,
  getCliControlFilePath,
  writeCliControlFile,
  removeCliControlFile,
} from "../../shared/utils/cliSocketPath.js";

/**
 * Local control socket that lets the `daintree-plugin` CLI drive a running
 * Daintree instance for `install` / `uninstall` (F32). The CLI connects over a
 * Unix domain socket (`~/.daintree/cli.sock`) or a Windows named pipe
 * (`\\.\pipe\daintree-cli-<random>`) and exchanges newline-delimited JSON frames:
 *
 *   request:  { "id": <string|number>, "method": <string>, "params"?: <object>, "token": <string> }
 *   response: { "id": <id>, "result": <value> }  |  { "id": <id>, "error": { "message": <string> } }
 *
 * Every frame must carry the per-launch `token` the host advertises in its
 * control-discovery file (#10518). The 0700 socket dir already limits the Unix
 * socket to the same user, but a same-user process is exactly the attacker the
 * token raises the bar against, and on Windows the named pipe's default ACL is
 * broad — the token (readable only from the user-owned control file) is what
 * authenticates the peer there. Validated with `timingSafeEqual` before any
 * method dispatches; an unauthenticated frame gets an error and the socket is
 * destroyed.
 *
 * Every CLI install/uninstall routes through the SAME handler functions the IPC
 * surface uses, so the path/magic-byte/`.dntr` guards and the scoped-name check
 * are never re-implemented or bypassed. The server only binds after the plugin
 * service has finished initializing — a `plugin.install` arriving mid-activation
 * would otherwise race the load path.
 */

const MAX_FRAME_BYTES = 64 * 1024;

/** Request envelope. `params` shape is validated per-method; `token` is the auth gate. */
const RequestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string().min(1),
  params: z.unknown().optional(),
  token: z.string().optional(),
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

const DevParamsSchema = z.object({
  pluginId: z.string().min(1),
});

export interface PluginCliServerHandlers {
  install: (params: { path?: string; url?: string }) => Promise<unknown>;
  uninstall: (params: { pluginId: string; deleteSettings?: boolean }) => Promise<void>;
  /** Load + activate a dev plugin the CLI symlinked into the plugins root. */
  devStart: (params: { pluginId: string }) => Promise<void>;
  /** Unload a dev plugin when the CLI's `dev` session stops. */
  devStop: (params: { pluginId: string }) => Promise<void>;
}

export interface PluginCliServerConfig {
  socketPath: string;
  /** Resolves once the host is ready to accept install/uninstall calls. */
  waitForReady: () => Promise<void>;
  handlers: PluginCliServerHandlers;
  /**
   * Where to write the control-discovery file (socket path + auth token).
   * Defaults to {@link getCliControlFilePath}; tests point it at a temp file so
   * they never clobber the real `~/.daintree/cli-control.json`.
   */
  controlFilePath?: string;
  /**
   * Per-launch auth token clients must echo on every frame. Defaults to a fresh
   * 256-bit random hex string; injectable so tests can assert the auth gate.
   */
  authToken?: string;
}

export interface PluginCliServer {
  listen: () => Promise<void>;
  close: () => Promise<void>;
  readonly socketPath: string;
  /** The token a client must present on every frame (advertised via the control file). */
  readonly authToken: string;
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
 * Constant-time token comparison. Rejects a missing/empty token up front and
 * length-guards before `timingSafeEqual` (which throws on unequal-length
 * buffers) — the length check is not itself a timing leak since the token length
 * is fixed and public.
 */
function tokenIsValid(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Create (but do not yet bind) a CLI control server. `listen()` awaits
 * `waitForReady()` before binding so no request is serviced before the host
 * can honor it; `close()` tears the socket down and removes the on-disk file.
 */
export function createPluginCliServer(config: PluginCliServerConfig): PluginCliServer {
  const { socketPath, waitForReady, handlers } = config;
  const controlFilePath = config.controlFilePath ?? getCliControlFilePath();
  const authToken = config.authToken ?? crypto.randomBytes(32).toString("hex");

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
      case "plugin.dev.start": {
        const p = DevParamsSchema.parse(params ?? {});
        await handlers.devStart(p);
        return { status: "ok" };
      }
      case "plugin.dev.stop": {
        const p = DevParamsSchema.parse(params ?? {});
        await handlers.devStop(p);
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

    const { id, method, params, token } = req.data;

    // Authenticate before dispatching anything (#10518). An unauthenticated peer
    // gets a single error frame, then the connection is closed — no method (not
    // even plugin.ping) runs and the socket can't be probed frame-by-frame.
    // `end()` (not `destroy()`) flushes the error frame before the FIN so the
    // client always sees why it was rejected rather than a bare disconnect.
    if (!tokenIsValid(token, authToken)) {
      writeResponse(socket, { id, error: { message: "Unauthorized: invalid or missing token" } });
      socket.end();
      return;
    }

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
    // Advertise the bound path + auth token only after the socket is live, so a
    // racing CLI never reads a control file pointing at a not-yet-listening
    // endpoint. The file itself is written owner-only (0700 dir / 0600 file).
    await writeCliControlFile(controlFilePath, { socketPath, token: authToken });
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
    // Remove the discovery file first so a CLI started during teardown sees
    // "not running" instead of dialing a dead socket.
    await removeCliControlFile(controlFilePath);
    if (isFileSocket(socketPath)) {
      await fs.rm(socketPath, { force: true }).catch(() => {});
    }
  }

  return { listen, close, socketPath, authToken };
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

  // On Windows the named pipe can't carry a restrictive DACL from pure node, so
  // its default ACL is broad. Randomize the pipe name per launch (#10518) so it
  // isn't a fixed, predictable target; the CLI discovers the real name from the
  // control file rather than hardcoding it. The token gate is still the actual
  // authentication. An explicit DAINTREE_CLI_SOCKET override is honored as-is.
  const socketPath =
    process.platform === "win32" && !process.env.DAINTREE_CLI_SOCKET
      ? `\\\\.\\pipe\\daintree-cli-${crypto.randomUUID()}`
      : getCliSocketPath();

  const server = createPluginCliServer({
    socketPath,
    waitForReady: () => pluginService.waitForInit(),
    handlers: {
      install: ({ path: installPath, url }) => {
        // Schema guarantees exactly one source; these branches are defensive.
        if (url) return handleInstallFromUrl(url);
        if (installPath) return handleInstallFromPath(installPath);
        return Promise.reject(new Error("install requires exactly one of 'path' or 'url'"));
      },
      uninstall: ({ pluginId, deleteSettings }) => handleUninstall(pluginId, deleteSettings),
      devStart: ({ pluginId }) => pluginService.loadDevPlugin(pluginId),
      devStop: ({ pluginId }) => {
        pluginService.unloadPlugin(pluginId);
        return Promise.resolve();
      },
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
