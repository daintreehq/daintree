import {
  PLUGIN_CATALOG_SOURCE_URL_MAX_LENGTH,
  PLUGIN_CATALOG_URL,
} from "../../../shared/config/pluginCatalog.js";
import type {
  InstalledPluginRecord,
  PluginCatalogSourceRefusal,
} from "../../../shared/types/plugin.js";
import { isPrivateOrLoopbackHostname } from "../../schemas/pluginIdentifiers.js";

export type CatalogSourceUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: Exclude<PluginCatalogSourceRefusal, "duplicate" | "too-many"> };

// C0 controls, DEL and C1 controls: `new URL` strips some of these silently,
// so two spellings of one URL could otherwise differ only in what was dropped.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The one spelling of a catalog URL (#17434), used for the settings list,
 * install links, install records, cache keys and every IPC request, so two
 * spellings of one catalog are never two catalogs. WHATWG parsing already
 * lowercases and IDNA-encodes the host, drops the default port and resolves
 * dot segments; on top of that the fragment goes (it never reaches the
 * server) and so does a trailing dot on the host. Path, query and any other
 * port are kept: they can name different catalogs on one site.
 *
 * Only `https://` on a public host: the same bar a URL install sets, checked
 * again on every hop when the catalog is fetched.
 */
function canonicalize(raw: unknown): CatalogSourceUrlResult {
  if (typeof raw !== "string") return { ok: false, reason: "malformed" };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || CONTROL_CHARACTERS.test(trimmed)) {
    return { ok: false, reason: "malformed" };
  }
  if (trimmed.length > PLUGIN_CATALOG_SOURCE_URL_MAX_LENGTH)
    return { ok: false, reason: "too-long" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: url.protocol === "http:" ? "insecure" : "malformed" };
  }
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };
  if (url.hostname.length === 0) return { ok: false, reason: "malformed" };
  if (isPrivateOrLoopbackHostname(url.hostname)) return { ok: false, reason: "private-host" };
  url.hash = "";
  if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);
  const canonical = url.href;
  if (canonical.length > PLUGIN_CATALOG_SOURCE_URL_MAX_LENGTH) {
    return { ok: false, reason: "too-long" };
  }
  return { ok: true, url: canonical };
}

let daintreeCatalog: string | null = null;

/** Whether `url`, already canonical, is Daintree's own catalog. */
export function isDaintreeCatalogUrl(url: string): boolean {
  if (daintreeCatalog === null) {
    const result = canonicalize(PLUGIN_CATALOG_URL);
    if (!result.ok) throw new Error("PLUGIN_CATALOG_URL isn't a valid catalog URL");
    daintreeCatalog = result.url;
  }
  return url === daintreeCatalog;
}

/**
 * A catalog URL a person could add: canonical, and not Daintree's own catalog
 * under another spelling.
 */
export function canonicalCatalogSourceUrl(raw: unknown): CatalogSourceUrlResult {
  const result = canonicalize(raw);
  if (result.ok && isDaintreeCatalogUrl(result.url)) return { ok: false, reason: "builtin" };
  return result;
}

/**
 * A catalog named in a request or a record, as main uses it: `undefined` for
 * Daintree's own (omitted, or Daintree's URL in any spelling), the canonical
 * URL of an added one, or `null` when it can't name a catalog at all, which
 * callers refuse rather than read as Daintree's.
 */
export function catalogSourceOf(raw: unknown): string | undefined | null {
  if (raw === undefined) return undefined;
  const result = canonicalize(raw);
  if (!result.ok) return null;
  return isDaintreeCatalogUrl(result.url) ? undefined : result.url;
}

/**
 * The catalog an installed copy came from (#17434): `null` when it isn't a
 * catalog install, and `sourceUrl` absent for Daintree's own catalog.
 */
export function installedCatalogOf(
  record: InstalledPluginRecord | undefined
): { sourceUrl?: string } | null {
  if (record?.source !== "catalog" || !record.catalog) return null;
  const { sourceUrl } = record.catalog;
  return typeof sourceUrl === "string" ? { sourceUrl } : {};
}

/**
 * The other catalog a catalog install from `incoming` would replace a copy
 * from, or null when the installed copy (`installed`) is from the same one or
 * isn't a catalog install.
 */
export function replacedCatalogOf(
  installed: { sourceUrl?: string } | null,
  incoming: string | undefined
): { sourceUrl?: string } | null {
  return installed !== null && installed.sourceUrl !== incoming ? installed : null;
}
