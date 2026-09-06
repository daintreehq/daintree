import http from "node:http";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createProxyServer, type ProxyServer } from "httpxy";
import {
  DEV_PREVIEW_BOOTSTRAP_PATH,
  DEV_PREVIEW_PROXY_PORT,
  DEV_PREVIEW_PROXY_STATUS_TEXT,
  buildBootstrapUrl,
  buildDevPreviewProxyOrigin,
  buildDevPreviewSubdomain,
  normalizeBootstrapRedirectPath,
  parseDevPreviewProxyHost,
} from "../../shared/utils/devPreviewProxy.js";
import type {
  DevPreviewProxyFailureCause,
  DevPreviewUpstreamResolution,
} from "../../shared/types/ipc/devPreview.js";

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

// Redirect statuses whose `Location` a browser will follow.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Absolute (`http://host/x`) or protocol-relative (`//host/x`). Only these can carry the
// guest off the proxy origin; a path-relative `Location` is resolved by the guest against
// the proxy URL it asked for and is already correct.
const ABSOLUTE_LOCATION_REGEX = /^(?:https?:)?\/\//i;

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
 * dev-server port AND transport scheme, or a classified miss. The `isHttps` flag lets the
 * proxy dial a TLS dev server (Vite `server.https`, Next.js `--experimental-https`, mkcert)
 * over HTTPS instead of 502-ing on a plain-HTTP dial (#9974). The legacy `{port,isHttps} |
 * null` shape stays accepted (null ≙ unknown subdomain) so existing resolvers keep working;
 * the classified union lets the 502 say WHY there is no upstream (#9100 follow-up).
 * Injected so the proxy stays decoupled from DevPreviewSessionService internals.
 */
export type ResolveUpstream = (
  subdomain: string
) => DevPreviewUpstreamResolution | { port: number; isHttps: boolean } | null;

/**
 * Failure report emitted toward the dev-preview diagnostics timeline. Carries the
 * subdomain (never the request path/body), the transport, a classified cause, and
 * the raw errno code when one exists. Purely observational — proxy behavior is
 * identical with or without a listener.
 */
export interface DevPreviewProxyDiagnostic {
  subdomain: string;
  kind: "http" | "ws";
  cause: DevPreviewProxyFailureCause;
  code?: string;
}

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
  // The origin pair each in-flight proxied request was dialled with, so the response
  // hook rewrites against the upstream this request actually used. Resolving again on
  // the response would risk a different port if the dev server restarted meanwhile.
  // Weak keys: an aborted request is collected without an explicit delete.
  private readonly inFlightOrigins = new WeakMap<
    http.IncomingMessage,
    { upstreamOrigin: string; proxyOrigin: string }
  >();
  private actualPort = 0;
  private portFallback = false;
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

  constructor(
    private readonly resolveUpstreamFn: ResolveUpstream,
    private readonly onDiagnostic?: (event: DevPreviewProxyDiagnostic) => void
  ) {}

  /** The port the proxy actually bound to (43000, or an OS-assigned fallback). 0 until started. */
  get port(): number {
    return this.actualPort;
  }

  /** True when the fixed port was taken and the proxy is on an OS-assigned fallback. */
  get usedPortFallback(): boolean {
    return this.portFallback;
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
    proxy.on("error", (err, req, res) => {
      if (req) {
        const subdomain = parseDevPreviewProxyHost(req.headers?.host);
        const classified = this.classifyUpstreamError(err);
        this.reportFailure(
          subdomain,
          res instanceof http.ServerResponse ? "http" : "ws",
          classified.cause,
          classified.code
        );
      }
      if (!res) return;
      if (res instanceof http.ServerResponse) {
        this.send502(res, "The dev server isn't responding.");
      } else {
        res.destroy();
      }
    });
    // Keep a same-upstream absolute redirect on the panel's stable origin. Without this
    // the guest follows `Location: http://localhost:<upstreamPort>/…` off the proxy
    // origin, and the pane has to migrate it back — losing the route, and re-requesting
    // a single-use callback in the process (#12297).
    //
    // Deliberately not httpxy's `autoRewrite`: that resolves a *relative* Location
    // against the upstream root (so `Location: consume` from `/nested/once` becomes
    // `/consume`) and preserves `https:` for a TLS upstream, which this plain-HTTP
    // proxy does not serve. Emitted before the outgoing header copy, so mutating
    // `proxyRes.headers` here is what reaches the guest.
    proxy.on("proxyRes", (proxyRes, req) => {
      this.rewriteSameUpstreamRedirect(proxyRes, req);
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
        // assume the fixed value. The fallback is remembered so diagnostics can explain why
        // the origin (and therefore cookies/localStorage) differs from previous runs.
        this.portFallback = true;
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

    const { subdomain, resolution } = this.resolveUpstream(req.headers.host);
    if (resolution.kind === "unknown-subdomain") {
      this.reportFailure(subdomain, "http", "no-session");
      this.send502(res, "No dev server is registered for this preview.");
      return;
    }
    if (resolution.kind === "not-running") {
      this.reportFailure(subdomain, "http", "not-running");
      this.send502(res, "The dev server for this preview isn't running.");
      return;
    }
    try {
      // Dial https:// for a TLS dev server, http:// otherwise — httpxy picks https.request vs
      // http.request from the target scheme. `secure: false` accepts the self-signed loopback
      // cert (Vite/Next dev TLS); the upstream is always `localhost`, so this stays loopback-only
      // and never disables verification for a remote host (#9974).
      const scheme = resolution.isHttps ? "https" : "http";
      const target = `${scheme}://${UPSTREAM_HOST}:${resolution.port}`;
      this.rememberRequestOrigins(req, target);
      await this.proxy!.web(req, res, {
        target,
        ...(resolution.isHttps ? { secure: false } : {}),
      });
    } catch (err) {
      const classified = this.classifyUpstreamError(err);
      this.reportFailure(subdomain, "http", classified.cause, classified.code);
      this.send502(res, "The dev server isn't responding.");
    }
  }

  /** Snapshot the origins this request is being proxied between, for the response hook. */
  private rememberRequestOrigins(req: http.IncomingMessage, target: string): void {
    const host = req.headers.host;
    if (!host) return;
    let proxyOrigin: string;
    let upstreamOrigin: string;
    try {
      // The proxy serves plain HTTP only, so the guest-facing origin is always http:.
      proxyOrigin = new URL(`http://${host}`).origin;
      upstreamOrigin = new URL(target).origin;
    } catch {
      return;
    }
    this.inFlightOrigins.set(req, { upstreamOrigin, proxyOrigin });
  }

  /**
   * Rewrite a redirect that points back at the upstream this very request was dialled
   * with, so it lands on the panel's stable origin instead. Scoped deliberately tight:
   * only redirect statuses, only an absolute or protocol-relative `Location`, and only
   * when its origin matches the recorded upstream exactly. A relative Location, a
   * different port, or any external destination is forwarded byte-for-byte.
   */
  private rewriteSameUpstreamRedirect(
    proxyRes: http.IncomingMessage,
    req: http.IncomingMessage
  ): void {
    const origins = this.inFlightOrigins.get(req);
    this.inFlightOrigins.delete(req);
    if (!origins) return;
    if (!REDIRECT_STATUSES.has(proxyRes.statusCode ?? 0)) return;

    const location = proxyRes.headers.location;
    if (typeof location !== "string" || !ABSOLUTE_LOCATION_REGEX.test(location)) return;

    let destination: URL;
    try {
      // Base supplies the scheme for a protocol-relative `//host/path`, matching how a
      // guest on the upstream origin would resolve it.
      destination = new URL(location, origins.upstreamOrigin);
    } catch {
      return;
    }
    if (destination.origin !== origins.upstreamOrigin) return;

    proxyRes.headers.location = `${origins.proxyOrigin}${destination.pathname}${destination.search}${destination.hash}`;
  }

  private async handleUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));

    const { subdomain, resolution } = this.resolveUpstream(req.headers.host);
    if (resolution.kind !== "ok") {
      this.reportFailure(
        subdomain,
        "ws",
        resolution.kind === "not-running" ? "not-running" : "no-session"
      );
      socket.destroy();
      return;
    }
    try {
      // The 'upgrade' event types the socket as Duplex; httpxy's ws() wants net.Socket, which
      // is exactly the concrete type Node provides here. Use wss:// for a TLS dev server so
      // HMR/WebSocket upgrades reach an HTTPS upstream instead of failing the handshake; httpxy's
      // isSSL check matches both `wss` and `https`, and `secure: false` accepts the self-signed
      // loopback cert (#9974).
      const scheme = resolution.isHttps ? "wss" : "http";
      await this.proxy!.ws(
        req,
        socket as Socket,
        {
          target: `${scheme}://${UPSTREAM_HOST}:${resolution.port}`,
          ...(resolution.isHttps ? { secure: false } : {}),
        },
        head
      );
    } catch (err) {
      const classified = this.classifyUpstreamError(err);
      this.reportFailure(subdomain, "ws", classified.cause, classified.code);
      socket.destroy();
    }
  }

  private resolveUpstream(host: string | undefined): {
    subdomain: string | null;
    resolution: DevPreviewUpstreamResolution;
  } {
    const subdomain = parseDevPreviewProxyHost(host);
    if (!subdomain) return { subdomain: null, resolution: { kind: "unknown-subdomain" } };
    const resolved = this.resolveUpstreamFn(subdomain);
    if (resolved === null) return { subdomain, resolution: { kind: "unknown-subdomain" } };
    if ("kind" in resolved) return { subdomain, resolution: resolved };
    return {
      subdomain,
      resolution: { kind: "ok", port: resolved.port, isHttps: resolved.isHttps },
    };
  }

  private classifyUpstreamError(err: unknown): {
    cause: DevPreviewProxyFailureCause;
    code?: string;
  } {
    const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
    if (code === "ECONNREFUSED") return { cause: "upstream-refused", code };
    if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
      return { cause: "upstream-timeout", code };
    }
    return { cause: "upstream-error", ...(typeof code === "string" ? { code } : {}) };
  }

  private reportFailure(
    subdomain: string | null,
    kind: "http" | "ws",
    cause: DevPreviewProxyFailureCause,
    code?: string
  ): void {
    if (!subdomain || !this.onDiagnostic || this.disposed) return;
    try {
      this.onDiagnostic({ subdomain, kind, cause, ...(code !== undefined ? { code } : {}) });
    } catch {
      // Diagnostics must never break proxying.
    }
  }

  private send502(res: http.ServerResponse, message: string): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    // The custom reason phrase is the renderer's only provenance signal for a
    // self-generated 502 — a 502 forwarded from the developer's own app keeps its
    // own status text and must render normally (#12296).
    res.writeHead(502, DEV_PREVIEW_PROXY_STATUS_TEXT, {
      "Content-Type": "text/plain; charset=utf-8",
    });
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
