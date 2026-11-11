import * as semver from "semver";
import { z } from "zod";

import { SCOPED_PLUGIN_NAME_PATTERN } from "../../schemas/pluginIdentifiers.js";
import { ARCHIVE_HASH_PATTERN } from "./installExpectation.js";

/** One reviewed release in the community catalog (`docs/plugins/catalog.md`). */
export interface PluginCatalogEntry {
  readonly id: string;
  readonly repo: string;
  readonly version: string;
  readonly url: string;
  /** Lowercase hex, the form the installer's digest binding requires. */
  readonly sha256: string;
  /** The manifest's list at review time. Display only: it grants nothing. */
  readonly capabilities: readonly string[];
}

export interface PluginCatalog {
  readonly entries: readonly PluginCatalogEntry[];
}

const GITHUB_ORIGIN = "https://github.com";
const GITHUB_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

/**
 * Only the canonical spelling: `semver.parse` also accepts a leading "v" and
 * surrounding space, which would give one release two identities.
 */
function isCanonicalSemver(value: string): boolean {
  const parsed = semver.parse(value);
  if (!parsed) return false;
  const build = parsed.build.length > 0 ? `+${parsed.build.join(".")}` : "";
  return value === `${parsed.version}${build}`;
}

/**
 * A URL is accepted only in the spelling the WHATWG parser would print, so a
 * default port, a dot segment, a backslash or an empty query can't dress up a
 * different address as an allowed one.
 */
function githubPathSegments(value: string): string[] | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.href !== value || url.origin !== GITHUB_ORIGIN) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (value.includes("?") || value.includes("#")) return null;
  const segments = url.pathname.split("/").slice(1);
  return segments.every((segment) => segment.length > 0) ? segments : null;
}

function repoSegments(repo: string): [string, string] | null {
  const segments = githubPathSegments(repo);
  if (!segments || segments.length !== 2) return null;
  const [owner, name] = segments;
  if (!GITHUB_SEGMENT_PATTERN.test(owner) || !GITHUB_SEGMENT_PATTERN.test(name)) return null;
  return [owner, name];
}

/**
 * `https://github.com/{owner}/{repo}/releases/download/{tag}/{asset}.dntr`, in
 * the entry's own repository. `releases/latest/download` fails the shape, and
 * a tag literally named `latest` is refused too: either can serve bytes nobody
 * reviewed.
 */
function isVersionedReleaseAsset(url: string, repo: [string, string]): boolean {
  const segments = githubPathSegments(url);
  if (!segments || segments.length !== 6) return false;
  const [owner, name, releases, download, tag, asset] = segments;
  if (owner.toLowerCase() !== repo[0].toLowerCase()) return false;
  if (name.toLowerCase() !== repo[1].toLowerCase()) return false;
  if (releases !== "releases" || download !== "download") return false;
  if (tag.toLowerCase() === "latest") return false;
  return asset.endsWith(".dntr") && asset.length > ".dntr".length;
}

const PluginCatalogEntrySchema = z
  .object({
    id: z
      .string()
      .max(64)
      .regex(SCOPED_PLUGIN_NAME_PATTERN)
      .refine((id) => !id.startsWith("daintree."), {
        message: "the daintree.* namespace is reserved for builtins",
      }),
    repo: z.string().refine((repo) => repoSegments(repo) !== null, {
      message: "repo must be https://github.com/{owner}/{repo}",
    }),
    version: z.string().refine(isCanonicalSemver, {
      message: "version must be a canonical semver version",
    }),
    url: z.string(),
    sha256: z
      .string()
      .transform((digest) => digest.toLowerCase())
      .pipe(z.string().regex(ARCHIVE_HASH_PATTERN)),
    capabilities: z
      .array(
        z
          .string()
          .min(1)
          .max(128)
          .refine((capability) => !CONTROL_CHARACTER_PATTERN.test(capability))
      )
      .refine((list) => new Set(list).size === list.length, {
        message: "capabilities must not repeat",
      }),
  })
  .superRefine((entry, ctx) => {
    const repo = repoSegments(entry.repo);
    if (repo && !isVersionedReleaseAsset(entry.url, repo)) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "url must be a versioned .dntr release asset in the entry's repo",
      });
    }
  });

/**
 * The whole document is refused when any entry is malformed or an
 * `(id, version)` pair repeats. Dropping only the bad entry would make a
 * missing release ambiguous: "not listed" has to mean delisted, never "listed,
 * but the listing didn't parse".
 */
const PluginCatalogSchema = z
  .object({ entries: z.array(PluginCatalogEntrySchema) })
  .superRefine((catalog, ctx) => {
    const seen = new Set<string>();
    catalog.entries.forEach((entry, index) => {
      const key = `${entry.id}@${entry.version}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index],
          message: `${key} is listed more than once`,
        });
      }
      seen.add(key);
    });
  });

export type PluginCatalogParseResult =
  | { readonly ok: true; readonly catalog: PluginCatalog }
  | { readonly ok: false; readonly error: string };

/**
 * Validate a catalog document. Unknown fields are dropped, and the result is
 * frozen so one caller can't alter what the next one reads.
 */
export function parsePluginCatalog(raw: unknown): PluginCatalogParseResult {
  const parsed = PluginCatalogSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  const entries = parsed.data.entries.map((entry) =>
    Object.freeze({ ...entry, capabilities: Object.freeze([...entry.capabilities]) })
  );
  return { ok: true, catalog: Object.freeze({ entries: Object.freeze(entries) }) };
}
