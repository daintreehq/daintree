import { z } from "zod";

/**
 * Reads back the markup a dev server served for the preview's current
 * document, for an extractor whose framework's dev tooling takes its stamps
 * off the live elements after load (Astro's toolbar). It comes from the
 * browser's own HTTP cache (`Page.getResourceContent`), so the server is not
 * asked again: a second request would render an on-demand page a second time,
 * side effects and all, and could answer with different markup. A response the
 * cache did not keep (`Cache-Control: no-store`) reads as nothing.
 *
 * Main's own read over its own CDP session, of the document the page was built
 * from; it is still only markup the page's server wrote, so the extractor that
 * receives it reports what it finds there as an observation, like any other.
 */

/** Larger markup is refused outright: a cut-off copy would parse into a different tree. */
export const MAX_SERVED_MARKUP_BYTES = 1024 * 1024;
/** The whole read's deadline; the content read waits on the document's other loads. */
export const SERVED_MARKUP_TIMEOUT_MS = 2_000;

export interface ServedMarkup {
  /** The document's URL without its fragment, as the frame reports it. */
  url: string;
  html: string;
}

type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

const FrameTreeSchema = z.object({
  frameTree: z.object({
    frame: z.object({ id: z.string(), url: z.string(), mimeType: z.string() }),
  }),
});

const ResourceContentSchema = z.object({ content: z.string(), base64Encoded: z.boolean() });

/** Null whenever the read fails, the frame is not the one asked about, or the markup is not HTML or too large. */
export async function readServedMarkup(send: Send, frameId: string): Promise<ServedMarkup | null> {
  let rawTree: unknown;
  try {
    rawTree = await send("Page.getFrameTree");
  } catch {
    return null;
  }
  const tree = FrameTreeSchema.safeParse(rawTree);
  if (!tree.success) return null;
  const { frame } = tree.data.frameTree;
  if (frame.id !== frameId || frame.mimeType !== "text/html" || !/^https?:/i.test(frame.url)) {
    return null;
  }
  let rawContent: unknown;
  try {
    rawContent = await send("Page.getResourceContent", { frameId, url: frame.url });
  } catch {
    return null;
  }
  const read = ResourceContentSchema.safeParse(rawContent);
  if (!read.success) return null;
  const { content, base64Encoded } = read.data;
  // Bounded before decoding, so an oversized body is never copied twice.
  const encodedLimit = base64Encoded
    ? Math.ceil(MAX_SERVED_MARKUP_BYTES / 3) * 4
    : MAX_SERVED_MARKUP_BYTES;
  if (content.length > encodedLimit) return null;
  const html = base64Encoded ? Buffer.from(content, "base64").toString("utf8") : content;
  if (Buffer.byteLength(html, "utf8") > MAX_SERVED_MARKUP_BYTES) return null;
  return { url: frame.url, html };
}
