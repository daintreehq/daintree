import type { UnavailableReason } from "../../../shared/elementPicker/resolution.js";
import type { SourceAccessResult } from "../../../shared/elementPicker/resolver.js";
import { pathToFileURL } from "node:url";
import { NEXT_SOURCE_MAP_ROUTE, isAbsolutePath, isFileUrl } from "./nextDevServer.js";
import { decodeDataUrl, sourceMappingReference } from "./sourceMapReference.js";
import {
  revisionOf,
  type NetworkAllowance,
  type NextSourceMapProvider,
  type ServedSourceMap,
  type SourceMapProvider,
} from "./sourceAccess.js";

/**
 * Fetches a generated module and the map it names, or the map a Next.js dev
 * server's own route holds, from the workspace's preview origin and nowhere
 * else. Every hop is a request of its own: a redirect is followed by hand,
 * checked against the origin before anything is sent to where it points, and
 * paid for out of the job's allowance like the response bodies are, byte by
 * byte as they arrive.
 *
 * Main's job is only to hand the host the map's bytes. Parsing them, and
 * deciding which source a position is in, happens in the host.
 */

export const MAX_SOURCE_MAP_REDIRECTS = 5;

/** Only these move a resource; a 304 or 300 carrying a Location is not a redirect to follow. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The provenance a result carries is bounded; a longer map URL could never be named. */
const MAX_MAP_URL_LENGTH = 2048;

export interface SourceMapProviderOptions {
  fetch?: typeof fetch;
  maxRedirects?: number;
}

type Fetched =
  | { ok: true; url: URL; headers: Headers; bytes: Uint8Array }
  | { ok: false; reason: UnavailableReason };

const refused = (reason: UnavailableReason) => ({ ok: false as const, reason });

function isHttp(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

async function readBody(
  response: Response,
  allowance: NetworkAllowance
): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!allowance.bytes(value.byteLength)) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
    length += value.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

interface Fetcher {
  fetch: typeof fetch;
  maxRedirects: number;
}

function fetcherOf(options: SourceMapProviderOptions): Fetcher {
  return {
    fetch: options.fetch ?? globalThis.fetch,
    maxRedirects: options.maxRedirects ?? MAX_SOURCE_MAP_REDIRECTS,
  };
}

/**
 * One resource from the preview origin, every hop a request of its own: a
 * redirect is followed by hand, checked against the origin before anything
 * is sent to where it points, and paid for out of the job's allowance like
 * the bodies are, byte by byte as they arrive.
 */
async function getResource(
  fetcher: Fetcher,
  start: URL,
  origin: string,
  allowance: NetworkAllowance,
  signal: AbortSignal
): Promise<Fetched> {
  let url = start;
  for (let hop = 0; ; hop++) {
    // Checked before every request, so a redirect off the origin is never followed even once.
    if (!isHttp(url) || url.origin !== origin || url.username || url.password) {
      return refused("outside-workspace");
    }
    if (!allowance.request()) return refused("budget-exhausted");
    const response = await fetcher.fetch(url.href, {
      redirect: "manual",
      credentials: "omit",
      signal,
    });
    if (REDIRECTS.has(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (location === null || hop >= fetcher.maxRedirects) return refused("map-missing");
      try {
        url = new URL(location, url);
      } catch {
        return refused("map-missing");
      }
      url.hash = "";
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return refused("map-missing");
    }
    const bytes = await readBody(response, allowance);
    if (bytes === null) return refused("budget-exhausted");
    return { ok: true, url, headers: response.headers, bytes };
  }
}

export function createSourceMapProvider(options: SourceMapProviderOptions = {}): SourceMapProvider {
  const fetcher = fetcherOf(options);
  const get = (start: URL, origin: string, allowance: NetworkAllowance, signal: AbortSignal) =>
    getResource(fetcher, start, origin, allowance, signal);

  return async (request, signal): Promise<SourceAccessResult<ServedSourceMap>> => {
    const { previewOrigin, allowance } = request;
    let moduleUrl: URL;
    try {
      moduleUrl = new URL(request.generatedUrl);
    } catch {
      return refused("map-missing");
    }
    moduleUrl.hash = "";
    const generated = await get(moduleUrl, previewOrigin, allowance, signal);
    if (!generated.ok) return generated;

    // ECMA-426: the header wins over the comment, and `SourceMap` over the older `X-SourceMap`.
    const header =
      generated.headers.get("sourcemap")?.trim() || generated.headers.get("x-sourcemap")?.trim();
    const reference = header || sourceMappingReference(new TextDecoder().decode(generated.bytes));
    if (!reference) return refused("map-missing");

    if (/^data:/i.test(reference)) {
      const bytes = decodeDataUrl(reference);
      if (!bytes) return refused("map-missing");
      return {
        ok: true,
        value: {
          url: null,
          base: generated.url.href,
          revision: revisionOf(bytes),
          text: new TextDecoder().decode(bytes),
        },
      };
    }

    let mapUrl: URL;
    try {
      mapUrl = new URL(reference, generated.url);
    } catch {
      return refused("map-missing");
    }
    mapUrl.hash = "";
    const map = await get(mapUrl, previewOrigin, allowance, signal);
    if (!map.ok) return map;
    if (map.url.href.length > MAX_MAP_URL_LENGTH) return refused("map-missing");
    return {
      ok: true,
      value: {
        url: map.url.href,
        base: map.url.href,
        revision: revisionOf(map.bytes),
        text: new TextDecoder().decode(map.bytes),
      },
    };
  };
}

/**
 * The raw map a Next.js dev server holds for a module no request could fetch:
 * a server chunk on its disk, or a Webpack module in its compilation. The
 * route is private and fixed; the page names only the module, sent as a query
 * value, never where the request goes. An empty answer is the route saying it
 * has none.
 */
export function createNextSourceMapProvider(
  options: SourceMapProviderOptions = {}
): NextSourceMapProvider {
  const fetcher = fetcherOf(options);
  return async ({ previewOrigin, filename, allowance }, signal) => {
    let url: URL;
    try {
      url = new URL(NEXT_SOURCE_MAP_ROUTE, previewOrigin);
    } catch {
      return refused("map-missing");
    }
    url.searchParams.set("filename", filename);
    if (url.href.length > MAX_MAP_URL_LENGTH) return refused("map-missing");
    const map = await getResource(fetcher, url, previewOrigin, allowance, signal);
    if (!map.ok) return map;
    if (map.bytes.byteLength === 0 || map.url.href.length > MAX_MAP_URL_LENGTH) {
      return refused("map-missing");
    }
    return {
      ok: true,
      value: {
        url: map.url.href,
        // A chunk's relative sources sit beside the chunk, not under the route.
        base: isAbsolutePath(filename)
          ? pathToFileURL(filename).href
          : isFileUrl(filename)
            ? filename
            : map.url.href,
        revision: revisionOf(map.bytes),
        text: new TextDecoder().decode(map.bytes),
      },
    };
  };
}
