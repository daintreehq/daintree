/**
 * What `host.system.openExternal` accepts. The browser sink is
 * `openExternalUrl`, whose allowlist also admits `http:` and `mailto:`; this
 * narrows a plugin's reach to plain `https:` first.
 */
export const PLUGIN_EXTERNAL_URL_MAX_LENGTH = 2048;

export interface PluginExternalLink {
  /** Re-serialised URL, the only form that is ever opened. */
  href: string;
  /** Lower-cased hostname (punycode for an IDN): the identity a grant is keyed by. */
  site: string;
}

/**
 * Validate a plugin-supplied URL. Returns the normalised link, or the reason it
 * was refused; the reason never carries the URL, which may hold a token.
 */
export function parsePluginExternalUrl(
  url: unknown
): { ok: true; link: PluginExternalLink } | { ok: false; reason: string } {
  if (typeof url !== "string") return { ok: false, reason: "url must be a string" };
  const trimmed = url.trim();
  if (trimmed === "") return { ok: false, reason: "url is empty" };
  if (trimmed.length > PLUGIN_EXTERNAL_URL_MAX_LENGTH) {
    return { ok: false, reason: `url is longer than ${PLUGIN_EXTERNAL_URL_MAX_LENGTH} characters` };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "url is not valid" };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "only https: urls can be opened" };
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "url must not contain credentials" };
  }
  const site = parsed.hostname.toLowerCase();
  if (site === "") return { ok: false, reason: "url has no host" };
  const href = parsed.href;
  if (href.length > PLUGIN_EXTERNAL_URL_MAX_LENGTH) {
    return { ok: false, reason: `url is longer than ${PLUGIN_EXTERNAL_URL_MAX_LENGTH} characters` };
  }
  return { ok: true, link: { href, site } };
}
