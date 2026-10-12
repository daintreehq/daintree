import { describe, expect, it, vi } from "vitest";
import type { ClientFileTransport } from "../ClientFileTransport.js";
import { createHostFileProxy } from "../hostFileProxy.js";
import type { FileResponse } from "../linkMethods.js";

const HOST = "studio-01";
const CAP = "a".repeat(32);
const STREAM = "b".repeat(32);
const SCRIPT = new TextEncoder().encode("<script>alert(1)</script>");

/** A host that answers every preview with `answer`, streaming `chunks` when it streams. */
function proxyFor(answer: FileResponse, chunks: Uint8Array[] = [SCRIPT]) {
  const queue = [...chunks];
  const cancelStream = vi.fn(async () => {});
  const transport = {
    request: async () => answer,
    pull: async () => {
      const bytes = queue.shift() ?? new Uint8Array();
      return { bytes, done: queue.length === 0 };
    },
    cancelStream,
  } as unknown as ClientFileTransport;
  const proxy = createHostFileProxy(transport, {
    viewForCapability: () => 7,
    hostForView: () => HOST,
  });
  const ask = (
    scheme: "daintree-file" | "daintree-media" | "daintree-pdf",
    file: string,
    init?: RequestInit
  ) =>
    proxy(
      scheme,
      { hostId: HOST, viewCapability: CAP },
      new Request(
        `${scheme}://host/${HOST}/${CAP}/load?path=${encodeURIComponent(file)}&root=%2Fp`,
        init
      )
    );
  return { ask, cancelStream };
}

const streamed = (status: number, headers: Record<string, string>): FileResponse => ({
  status,
  headers,
  text: null,
  streamId: STREAM,
});

const hostile = {
  "content-type": "text/html",
  "content-security-policy": "default-src *",
  "x-content-type-options": "",
  "content-length": String(SCRIPT.byteLength),
};

describe("host file previews", () => {
  it("serves a PDF as a PDF whatever type the host claims, with this machine's headers", async () => {
    const { ask } = proxyFor(streamed(200, hostile));
    const response = await ask("daintree-pdf", "/p/docs/spec.pdf");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toContain('filename="spec.pdf"');
    expect(response.headers.get("content-length")).toBe(String(SCRIPT.byteLength));
  });

  it("types a file preview by its own path and always sandboxes it", async () => {
    const { ask } = proxyFor(streamed(200, { ...hostile, "Content-Type": "text/html" }));
    const image = await ask("daintree-file", "/p/a.png");
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  });

  it("refuses what a local preview would, before asking the host", async () => {
    const { ask } = proxyFor(streamed(200, hostile));
    expect((await ask("daintree-media", "/p/a.html")).status).toBe(404);
    expect((await ask("daintree-pdf", "/p/a.html")).status).toBe(415);
  });

  it("refuses a successful answer whose bytes didn't come as a stream", async () => {
    const { ask } = proxyFor({
      status: 200,
      headers: hostile,
      text: "<script>x</script>",
      streamId: null,
    });
    const response = await ask("daintree-pdf", "/p/doc.pdf");
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toBe("text/plain");
  });

  it("serves an empty file the host answered without a stream, as a local preview does", async () => {
    const { ask } = proxyFor({
      status: 200,
      headers: { "content-length": "0" },
      text: null,
      streamId: null,
    });
    const response = await ask("daintree-media", "/p/new.mp4");
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("content-type")).toBe("video/mp4");
  });

  it("still refuses a streamless 200 that claims any bytes", async () => {
    const { ask } = proxyFor({
      status: 200,
      headers: { "content-length": "3" },
      text: null,
      streamId: null,
    });
    expect((await ask("daintree-media", "/p/new.mp4")).status).toBe(502);
  });

  it("answers HEAD with no body, letting go of any stream the host opened", async () => {
    const { ask, cancelStream } = proxyFor(streamed(200, hostile));
    const response = await ask("daintree-file", "/p/a.png", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(cancelStream).toHaveBeenCalledWith(HOST, STREAM);
  });

  it.each([
    ["a redirect", streamed(302, { location: "https://evil.example/" })],
    ["a 204", streamed(204, {})],
    ["a reversed range", streamed(206, { "content-range": "bytes 9-1/20" })],
    ["a range past the file", streamed(206, { "content-range": "bytes 0-20/20" })],
    ["a range with no bytes", streamed(206, { "content-range": "bytes */20" })],
    ["a 206 with no range", streamed(206, {})],
    ["a range on a 200", streamed(200, { "content-range": "bytes 0-1/20" })],
    ["a length that isn't one", streamed(200, { "content-length": "1e3" })],
    ["lengths that disagree", streamed(200, { "Content-Length": "5", "content-length": "6" })],
    [
      "a range its length contradicts",
      streamed(206, { "content-range": "bytes 0-9/20", "content-length": "4" }),
    ],
  ])("refuses %s, and stops the host's stream", async (_label, answer) => {
    const { ask, cancelStream } = proxyFor(answer);
    expect((await ask("daintree-media", "/p/clip.mp4")).status).toBe(502);
    expect(cancelStream).toHaveBeenCalledWith(HOST, STREAM);
  });

  it("passes on a range that adds up, in either header spelling", async () => {
    const { ask } = proxyFor(
      streamed(206, { "Content-Range": "bytes 0-24/100", "CONTENT-LENGTH": "25" })
    );
    const response = await ask("daintree-media", "/p/clip.mp4", {
      headers: { range: "bytes=0-24" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-24/100");
    expect(new Uint8Array(await response.arrayBuffer()).byteLength).toBe(25);
  });

  it("holds a range to its own length when the host gives none", async () => {
    const flood = Array.from({ length: 4 }, () => new Uint8Array(64 * 1024));
    const response = await proxyFor(streamed(206, { "content-range": "bytes 0-0/100" }), flood).ask(
      "daintree-media",
      "/p/clip.mp4"
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-length")).toBe("1");
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it("keeps a 416's file size and nothing else", async () => {
    const { ask } = proxyFor({
      status: 416,
      headers: { "content-range": "bytes */100" },
      text: "nope",
      streamId: null,
    });
    const response = await ask("daintree-media", "/p/clip.mp4");
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */100");
    expect(response.headers.get("content-type")).toBe("text/plain");
  });

  it("refuses a preview larger than a local one may be, by its length or by what arrives", async () => {
    const big = { "content-length": String(600 * 1024) };
    expect((await proxyFor(streamed(200, big)).ask("daintree-file", "/p/notes.txt")).status).toBe(
      413
    );

    const flood = Array.from({ length: 3 }, () => new Uint8Array(256 * 1024));
    const unannounced = await proxyFor(streamed(200, {}), flood).ask(
      "daintree-file",
      "/p/notes.txt"
    );
    expect(unannounced.status).toBe(200);
    await expect(unannounced.arrayBuffer()).rejects.toThrow();
  });

  it("never passes on more or fewer bytes than the host announced", async () => {
    const more = await proxyFor(streamed(200, { "content-length": "4" })).ask(
      "daintree-file",
      "/p/a.png"
    );
    await expect(more.arrayBuffer()).rejects.toThrow();
    const fewer = await proxyFor(streamed(200, { "content-length": "100" })).ask(
      "daintree-file",
      "/p/a.png"
    );
    await expect(fewer.arrayBuffer()).rejects.toThrow();
  });
});
