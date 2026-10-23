import {
  PLUGIN_ARTIFACT_HEADERS_MAX,
  PLUGIN_ARTIFACT_HEADER_VALUE_MAX_LENGTH,
  PLUGIN_ARTIFACT_URL_MAX_LENGTH,
} from "../../../shared/config/pluginArtifacts.js";
import { isPrivateOrLoopbackHostname } from "../../schemas/pluginIdentifiers.js";
import { urlHasCredentials } from "../../utils/pluginDownloadPolicy.js";
import { artifactError } from "./pluginArtifactErrors.js";

/**
 * One `scopes.network.allowedUrls` entry as artifact transfers enforce it: the
 * exact origin, and the path as a prefix ending on a segment boundary, so
 * `https://api.example.com/v2` admits `/v2/files/1` but not `/v20`. A query in
 * the declaration must match exactly; a fragment grants nothing.
 *
 * The manifest schema already refuses non-https, credentialed, wildcard and
 * private entries. This is the first place the list is enforced at runtime
 * rather than read as disclosure.
 */
interface AllowedUrl {
  origin: string;
  pathPrefix: string;
  search: string;
}

export type ArtifactUrlMatcher = (url: URL) => boolean;

export function compileAllowedUrls(entries: readonly string[] | undefined): ArtifactUrlMatcher {
  const allowed: AllowedUrl[] = [];
  for (const entry of entries ?? []) {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" || urlHasCredentials(parsed)) continue;
    allowed.push({
      origin: parsed.origin,
      pathPrefix: parsed.pathname.replace(/\/+$/, ""),
      search: parsed.search,
    });
  }
  return (url) =>
    url.protocol === "https:" &&
    !urlHasCredentials(url) &&
    allowed.some(
      (entry) =>
        entry.origin === url.origin &&
        (entry.pathPrefix === "" ||
          url.pathname === entry.pathPrefix ||
          url.pathname.startsWith(`${entry.pathPrefix}/`)) &&
        (entry.search === "" || entry.search === url.search)
    );
}

/**
 * Parse a transfer URL a plugin handed over and hold it to the declared
 * scope. Rejects with `ARTIFACT_URL_NOT_ALLOWED`, never echoing the URL: it
 * can carry a signed token.
 */
export function admitTransferUrl(
  pluginId: string,
  op: string,
  raw: unknown,
  isAllowed: ArtifactUrlMatcher
): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > PLUGIN_ARTIFACT_URL_MAX_LENGTH) {
    throw artifactError("VALIDATION", `plugin "${pluginId}" artifacts.${op}: url must be a string`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw artifactError("VALIDATION", `plugin "${pluginId}" artifacts.${op}: url is not a URL`);
  }
  if (isPrivateOrLoopbackHostname(url.hostname) || !isAllowed(url)) {
    throw artifactError(
      "ARTIFACT_URL_NOT_ALLOWED",
      `plugin "${pluginId}" artifacts.${op}: the URL is not under the manifest's scopes.network.allowedUrls`
    );
  }
  return url;
}

// The transfer owns these: framing, ranges, cookies and where the request
// claims to come from. A plugin setting any of them could corrupt a resume or
// borrow an identity the host did not give it.
const HOST_OWNED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "keep-alive",
  "expect",
  "range",
  "if-range",
  "cookie",
  "cookie2",
  "origin",
  "referer",
  "proxy-authorization",
  "proxy-connection",
]);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A plugin's request headers, validated and lower-cased. */
export function admitTransferHeaders(
  pluginId: string,
  op: string,
  raw: unknown
): Record<string, string> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw artifactError(
      "VALIDATION",
      `plugin "${pluginId}" artifacts.${op}: headers must be an object`
    );
  }
  const entries = Object.entries(raw);
  if (entries.length > PLUGIN_ARTIFACT_HEADERS_MAX) {
    throw artifactError(
      "VALIDATION",
      `plugin "${pluginId}" artifacts.${op}: at most ${PLUGIN_ARTIFACT_HEADERS_MAX} headers`
    );
  }
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (
      !HEADER_NAME.test(name) ||
      typeof value !== "string" ||
      value.length > PLUGIN_ARTIFACT_HEADER_VALUE_MAX_LENGTH ||
      /[\r\n\0]/.test(value)
    ) {
      throw artifactError(
        "VALIDATION",
        `plugin "${pluginId}" artifacts.${op}: header "${name}" is malformed`
      );
    }
    if (HOST_OWNED_HEADERS.has(lower) || lower.startsWith("sec-") || lower.startsWith("proxy-")) {
      throw artifactError(
        "VALIDATION",
        `plugin "${pluginId}" artifacts.${op}: header "${name}" is set by the host`
      );
    }
    out[lower] = value;
  }
  return out;
}

/**
 * The plugin's headers for one hop: all of them on the origin it asked for,
 * none once a redirect leaves it. A token for the provider's API has no
 * business reaching the storage host it redirects to.
 */
export function headersForHop(
  original: URL,
  hop: URL,
  pluginHeaders: Record<string, string>
): Record<string, string> {
  return hop.origin === original.origin ? { ...pluginHeaders } : {};
}
