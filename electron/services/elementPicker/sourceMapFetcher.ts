import type { UnavailableReason } from "../../../shared/elementPicker/resolution.js";
import type { SourceAccessResult } from "../../../shared/elementPicker/resolver.js";
import {
  revisionOf,
  type NetworkAllowance,
  type ServedSourceMap,
  type SourceMapProvider,
} from "./sourceAccess.js";

/**
 * Fetches a generated module and the map it names, from the workspace's
 * preview origin and nowhere else. Every hop is a request of its own: a
 * redirect is followed by hand, checked against the origin before anything is
 * sent to where it points, and paid for out of the job's allowance like the
 * response bodies are, byte by byte as they arrive.
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

/**
 * The map a module names in its trailing comments: the last annotation in the
 * run of comment and blank lines that ends the file, and none at all once a
 * line of code comes after it. A block comment counts when it opens and closes
 * on its own line. Conservative on purpose: an annotation-shaped
 * string inside the module's own code is not where its map is.
 */
export function sourceMappingReference(text: string): string | null {
  let end = text.length;
  while (end > 0) {
    const newline = text.lastIndexOf("\n", end - 1);
    const line = text.slice(newline + 1, end).trim();
    end = newline;
    if (line === "") continue;
    const match =
      /^\/\/[#@]\s*sourceMappingURL=(\S+)$/.exec(line) ??
      /^\/\*[#@]\s*sourceMappingURL=(\S+?)\s*\*\/$/.exec(line);
    if (match) return match[1]!;
    const comment =
      line.startsWith("//") ||
      (line.startsWith("/*") && line.endsWith("*/") && line.indexOf("*/") === line.length - 2);
    if (!comment) return null;
  }
  return null;
}

/**
 * A `data:` map's bytes: base64 or percent-encoded JSON. The charset parameter
 * is read and not honoured: a source map is UTF-8 JSON whatever it claims.
 */
export function decodeDataUrl(reference: string): Uint8Array | null {
  const comma = reference.indexOf(",");
  if (comma === -1) return null;
  const parameters = reference
    .slice("data:".length, comma)
    .split(";")
    .map((part) => part.trim().toLowerCase());
  const mediaType = parameters[0];
  if (mediaType !== "" && mediaType !== "application/json" && mediaType !== "text/plain") {
    return null;
  }
  const data = reference.slice(comma + 1);
  if (parameters.includes("base64")) {
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(data)) return null;
    return new Uint8Array(Buffer.from(data, "base64"));
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(data));
  } catch {
    return null;
  }
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

export function createSourceMapProvider(options: SourceMapProviderOptions = {}): SourceMapProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? MAX_SOURCE_MAP_REDIRECTS;

  async function get(
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
      const response = await fetchImpl(url.href, {
        redirect: "manual",
        credentials: "omit",
        signal,
      });
      if (REDIRECTS.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (location === null || hop >= maxRedirects) return refused("map-missing");
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
