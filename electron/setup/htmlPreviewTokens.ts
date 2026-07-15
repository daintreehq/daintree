// eager-import-allow: pure in-memory capability registry, no side effects on import
import { randomUUID } from "node:crypto";
import path from "path";

/**
 * Capability registry backing the `daintree-html://` sandboxed HTML preview
 * scheme (issue #11191).
 *
 * The renderer never encodes a filesystem root into a preview URL directly.
 * Doing so would be exploitable: sandboxed HTML controls the URLs it requests
 * (relative and root-relative refs), so any root it can *name* it can escape to
 * — e.g. `<img src="/<encoded '/'>/etc/passwd">`. Instead Main mints an opaque,
 * unguessable token per containment root and puts it in the URL *authority*
 * (`daintree-html://<token>/<relpath>`). Root-relative (`/x`) and parent (`../x`)
 * refs resolve against that authority, staying inside the mapped root, and the
 * sandboxed document cannot forge a token for a root the app never registered.
 *
 * Tokens are memoized per canonical root and never released: the set of roots is
 * bounded (project + worktrees + the file's parent-directory fallback), the map
 * stays tiny, and a token only ever grants the containment the file panel already
 * has via `files:read`. The `daintree-html://` protocol handler re-applies full
 * realpath + `O_NOFOLLOW` containment on every request, so a stale token can
 * never widen access.
 */

const rootToToken = new Map<string, string>();
const tokenToRoot = new Map<string, string>();

/** Mint (or reuse) the opaque preview token for a canonical containment root. */
export function mintHtmlPreviewToken(canonicalRoot: string): string {
  const existing = rootToToken.get(canonicalRoot);
  if (existing) return existing;
  const token = randomUUID();
  rootToToken.set(canonicalRoot, token);
  tokenToRoot.set(token, canonicalRoot);
  return token;
}

/** Resolve a preview URL authority (token) back to its canonical root, or undefined. */
export function resolveHtmlPreviewRoot(token: string): string | undefined {
  return tokenToRoot.get(token);
}

/**
 * Build a `daintree-html://<token>/<encoded-relpath>` URL for a file inside a
 * root, or null when the file is the root itself or escapes it. Each path
 * segment is percent-encoded so spaces, `#`, `?`, etc. survive; the handler
 * decodes segment-by-segment. Both inputs must already be canonical (realpath'd)
 * absolute paths.
 */
export function buildHtmlPreviewUrl(canonicalRoot: string, canonicalFile: string): string | null {
  const rel = path.relative(canonicalRoot, canonicalFile);
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    return null;
  }
  const token = mintHtmlPreviewToken(canonicalRoot);
  const encoded = rel
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `daintree-html://${token}/${encoded}`;
}

/** Test-only: drop all minted tokens so cases don't leak state into each other. */
export function _resetHtmlPreviewTokensForTests(): void {
  rootToToken.clear();
  tokenToRoot.clear();
}
