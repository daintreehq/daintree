import type { DeclaredProjectLink, DeclaredProjectLinkField } from "../types/projectLinks.js";
import { MAX_PROJECT_LINK_URL_LENGTH } from "./projectLinks.js";

const FIELD_TITLES: Record<DeclaredProjectLinkField, string> = {
  homepage: "Homepage",
  repository: "Repository",
  bugs: "Issues",
};

/** The order the launcher lists them in, whatever order the file names them. */
const FIELD_ORDER: readonly DeclaredProjectLinkField[] = ["homepage", "repository", "bugs"];

/**
 * A web address a package.json field names, or null. Only http(s) counts:
 * anything else (a relative `homepage`, an `ssh` clone address, npm's
 * `owner/repo` shorthand) would need guessing at a host to become one. A
 * username or password is dropped rather than shown, since a clone address
 * often carries one and the page opens without it.
 */
function webAddress(value: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PROJECT_LINK_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!parsed.hostname) return null;
  parsed.username = "";
  parsed.password = "";
  return parsed;
}

/** The address a field names: `homepage` only as a string, the others also as `{ url }`. */
function fieldUrl(field: DeclaredProjectLinkField, value: unknown): string | null {
  if (typeof value === "string") return value;
  if (field === "homepage") return null;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const { url } = value as Record<string, unknown>;
    if (typeof url === "string") return url;
  }
  return null;
}

/**
 * The page a `repository` clone address browses to: `git+https://host/o/r.git`
 * is `https://host/o/r`. On a clone address (a `git+` prefix or a `.git`
 * path) a `#committish` names a checkout, not a place on the page, so it goes.
 */
export function repositoryBrowseUrl(value: string): string | null {
  const trimmed = value.trim();
  const cloneScheme = /^git\+(?=https?:)/i;
  const parsed = webAddress(trimmed.replace(cloneScheme, ""));
  if (parsed === null) return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  const cloneAddress = cloneScheme.test(trimmed) || /\.git$/i.test(path);
  if (/\.git$/i.test(path)) parsed.pathname = path.slice(0, -".git".length);
  if (cloneAddress) parsed.hash = "";
  return parsed.href.length > MAX_PROJECT_LINK_URL_LENGTH ? null : parsed.href;
}

function plainUrl(value: string): string | null {
  const parsed = webAddress(value);
  if (parsed === null) return null;
  return parsed.href.length > MAX_PROJECT_LINK_URL_LENGTH ? null : parsed.href;
}

/**
 * The links a package.json declares in `homepage`, `bugs` and `repository`,
 * from its parsed contents. Anything of the wrong shape is skipped, and an
 * address two fields share is listed once, under the first.
 */
export function declaredLinksFromPackageJson(manifest: unknown): DeclaredProjectLink[] {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return [];
  const fields = manifest as Record<string, unknown>;
  const links: DeclaredProjectLink[] = [];
  const seen = new Set<string>();
  for (const field of FIELD_ORDER) {
    const raw = fieldUrl(field, fields[field]);
    if (raw === null) continue;
    const url = field === "repository" ? repositoryBrowseUrl(raw) : plainUrl(raw);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    links.push({ field, title: FIELD_TITLES[field], url });
  }
  return links;
}
