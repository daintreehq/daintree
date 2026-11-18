import type { DeclaredProjectLink } from "../types/projectLinks.js";
import {
  linkHost,
  MAX_PROJECT_LINK_TITLE_LENGTH,
  MAX_PROJECT_LINK_URL_LENGTH,
} from "./projectLinks.js";

/**
 * The most links one manifest adds, counted after addresses an earlier
 * manifest already listed: a pyproject.toml or catalog-info.yaml can name any
 * number, and one generated file shouldn't push the rest off the list.
 */
export const MAX_DECLARED_LINKS_PER_MANIFEST = 20;

type PackageJsonField = "homepage" | "repository" | "bugs";

const PACKAGE_JSON_FIELDS: readonly (readonly [PackageJsonField, string])[] = [
  ["homepage", "Homepage"],
  ["repository", "Repository"],
  ["bugs", "Issues"],
];

const CARGO_FIELDS = [
  ["homepage", "Homepage"],
  ["documentation", "Documentation"],
  ["repository", "Repository"],
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A web address a manifest field names, or null. Only http(s) counts:
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

/** The address a package.json field names: `homepage` only as a string, the others also as `{ url }`. */
function packageJsonFieldUrl(field: PackageJsonField, value: unknown): string | null {
  if (typeof value === "string") return value;
  if (field === "homepage") return null;
  const { url } = asRecord(value) ?? {};
  return typeof url === "string" ? url : null;
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
 * How much of a name is looked at. A YAML alias can hand the same long name
 * to many links, so each costs a bounded scan, not a pass over the whole text.
 */
const MAX_TITLE_SCAN = MAX_PROJECT_LINK_TITLE_LENGTH * 4;

/**
 * A name the file gives a link, as one line within the length a saved link's
 * name may have, or null when there is nothing to show.
 */
function linkTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clipped = value.length > MAX_TITLE_SCAN;
  let line = "";
  for (const char of clipped ? value.slice(0, MAX_TITLE_SCAN) : value) {
    const code = char.codePointAt(0) ?? 0;
    line += code < 0x20 || (code >= 0x7f && code < 0xa0) ? " " : char;
  }
  const title = line.replace(/\s+/g, " ").trim();
  if (!title) return null;
  if (!clipped && title.length <= MAX_PROJECT_LINK_TITLE_LENGTH) return title;
  let cut = title.slice(0, MAX_PROJECT_LINK_TITLE_LENGTH - 1);
  // Never end on half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** The name the file gives a link, or its host when that name has nothing to show. */
function titleOrHost(name: unknown, url: string): string {
  return linkTitle(name) ?? linkTitle(linkHost(url)) ?? url;
}

/** An address listed twice is shown once, under the first name it was given. */
function uniqueByUrl(links: readonly DeclaredProjectLink[]): DeclaredProjectLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

/**
 * The links a package.json declares in `homepage`, `repository` and `bugs`,
 * in that order whatever order the file names them, from its parsed contents.
 */
export function declaredLinksFromPackageJson(manifest: unknown): DeclaredProjectLink[] {
  const fields = asRecord(manifest);
  if (fields === null) return [];
  const links: DeclaredProjectLink[] = [];
  for (const [field, title] of PACKAGE_JSON_FIELDS) {
    const raw = packageJsonFieldUrl(field, fields[field]);
    if (raw === null) continue;
    const url = field === "repository" ? repositoryBrowseUrl(raw) : plainUrl(raw);
    if (url !== null) links.push({ source: "package.json", title, url });
  }
  return uniqueByUrl(links);
}

/**
 * The links a pyproject.toml lists in `[project.urls]`, from its parsed
 * contents, in the file's order and named by their labels; a blank label
 * names the link by its host.
 */
export function declaredLinksFromPyproject(manifest: unknown): DeclaredProjectLink[] {
  const urls = asRecord(asRecord(asRecord(manifest)?.project)?.urls);
  if (urls === null) return [];
  const links: DeclaredProjectLink[] = [];
  for (const [label, value] of Object.entries(urls)) {
    if (typeof value !== "string") continue;
    const url = plainUrl(value);
    if (url !== null) links.push({ source: "pyproject.toml", title: titleOrHost(label, url), url });
  }
  return uniqueByUrl(links);
}

/**
 * A Cargo.toml address field. A package's own string, or the workspace's
 * value when the package says `field.workspace = true`; a virtual workspace's
 * root has no `[package]`, so what it declares for its members is the
 * project's own. A field the package leaves out isn't inherited. Editions
 * before 2024 also accept `[project]` for the package table.
 */
function cargoFieldValue(
  manifest: Record<string, unknown>,
  field: (typeof CARGO_FIELDS)[number][0]
): string | null {
  const shared = asRecord(asRecord(manifest.workspace)?.package)?.[field];
  const sharedValue = typeof shared === "string" ? shared : null;
  const packageTable = manifest.package !== undefined ? manifest.package : manifest.project;
  if (packageTable === undefined) return sharedValue;
  const own = asRecord(packageTable)?.[field];
  if (typeof own === "string") return own;
  return asRecord(own)?.workspace === true ? sharedValue : null;
}

/**
 * The links a Cargo.toml declares in `homepage`, `documentation` and
 * `repository`, in that order, from its parsed contents.
 */
export function declaredLinksFromCargoToml(manifest: unknown): DeclaredProjectLink[] {
  const fields = asRecord(manifest);
  if (fields === null) return [];
  const links: DeclaredProjectLink[] = [];
  for (const [field, title] of CARGO_FIELDS) {
    const raw = cargoFieldValue(fields, field);
    if (raw === null) continue;
    const url = field === "repository" ? repositoryBrowseUrl(raw) : plainUrl(raw);
    if (url !== null) links.push({ source: "Cargo.toml", title, url });
  }
  return uniqueByUrl(links);
}

/**
 * The links a Backstage catalog-info.yaml lists in `metadata.links`, across
 * every entity the file describes, from its parsed documents. A link without
 * a title is named by its host, as Backstage itself shows the address.
 */
export function declaredLinksFromBackstageCatalog(
  documents: readonly unknown[]
): DeclaredProjectLink[] {
  const links: DeclaredProjectLink[] = [];
  const seen = new Set<string>();
  for (const document of documents) {
    const entries = asRecord(asRecord(document)?.metadata)?.links;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const fields = asRecord(entry);
      if (fields === null || typeof fields.url !== "string") continue;
      const url = plainUrl(fields.url);
      // A link listed again, often through an alias, is shown once, under its first name.
      if (url === null || seen.has(url)) continue;
      seen.add(url);
      links.push({ source: "catalog-info.yaml", title: titleOrHost(fields.title, url), url });
    }
  }
  return links;
}

/**
 * One list from each manifest's, in the order given. An address an earlier
 * manifest already listed stays under that one, and each manifest adds at
 * most {@link MAX_DECLARED_LINKS_PER_MANIFEST}.
 */
export function mergeDeclaredLinks(
  lists: readonly (readonly DeclaredProjectLink[])[]
): DeclaredProjectLink[] {
  const seen = new Set<string>();
  const merged: DeclaredProjectLink[] = [];
  for (const list of lists) {
    let added = 0;
    for (const link of list) {
      if (added === MAX_DECLARED_LINKS_PER_MANIFEST) break;
      if (seen.has(link.url)) continue;
      seen.add(link.url);
      merged.push(link);
      added++;
    }
  }
  return merged;
}
