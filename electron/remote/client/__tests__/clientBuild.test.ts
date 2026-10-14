import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadArtifact,
  fetchHttpsOnly,
  lookupArtifactChecksum,
  updateManifestNameFor,
} from "../clientBuild.js";

const FEED = "https://updates.daintree.org/releases/";
const NAME = "Daintree-1.4.0.AppImage";
const BYTES = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 251));
const SHA = crypto.createHash("sha512").update(BYTES).digest("base64");

function manifest(sha = SHA, size = BYTES.byteLength): string {
  return [
    "version: 1.4.0",
    "files:",
    `  - url: ${NAME}`,
    `    sha512: ${sha}`,
    `    size: ${size}`,
    `path: ${NAME}`,
  ].join("\n");
}

function body(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function feed(opts: { manifest?: string | null; chunks?: Uint8Array[]; length?: number | null }) {
  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.endsWith(".yml")) {
      return opts.manifest === null || opts.manifest === undefined
        ? new Response("not found", { status: 404 })
        : new Response(opts.manifest);
    }
    const chunks = opts.chunks ?? [BYTES.slice(0, 400), BYTES.slice(400)];
    const headers: Record<string, string> = {};
    const length = opts.length === undefined ? BYTES.byteLength : opts.length;
    if (length !== null) headers["content-length"] = String(length);
    return new Response(body(chunks), { headers });
  }) as unknown as typeof fetch;
}

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dt-download-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const download = (fetchImpl: typeof fetch) =>
  downloadArtifact({
    url: `${FEED}${NAME}`,
    destination: path.join(dir, NAME),
    allowedPrefixes: [FEED],
    fetchImpl,
  });

describe("downloadArtifact", () => {
  it("places the file only after its length and the feed's sha512 check out", async () => {
    await download(feed({ manifest: manifest() }));
    expect(new Uint8Array(await fs.readFile(path.join(dir, NAME)))).toEqual(BYTES);
  });

  it("refuses bytes that don't match the feed's sha512, leaving nothing behind", async () => {
    await expect(download(feed({ manifest: manifest("AAAA") }))).rejects.toThrow(/sha512/);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("refuses a body shorter than the length the server announced", async () => {
    await expect(
      download(feed({ manifest: manifest(), chunks: [BYTES.slice(0, 600)] }))
    ).rejects.toThrow(/Received 600 of 1000/);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("keeps writing until the disk has taken every byte of a chunk", async () => {
    const realOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const write = handle.write.bind(handle) as (
        buffer: Uint8Array,
        offset: number,
        length: number
      ) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;
      // A disk that accepts at most 7 bytes per call.
      (handle as unknown as { write: typeof write }).write = (buffer, offset, length) =>
        write(buffer, offset, Math.min(length, 7));
      return handle;
    });
    await download(feed({ manifest: manifest() }));
    expect(new Uint8Array(await fs.readFile(path.join(dir, NAME)))).toEqual(BYTES);
  });

  it("refuses a build the feed lists no checksum for, without downloading it", async () => {
    const fetchImpl = feed({ manifest: null });
    await expect(download(fetchImpl)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    // Only the manifest was asked for.
    expect(vi.mocked(fetchImpl).mock.calls.map((call) => String(call[0]))).toEqual([
      `${FEED}latest-linux.yml`,
    ]);
    expect(await fs.readdir(dir)).toEqual([]);
  });
});

describe("lookupArtifactChecksum", () => {
  it("reads the artifact's entry from the manifest beside it", async () => {
    const fetchImpl = feed({ manifest: manifest() });
    await expect(lookupArtifactChecksum({ url: `${FEED}${NAME}`, fetchImpl })).resolves.toEqual({
      sha512: SHA,
      size: BYTES.byteLength,
    });
    expect(String(vi.mocked(fetchImpl).mock.calls[0]![0])).toBe(`${FEED}latest-linux.yml`);
  });

  it("finds nothing for a build the manifest doesn't list", async () => {
    const other = manifest().replaceAll(NAME, "Daintree-1.5.0-x86_64.AppImage");
    await expect(
      lookupArtifactChecksum({ url: `${FEED}${NAME}`, fetchImpl: feed({ manifest: other }) })
    ).resolves.toBeNull();
  });

  it("says the feed can't be read, rather than that the build isn't listed", async () => {
    const failing = (respond: () => Promise<Response>) =>
      lookupArtifactChecksum({
        url: `${FEED}${NAME}`,
        fetchImpl: vi.fn(respond) as unknown as typeof fetch,
      });
    for (const respond of [
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => new Response("down", { status: 503 }),
      async () => new Response("files: [unterminated"),
      async () => new Response(manifest("not-a-sha512")),
      async () => new Response("version: 1.4.0\n"),
      async () => new Response("files:\n  - null\n"),
      async () => new Response(`files:\n  - url: ${NAME}\n    sha512: 42\n`),
    ]) {
      await expect(failing(respond)).rejects.toMatchObject({
        code: "INTERNAL",
        userMessage: expect.stringContaining("couldn't read the release feed's checksums"),
      });
    }
    // A feed with no manifest for this platform publishes nothing for it.
    await expect(failing(async () => new Response("", { status: 404 }))).resolves.toBeNull();
  });

  it("follows redirects only while every hop stays on https", async () => {
    const hops = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/start")) {
        return new Response(null, { status: 302, headers: { location: "/next" } });
      }
      if (href.endsWith("/next")) {
        return new Response(null, {
          status: 301,
          headers: { location: "http://updates.daintree.org/plain" },
        });
      }
      return new Response("ok");
    }) as unknown as typeof fetch;
    await expect(fetchHttpsOnly(`${FEED}start`, { fetchImpl: hops })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(vi.mocked(hops).mock.calls.map((call) => String(call[0]))).toEqual([
      `${FEED}start`,
      "https://updates.daintree.org/next",
    ]);
    // Never a plain-http request, and redirects are never left to fetch itself.
    for (const call of vi.mocked(hops).mock.calls) {
      expect((call[1] as RequestInit).redirect).toBe("manual");
    }
  });

  it("names the manifest electron-builder publishes per platform", () => {
    expect(updateManifestNameFor("Daintree-1.4.0-arm64-mac.zip")).toBe("latest-mac.yml");
    expect(updateManifestNameFor("daintree_1.4.0_amd64.deb")).toBe("latest-linux.yml");
    expect(updateManifestNameFor("Daintree-1.4.0-arm64.AppImage")).toBe("latest-linux-arm64.yml");
  });
});
