import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ClientRequest, ClientRequestConstructorOptions } from "electron";

/** What the fake server answers for one URL. */
export type FakeRoute =
  | { redirect: string; status?: number; headers?: Record<string, string[]> }
  | { status: number; headers?: Record<string, string>; body?: string; statusMessage?: string }
  | { error: string }
  | { hang: true };

/**
 * A stand-in for Electron 45's `ClientRequest`, reproducing its redirect rules:
 * under `redirect: "manual"` the `redirect` event fires synchronously, and unless
 * a listener calls `followRedirect()` inside it or the request was aborted, the
 * request dies with "Redirect was cancelled" — which is all `net.fetch` ever
 * gets, since it never listens for the event.
 */
export class FakeClientRequest extends EventEmitter {
  readonly headers: Record<string, string> = {};
  aborted = false;
  ended = false;
  /** A redirect this request was allowed to follow, in order. */
  readonly followed: string[] = [];
  response: (Readable & { statusCode: number }) | null = null;
  private followCb: (() => void) | undefined;

  constructor(
    readonly options: ClientRequestConstructorOptions,
    private readonly net: FakeElectronNet
  ) {
    super();
  }

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  end(): void {
    this.ended = true;
    queueMicrotask(() => this.net.serve(this, this.options.url!));
  }

  abort(): void {
    if (!this.aborted) process.nextTick(() => this.emit("abort"));
    this.aborted = true;
    this.die();
  }

  followRedirect(): void {
    if (!this.followCb)
      throw new Error("followRedirect() called, but was not waiting for a redirect");
    this.followCb();
  }

  /** Electron's `_urlLoader` "redirect" handler. */
  redirectTo(statusCode: number, newUrl: string, headers: Record<string, string[]>): void {
    const policy = this.options.redirect ?? "follow";
    if (policy === "error") {
      this.die(new Error("Attempted to redirect, but redirect policy was 'error'"));
      return;
    }
    let follow = policy === "follow";
    this.followCb = () => {
      follow = true;
    };
    try {
      this.emit("redirect", statusCode, "GET", newUrl, headers);
    } finally {
      this.followCb = undefined;
      if (!follow && !this.aborted) this.die(new Error("Redirect was cancelled"));
    }
    if (follow && !this.aborted) {
      this.followed.push(newUrl);
      queueMicrotask(() => this.net.serve(this, newUrl));
    }
  }

  respond(status: number, headers: Record<string, string>, body: string, statusMessage = ""): void {
    const message = Object.assign(new Readable({ read() {} }), {
      statusCode: status,
      statusMessage,
      headers,
    });
    this.response = message;
    this.emit("response", message);
    if (body) message.push(Buffer.from(body));
    message.push(null);
  }

  /**
   * Electron's `_die`. A request with no body is a finished, auto-destroyed
   * writable by the time anything answers it, and on a destroyed request the
   * error is emitted synchronously; only an unfinished one defers it.
   */
  die(err?: Error): void {
    if (err && this.ended) this.emit("error", err);
    else if (err) process.nextTick(() => this.emit("error", err));
    this.response?.destroy(err);
  }
}

/** A fake `net` whose requests are answered from `routes`, keyed by URL. */
export class FakeElectronNet {
  readonly requests: FakeClientRequest[] = [];

  constructor(readonly routes: Record<string, FakeRoute>) {}

  readonly request = (options: ClientRequestConstructorOptions): ClientRequest => {
    const request = new FakeClientRequest(options, this);
    this.requests.push(request);
    return request as unknown as ClientRequest;
  };

  /** Every URL a request connected to, in order. */
  get connected(): string[] {
    return this.requests.flatMap((r) => (r.ended ? [r.options.url!, ...r.followed] : []));
  }

  serve(request: FakeClientRequest, url: string): void {
    if (request.aborted) return;
    const route = this.routes[url];
    if (!route) {
      request.respond(404, { "content-type": "text/plain" }, "not found");
    } else if ("hang" in route) {
      // Never answers.
    } else if ("error" in route) {
      request.die(new Error(route.error));
    } else if ("redirect" in route) {
      request.redirectTo(route.status ?? 302, route.redirect, {
        location: [route.redirect],
        ...route.headers,
      });
    } else {
      request.respond(route.status, route.headers ?? {}, route.body ?? "", route.statusMessage);
    }
  }

  /**
   * Electron's own `net.fetch` over this fake: it never listens for `redirect`,
   * so a manual-mode 3xx rejects with "Redirect was cancelled".
   */
  readonly electronFetch = (url: string, init: RequestInit = {}): Promise<Response> =>
    new Promise((resolve, reject) => {
      const request = this.request({
        url,
        method: init.method ?? "GET",
        redirect: init.redirect ?? "follow",
      }) as unknown as FakeClientRequest;
      request.on("response", (message: Readable & { statusCode: number }) => {
        resolve(
          new Response(Readable.toWeb(message) as ReadableStream, { status: message.statusCode })
        );
      });
      request.on("error", reject);
      request.end();
    });
}
