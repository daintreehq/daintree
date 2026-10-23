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

/**
 * A label is a tag, an id and class tokens, none of which can hold a line
 * break — so one that arrives with a break was not built from the element, and
 * the rest of it is not a second line of anything. Collapsed rather than
 * rejected: the label is how the user recognises what they clicked.
 *
 * Only the breaks go. A no-break space is legal inside an id, at either end of
 * it as much as in the middle, and an id of `save\u00a0` is not the id `save`
 * — so nothing here trims, and no other whitespace is touched.
 */
export function singleLineLabel(label: string): string {
  return label
    .replace(/^[\n\r\f\u0085\u2028\u2029]+|[\n\r\f\u0085\u2028\u2029]+$/gu, "")
    .replace(/[\n\r\f\u0085\u2028\u2029]+/gu, " ");
}
