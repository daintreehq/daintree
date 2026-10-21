/**
 * Not prose: the route matcher resolves `displayedUrl` against a base and
 * matches the pathname, and any human-readable placeholder resolves to a path
 * that a `[...rest]` or `[slug]` route happily claims — fabricating route
 * context for a page we could not read. An opaque-path scheme resolves to
 * `unavailable`, with no leading slash, which no route id can match.
 */
const UNREDACTABLE_URL = "about:unavailable";

/**
 * This string is shown, kept in the request history and may be handed to an
 * agent, so the parts that carry secrets go: userinfo, every query value, and
 * the fragment. Query keys stay — they say which page this is — and so do the
 * origin and path, which are the useful context. Those retained parts are not
 * guaranteed clean: a path segment, a host, or a bare token used as a query
 * key can still be sensitive. This makes a URL safe to pass on, not anonymous.
 *
 * Only http(s) survives at all. The address comes from the guest page and is
 * length-checked and nothing else, and `file:`, `data:` and `javascript:` all
 * parse happily — none of them is an address a dev preview legitimately sits
 * on. Those, and anything `new URL` refuses, become the placeholder rather
 * than a slice of themselves: slicing a string we could not parse is how
 * credentials escaped before.
 */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return UNREDACTABLE_URL;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return UNREDACTABLE_URL;
  const keys = [...new Set(url.searchParams.keys())];
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  if (keys.length === 0) return url.toString();
  return `${url.toString()}?${keys.map((key) => `${encodeURIComponent(key)}=`).join("&")}`;
}
