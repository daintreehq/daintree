import http from "node:http";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createProxyServer, type ProxyServer } from "httpxy";
import {
  DEV_PREVIEW_BOOTSTRAP_PATH,
  DEV_PREVIEW_PROXY_PORT,
  buildBootstrapUrl,
  buildDevPreviewProxyOrigin,
  buildDevPreviewSubdomain,
  normalizeBootstrapRedirectPath,
  parseDevPreviewProxyHost,
} from "../../shared/utils/devPreviewProxy.js";

// The proxy binds IPv4 loopback only — it should be reachable from this machine, nothing else.
const PROXY_LISTEN_HOST = "127.0.0.1";
// Upstream target uses "localhost" (not a fixed IP) so Node's Happy Eyeballs (autoSelectFamily,
// default since Node 20) tries the dev server on whichever family it bound — IPv6-first with an
// IPv4 fallback. Vite 8 + macOS resolve `localhost` to [::1] and bind IPv6-only; hardcoding
// 127.0.0.1 here made every proxied request ECONNREFUSED → 502 (#9747).
const UPSTREAM_HOST = "localhost";
// Drop a stalled upstream after this long rather than leaving the webview hanging — a
// dev server mid-restart (or wedged) should surface a 502, not an indefinite spinner.
const UPSTREAM_TIMEOUT_MS = 30_000;

// "Open in real browser" handoff token (#9101). The token is HMAC-signed,
// single-use, bound to its issuing panel, and expires fast — it only has to
// survive the round-trip from `shell.openExternal` to the browser's first
// request, so a short window keeps the redeem surface tiny.
const BROWSER_TOKEN_TTL_MS = 60_000;
// Cap the unredeemed-JTI set so a flood of minted-but-never-opened tokens can't
// grow main-process memory without bound; oldest entries evict first (insertion
// order). 60s TTL means realistic traffic stays far below this.
const MAX_PENDING_TOKENS = 500;
const TOKEN_REAP_INTERVAL_MS = 60_000;
// Daintree-proxy-scoped session marker set on the stable origin after a valid
// bootstrap. Host-only (no Domain=, which Chromium rejects on `.localhost`),
// HttpOnly, SameSite=Strict. It does NOT carry upstream auth — the external
// browser still authenticates with the dev server on its own.
const SESSION_COOKIE_NAME = "__dp_sess";

interface BrowserTokenPayload {
  jti: string;
  panelId: string;
  projectId: string;
  rd: string;
  iat: number;
  exp: number;
}

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

  // HMAC key for browser-handoff tokens (#9101). Generated per proxy instance —
  // tokens never outlive the process, so there is no key to persist or rotate.
  private readonly tokenKey = randomBytes(32);
  // Pending single-use token JTIs → expiry epoch ms. Insertion order is the
  // eviction order; a redeemed JTI is deleted to enforce single use.
  private readonly pendingTokens = new Map<string, number>();
  private reaper: NodeJS.Timeout | null = null;

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

    // Sweep expired token JTIs so a steady trickle of unredeemed tokens doesn't
    // pile up between the size-cap evictions. unref() so this timer never blocks
    // app quit (a live setInterval in the main process hangs shutdown).
    this.reaper = setInterval(() => this.reapTokens(), TOKEN_REAP_INTERVAL_MS);
    this.reaper.unref();

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
        server.listen(0, PROXY_LISTEN_HOST, resolvePort);
      };

      server.once("error", onFirstError);
      server.listen(DEV_PREVIEW_PROXY_PORT, PROXY_LISTEN_HOST, () => {
        server.removeListener("error", onFirstError);
        resolvePort();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // The bootstrap route is served by the proxy itself — never forwarded
    // upstream. Gate it before resolving an upstream port so it works even while
    // the dev server is down (restarting), which is one of the cases it exists
    // to survive.
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? PROXY_LISTEN_HOST}`);
    if (url.pathname === DEV_PREVIEW_BOOTSTRAP_PATH) {
      this.handleBootstrap(req, res, url);
      return;
    }

    const port = this.resolvePort(req.headers.host);
    if (port === null) {
      this.send502(res, "No dev server is registered for this preview.");
      return;
    }
    try {
      await this.proxy!.web(req, res, { target: `http://${UPSTREAM_HOST}:${port}` });
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
      await this.proxy!.ws(
        req,
        socket as Socket,
        { target: `http://${UPSTREAM_HOST}:${port}` },
        head
      );
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

  /**
   * Mint a short-lived, single-use, panel-bound token and return the full
   * bootstrap URL the system browser should open (#9101). The token is the only
   * thing the renderer needs — it never sees the signing key or token internals.
   */
  mintBrowserToken(panelId: string, projectId: string, redirectPath: string): string {
    const rd = normalizeBootstrapRedirectPath(redirectPath);
    const now = Date.now();
    const jti = randomUUID();
    const payload: BrowserTokenPayload = {
      jti,
      panelId,
      projectId,
      rd,
      iat: now,
      exp: now + BROWSER_TOKEN_TTL_MS,
    };

    // Evict the oldest pending token(s) before inserting so the set stays bounded
    // even if tokens are minted far faster than they're redeemed or reaped.
    while (this.pendingTokens.size >= MAX_PENDING_TOKENS) {
      const oldest = this.pendingTokens.keys().next().value;
      if (oldest === undefined) break;
      this.pendingTokens.delete(oldest);
    }
    this.pendingTokens.set(jti, payload.exp);

    const origin = buildDevPreviewProxyOrigin(this.actualPort, projectId, panelId);
    return buildBootstrapUrl(origin, this.signToken(payload), rd);
  }

  private signToken(payload: BrowserTokenPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", this.tokenKey).update(body).digest("base64url");
    return `${body}.${sig}`;
  }

  /**
   * Verify a token's signature, expiry, panel binding, and single-use JTI.
   * Returns the payload on success and consumes the JTI (so a replay fails);
   * returns null on any failure. The JTI is consumed only after every other
   * check passes, so a request to the wrong panel's origin can't burn a token
   * that is still valid for its real panel. Signature comparison is constant-time.
   */
  private verifyAndConsumeToken(
    token: string,
    requestSubdomain: string | null
  ): BrowserTokenPayload | null {
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    const expectedSig = createHmac("sha256", this.tokenKey).update(body).digest();
    let providedSig: Buffer;
    try {
      providedSig = Buffer.from(sig, "base64url");
    } catch {
      return null;
    }
    if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
      return null;
    }

    let payload: BrowserTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as BrowserTokenPayload;
    } catch {
      return null;
    }
    if (
      !payload ||
      typeof payload.jti !== "string" ||
      typeof payload.exp !== "number" ||
      typeof payload.panelId !== "string" ||
      typeof payload.projectId !== "string"
    ) {
      return null;
    }
    // Panel binding: the token is only valid on the origin of the panel it was
    // minted for — a token for panel A must not set a session cookie on panel B.
    if (requestSubdomain !== buildDevPreviewSubdomain(payload.projectId, payload.panelId)) {
      return null;
    }
    // Aligned with reapTokens (exp <= now) so a token at exactly its expiry is
    // treated as expired by both paths, not accepted by one and reaped by the other.
    if (Date.now() >= payload.exp) {
      this.pendingTokens.delete(payload.jti);
      return null;
    }
    // Single-use: the JTI must still be pending, and is consumed on redeem.
    if (!this.pendingTokens.delete(payload.jti)) return null;
    return payload;
  }

  private handleBootstrap(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    // The bootstrap is reached only by the browser navigating to the link — a
    // GET. Reject everything else, including HEAD: a HEAD from a link-preflight
    // scanner or corporate proxy must not consume the single-use token before
    // the user's real GET arrives.
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET", "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method not allowed.");
      return;
    }

    const token = url.searchParams.get("token") ?? "";
    const requestSubdomain = parseDevPreviewProxyHost(req.headers.host);
    const payload = token ? this.verifyAndConsumeToken(token, requestSubdomain) : null;
    if (!payload) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("This sign-in link is invalid or has expired.");
      return;
    }

    // The redirect target comes from the signed payload, never the (untrusted)
    // `rd` query param — that param is a fast-fail hint only. Re-normalize as a
    // defense-in-depth backstop in case an older/forged payload slips a bad path.
    const location = normalizeBootstrapRedirectPath(payload.rd);
    const cookie =
      `${SESSION_COOKIE_NAME}=${payload.jti}; HttpOnly; SameSite=Strict; Path=/; ` +
      `Max-Age=${Math.floor(BROWSER_TOKEN_TTL_MS / 1000)}`;
    res.writeHead(302, { Location: location, "Set-Cookie": cookie });
    res.end();
  }

  private reapTokens(): void {
    const now = Date.now();
    for (const [jti, exp] of this.pendingTokens) {
      if (exp <= now) this.pendingTokens.delete(jti);
    }
  }

  /** Stop listening and tear down every live connection. Safe to call more than once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    this.pendingTokens.clear();
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
