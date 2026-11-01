import { describe, expect, it } from "vitest";
import { MAX_SERVED_MARKUP_BYTES, readServedMarkup } from "../servedMarkup.js";

const URL = "http://127.0.0.1:4321/shop?page=2";
const HTML = '<h1 data-astro-source-loc="6:9">Shop</h1>';

type Answers = {
  frame?: Record<string, unknown> | Error;
  content?: Record<string, unknown> | Error;
};

function cdp(answers: Answers = {}) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const send = async (method: string, params?: Record<string, unknown>) => {
    calls.push({ method, params });
    const answer =
      method === "Page.getFrameTree"
        ? (answers.frame ?? { id: "main", url: URL, mimeType: "text/html" })
        : (answers.content ?? { content: HTML, base64Encoded: false });
    if (answer instanceof Error) throw answer;
    return method === "Page.getFrameTree" ? { frameTree: { frame: answer } } : answer;
  };
  return { send, calls };
}

describe("readServedMarkup", () => {
  it("reads the frame's document back from the cache, by the URL the frame reports", async () => {
    const { send, calls } = cdp();
    await expect(readServedMarkup(send, "main")).resolves.toEqual({ url: URL, html: HTML });
    expect(calls).toEqual([
      { method: "Page.getFrameTree", params: undefined },
      { method: "Page.getResourceContent", params: { frameId: "main", url: URL } },
    ]);
  });

  it("decodes a body the browser hands back as base64", async () => {
    const { send } = cdp({
      content: { content: Buffer.from(HTML, "utf8").toString("base64"), base64Encoded: true },
    });
    await expect(readServedMarkup(send, "main")).resolves.toEqual({ url: URL, html: HTML });
  });

  it("asks nothing of a frame that is not the one named, not HTML, or not served over HTTP", async () => {
    for (const frame of [
      { id: "child", url: URL, mimeType: "text/html" },
      { id: "main", url: URL, mimeType: "application/json" },
      { id: "main", url: "file:///proj/index.html", mimeType: "text/html" },
      { id: "main" },
    ]) {
      const { send, calls } = cdp({ frame });
      await expect(readServedMarkup(send, "main")).resolves.toBeNull();
      expect(calls.map((call) => call.method)).toEqual(["Page.getFrameTree"]);
    }
  });

  it("reads nothing the cache did not keep, and never throws", async () => {
    const uncached = cdp({ content: new Error("Content unavailable. Resource was not cached") });
    await expect(readServedMarkup(uncached.send, "main")).resolves.toBeNull();
    const noTree = cdp({ frame: new Error("Target closed") });
    await expect(readServedMarkup(noTree.send, "main")).resolves.toBeNull();
    const malformed = cdp({ content: { content: 42 } });
    await expect(readServedMarkup(malformed.send, "main")).resolves.toBeNull();
  });

  it("refuses markup past the cap rather than cut it down, counted in UTF-8 bytes", async () => {
    const fits = "a".repeat(MAX_SERVED_MARKUP_BYTES);
    await expect(readServedMarkup(cdp({ content: { content: fits, base64Encoded: false } }).send, "main")).resolves.toEqual({ url: URL, html: fits });
    // Under the cap in characters, over it in bytes.
    const wide = "é".repeat(MAX_SERVED_MARKUP_BYTES / 2 + 1);
    await expect(
      readServedMarkup(cdp({ content: { content: wide, base64Encoded: false } }).send, "main")
    ).resolves.toBeNull();
    const encoded = Buffer.from(`${fits}a`, "utf8").toString("base64");
    await expect(
      readServedMarkup(cdp({ content: { content: encoded, base64Encoded: true } }).send, "main")
    ).resolves.toBeNull();
  });
});
