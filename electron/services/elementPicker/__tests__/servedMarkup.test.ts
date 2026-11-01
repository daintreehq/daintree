// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildServedMarkupSource,
  MAX_SERVED_MARKUP_BYTES,
  servedMarkupFrom,
} from "../servedMarkup.js";

const HTML = '<h1 data-astro-source-loc="6:9">Shop</h1>';

/** Runs the source as the guest would, against a stubbed `fetch`. */
async function runInGuest(answer: (url: string, init: RequestInit) => Promise<Response>) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return answer(url, init);
  });
  const value = (await new Function(`return ${buildServedMarkupSource()}`)()) as unknown;
  return { value, requests };
}

const html = (body: BodyInit, type = "text/html; charset=utf-8", status = 200) =>
  Promise.resolve(new Response(body, { status, headers: { "content-type": type } }));

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

describe("the served-markup fetch", () => {
  it("asks the document's own URL once more, without its fragment, with the page's cookies", async () => {
    history.replaceState(null, "", "/shop?page=2#top");
    const { value, requests } = await runInGuest(() => html(HTML));
    const url = `${location.origin}/shop?page=2`;
    expect(value).toEqual({ url, html: HTML });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(url);
    expect(requests[0]!.init).toMatchObject({
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    });
  });

  it("answers nothing for a response that is not an OK HTML page, or a fetch that fails", async () => {
    for (const answer of [
      () => html(HTML, "application/json"),
      () => html("missing", "text/html", 404),
      () => Promise.reject(new TypeError("Failed to fetch")),
    ]) {
      expect((await runInGuest(answer)).value).toBeNull();
    }
  });

  it("stops reading past the byte cap rather than cut the markup down", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(97);
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    expect((await runInGuest(() => html(endless))).value).toBeNull();
    expect(sent).toBeLessThanOrEqual(MAX_SERVED_MARKUP_BYTES + 2 * chunk.byteLength);
  });
});

describe("servedMarkupFrom", () => {
  it("takes only markup of a page served over HTTP, within the cap", () => {
    const url = "http://127.0.0.1:4321/shop";
    expect(servedMarkupFrom({ url, html: HTML })).toEqual({ url, html: HTML });
    for (const value of [
      null,
      "markup",
      { url },
      { url: "file:///proj/index.html", html: HTML },
      { url: `${url}#top`, html: HTML },
      // Under the cap in characters, over it in UTF-8 bytes.
      { url, html: "é".repeat(MAX_SERVED_MARKUP_BYTES / 2 + 1) },
    ]) {
      expect(servedMarkupFrom(value)).toBeNull();
    }
  });
});
