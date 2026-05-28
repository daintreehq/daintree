import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createProxyServer, type ProxyServer } from "httpxy";
import {
  DEV_PREVIEW_PROXY_PORT,
  parseDevPreviewProxyHost,
} from "../../shared/utils/devPreviewProxy.js";

const PROXY_HOST = "127.0.0.1";
// Drop a stalled upstream after this long rather than leaving the webview hanging — a
// dev server mid-restart (or wedged) should surface a 502, not an indefinite spinner.
const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Resolves an incoming dev-preview subdomain (e.g. `dp-proj-panel`) to the live upstream
 * dev-server port, or null when no session owns that subdomain. Injected so the proxy stays
 * decoupled from DevPreviewSessionService internals.
 */
export type ResolveUpstreamPort = (subdomain: string) => number | null;

/**
 * Fixed-port reverse proxy that gives every dev-preview panel a stable `*.localhost` origin
 * (#9100). The webview always loads `http://dp-<token>.localhost:<proxyPort>`; this server
 * forwards each request to the panel's current upstream dev-server port, which it resolves
 * live so a dev-server restart on a fresh port is transparent to the webview (the origin —
 * and therefore cookies/localStorage — never changes).
 *
 * Two transforms are load-bearing and handled by httpxy:
 *  - `changeOrigin` rewrites the `Host` header to the upstream so Vite/Next host checks pass.
 *  - `cookieDomainRewrite: ""` strips the `Domain=` attribute from upstream `Set-Cookie`
 *    headers so cookies bind host-only to the stable origin instead of being rejected.
 */
export class DevPreviewProxyService {
  private server: http.Server | null = null;
  private proxy: ProxyServer | null = null;
  private actualPort = 0;
  private startPromise: Promise<number> | null = null;
  private disposed = false;
  // Live sockets (HTTP keep-alive + upgraded WebSockets). server.closeAllConnections() handles
  // HTTP, but WebSocket sockets upgraded off the 'upgrade' event are not tracked by the server,
  // so we destroy them explicitly on dispose to release the port at shutdown.
  private readonly sockets = new Set<Duplex>();

  constructor(private readonly resolveUpstreamPort: ResolveUpstreamPort) {}

  /** The port the proxy actually bound to (43000, or an OS-assigned fallback). 0 until started. */
  get port(): number {
    return this.actualPort;
  }

  /** Idempotent: starts the proxy once and resolves with the bound port on every call. */
  async start(): Promise<number> {
    if (!this.startPromise) {
      this.startPromise = this.startInternal().catch((err) => {
        this.startPromise = null;
        throw err;
      });
    }
    return this.startPromise;
  }

  private async startInternal(): Promise<number> {
    const proxy = createProxyServer({
      changeOrigin: true,
      cookieDomainRewrite: "",
      ws: true,
      proxyTimeout: UPSTREAM_TIMEOUT_MS,
    });
    // httpxy, when an 'error' listener is attached, emits 'error' and resolves the web()/ws()
    // promise rather than rejecting — so the response must be finished here, or the webview
    // hangs on a dead upstream. (An attached listener is also required so a late socket error
    // doesn't surface as an unhandled 'error' event and crash the process.) The per-call
    // try/catch below is a backstop for the reject path; send502/destroy are idempotent.
    proxy.on("error", (_err, _req, res) => {
      if (!res) return;
      if (res instanceof http.ServerResponse) {
        this.send502(res, "The dev server isn't responding.");
      } else {
        res.destroy();
      }
    });
    this.proxy = proxy;

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    server.on("upgrade", (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    });
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    this.server = server;

    const port = await this.listenWithFallback(server);
    this.actualPort = port;
    // Don't keep the Electron event loop alive — the app must be able to quit even while the
    // proxy is listening.
    server.unref();
    return port;
  }

  private listenWithFallback(server: http.Server): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const resolvePort = () => resolve((server.address() as AddressInfo).port);

      const onFirstError = (err: NodeJS.ErrnoException) => {
        if (err.code !== "EADDRINUSE") {
          reject(err);
          return;
        }
        // The fixed port is taken (another Daintree window, or an unrelated process). Fall
        // back to an OS-assigned port; the live port is published via IPC, so callers never
        // assume the fixed value.
        server.once("error", reject);
        server.listen(0, PROXY_HOST, resolvePort);
      };

      server.once("error", onFirstError);
      server.listen(DEV_PREVIEW_PROXY_PORT, PROXY_HOST, () => {
        server.removeListener("error", onFirstError);
        resolvePort();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const port = this.resolvePort(req.headers.host);
    if (port === null) {
      this.send502(res, "No dev server is registered for this preview.");
      return;
    }
    try {
      await this.proxy!.web(req, res, { target: `http://${PROXY_HOST}:${port}` });
    } catch {
      this.send502(res, "The dev server isn't responding.");
    }
  }

  private async handleUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));

    const port = this.resolvePort(req.headers.host);
    if (port === null) {
      socket.destroy();
      return;
    }
    try {
      // The 'upgrade' event types the socket as Duplex; httpxy's ws() wants net.Socket, which
      // is exactly the concrete type Node provides here.
      await this.proxy!.ws(req, socket as Socket, { target: `http://${PROXY_HOST}:${port}` }, head);
    } catch {
      socket.destroy();
    }
  }

  private resolvePort(host: string | undefined): number | null {
    const subdomain = parseDevPreviewProxyHost(host);
    if (!subdomain) return null;
    return this.resolveUpstreamPort(subdomain);
  }

  private send502(res: http.ServerResponse, message: string): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message);
  }

  /** Stop listening and tear down every live connection. Safe to call more than once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        // Socket already gone.
      }
    }
    this.sockets.clear();
    const server = this.server;
    if (server) {
      server.closeAllConnections?.();
      server.close();
    }
    this.server = null;
    this.proxy = null;
  }
}
