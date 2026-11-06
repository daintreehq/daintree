/**
 * The markup a dev server serves for the preview's current document, for an
 * extractor whose framework's dev tooling takes its stamps off the live
 * elements after load (Astro's toolbar). Fetched once more from the
 * document's own URL, inside the picker's isolated world so page script
 * cannot patch the request, with the page's cookies, as the document itself
 * was requested: the dev server renders the page a second time to answer, or
 * a service worker controlling the page answers as it would any request of
 * the page's. The browser's cache cannot stand in: in a dev preview,
 * `Page.getResourceContent` finds no cached copy of the document even when
 * its response was cacheable. The bytes are decoded as the document's own
 * were, by its `characterSet`, so its text reads the same in both.
 *
 * It is only markup the page's server wrote, so the extractor that receives
 * it reports what it finds there as an observation, like any other.
 */

/** Larger markup is refused outright: a cut-off copy would parse into a different tree. */
export const MAX_SERVED_MARKUP_BYTES = 1024 * 1024;
/** The whole read's deadline, in the guest and in main alike. */
export const SERVED_MARKUP_TIMEOUT_MS = 3_000;

export interface ServedMarkup {
  /** The document's URL without its fragment, which never reaches the server. */
  url: string;
  html: string;
}

/**
 * Evaluates, awaited and by value, to a {@link ServedMarkup} or null. Only an
 * OK HTML response from the document's own URL counts: a redirect or anything
 * past the byte cap is refused, never followed or cut down.
 */
export function buildServedMarkupSource(): string {
  return `(async () => {
  try {
    const url = location.href.split("#")[0];
    const response = await fetch(url, {
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(${SERVED_MARKUP_TIMEOUT_MS}),
    });
    if (!response.ok || !/^text\\/html\\b/i.test(response.headers.get("content-type") ?? "")) {
      return null;
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ${MAX_SERVED_MARKUP_BYTES}) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let decoder;
    try {
      decoder = new TextDecoder(document.characterSet);
    } catch {
      decoder = new TextDecoder();
    }
    return { url, html: decoder.decode(bytes) };
  } catch {
    return null;
  }
})()`;
}

/** What the guest answered, if it is markup of a page served over HTTP and within the cap; null otherwise. */
export function servedMarkupFrom(value: unknown): ServedMarkup | null {
  if (typeof value !== "object" || value === null) return null;
  const { url, html } = value as Record<string, unknown>;
  if (typeof url !== "string" || typeof html !== "string" || !/^https?:/i.test(url)) return null;
  if (url.includes("#") || Buffer.byteLength(html, "utf8") > MAX_SERVED_MARKUP_BYTES) return null;
  return { url, html };
}
