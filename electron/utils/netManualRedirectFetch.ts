import { Readable } from "node:stream";
import type { ClientRequest, ClientRequestConstructorOptions, IncomingMessage } from "electron";

type NetRequest = (options: ClientRequestConstructorOptions) => ClientRequest;

/** Fetch's null-body statuses: their responses never carry a body stream. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** Electron's `net.fetch` maps header values to byte strings the same way. */
function toByteString(value: string): string {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 255) return Buffer.from(value, "utf-8").toString("latin1");
  }
  return value;
}

function headersFrom(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, toByteString(item));
    } else if (typeof value === "string") {
      headers.set(name, toByteString(value));
    }
  }
  return headers;
}

declare const manualRedirect: unique symbol;

/**
 * A fetch whose `redirect: "manual"` answers a 3xx instead of rejecting, made by
 * {@link createManualRedirectFetch}. Branded because Electron's `net.fetch` has
 * the same shape but rejects every manual-mode redirect, so it must not be
 * accepted where one of these is needed.
 */
export type ManualRedirectFetch = ((url: string, init?: RequestInit) => Promise<Response>) & {
  readonly [manualRedirect]: true;
};

/**
 * A fetch on Electron's network stack whose `redirect: "manual"` works. Electron's
 * `net.fetch` never listens for its request's `redirect` event, so under manual
 * mode Electron cancels every 3xx and rejects with "Redirect was cancelled"
 * (#16855). This one answers a redirect the way Node's fetch does: a bodiless
 * response with the redirect's status and headers, `Location` set to the URL
 * Electron resolved. The request is aborted inside the event, before anything
 * connects to that URL, because `followRedirect()` can only be called
 * synchronously and the caller's per-hop checks are async; the caller fetches
 * the next hop as a new request.
 *
 * Everything else follows `net.fetch`: the same request options and defaults,
 * the `credentials` mapping, the abort reason and the response it builds. It
 * listens on the caller's signal directly rather than through a `Request`, so
 * its listener leaves once the exchange is over. Unlike `net.fetch`, an abort
 * after the headers errors the body with the signal's reason, and a body
 * cancelled or destroyed before its end cancels the request: Electron's
 * `IncomingMessage` can't do that itself, so the connection would otherwise
 * stay open. A request body is refused, since no redirect-following caller
 * could resend one.
 */
export function createManualRedirectFetch(netRequest: NetRequest): ManualRedirectFetch {
  const manualFetch = (url: string, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      if (init.body != null) {
        reject(new TypeError("A request body can't be sent through the manual-redirect fetch"));
        return;
      }
      const signal = init.signal ?? undefined;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }

      const method = (init.method ?? "GET").toUpperCase();
      const redirect = init.redirect ?? "follow";
      const mode = init.mode ?? "cors";
      let clientRequest: ClientRequest;
      try {
        const headers = new Headers(init.headers);
        const origin = headers.get("origin") ?? undefined;
        const credentials = init.credentials ?? "same-origin";
        clientRequest = netRequest({
          method,
          url,
          origin,
          credentials: credentials === "same-origin" && !origin ? "include" : credentials,
          cache: init.cache ?? "default",
          referrerPolicy: init.referrerPolicy ?? "",
          redirect,
        });
        if (mode !== "cors" || origin) clientRequest.setHeader("Sec-Fetch-Mode", mode);
        for (const [name, value] of headers) clientRequest.setHeader(name, value);
      } catch (err) {
        reject(err);
        return;
      }

      let settled = false;
      let message: Readable | null = null;
      // Stays attached while a body streams, so a late abort still tears it down.
      const onAbort = () => {
        settled = true;
        reject(signal!.reason);
        message?.destroy(signal!.reason);
        clientRequest.abort();
      };
      const release = () => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });

      clientRequest.on("redirect", (statusCode, _method, redirectUrl, responseHeaders) => {
        if (redirect !== "manual" || settled) return;
        settled = true;
        release();
        // Aborting here, inside the event, is what stops Electron from both
        // following the redirect and dying with "Redirect was cancelled".
        clientRequest.abort();
        try {
          const headers = headersFrom(responseHeaders);
          headers.set("location", toByteString(redirectUrl));
          resolve(new Response(null, { status: statusCode, headers }));
        } catch (err) {
          reject(err);
        }
      });

      clientRequest.on("response", (incoming: IncomingMessage) => {
        const stream = incoming as unknown as Readable;
        if (settled) {
          stream.destroy();
          return;
        }
        settled = true;
        try {
          const body =
            NULL_BODY_STATUSES.has(incoming.statusCode) || method === "HEAD"
              ? null
              : (Readable.toWeb(stream) as ReadableStream<Uint8Array>);
          const response = new Response(body, {
            headers: headersFrom(incoming.headers),
            status: incoming.statusCode,
            statusText: incoming.statusMessage,
          });
          if (body) {
            message = stream;
            stream.once("close", () => {
              release();
              if (!stream.readableEnded) clientRequest.abort();
            });
          } else {
            release();
          }
          resolve(response);
        } catch (err) {
          release();
          clientRequest.abort();
          reject(err);
        }
      });

      clientRequest.on("error", (err) => {
        if (settled) return;
        settled = true;
        release();
        reject(err);
      });
      clientRequest.end();
    });
  return manualFetch as ManualRedirectFetch;
}
