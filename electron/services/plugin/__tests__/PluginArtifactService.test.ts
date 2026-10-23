// @vitest-environment node
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every provider host resolves to a public address; nothing touches the network.
vi.mock("node:dns/promises", () => ({
  default: { lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) },
}));

const { PluginArtifactStore } = await import("../PluginArtifactStore.js");
const { PluginArtifactService } = await import("../PluginArtifactService.js");
const { compileAllowedUrls } = await import("../pluginArtifactNetworkPolicy.js");

// Above the 4 MiB invoke and 16 MiB result budgets would be slow to fake for
// every case; 6 MiB already crosses the invoke budget and spans many chunks.
const LARGE = 6 * 1024 * 1024;
const CHUNK = 64 * 1024;

function synthetic(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

/** A body that hands out `bytes` in chunks, optionally failing after `failAfter` bytes. */
function body(
  bytes: Buffer,
  options: { failAfter?: number; onPull?: (sent: number) => void } = {}
) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      options.onPull?.(sent);
      if (options.failAfter !== undefined && sent >= options.failAfter) {
        controller.error(new TypeError("net::ERR_CONNECTION_RESET"));
        return;
      }
      if (sent >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, sent + CHUNK, options.failAfter ?? Infinity);
      controller.enqueue(new Uint8Array(bytes.subarray(sent, end)));
      sent = end;
    },
  });
}

let root: string;
let store: InstanceType<typeof PluginArtifactStore>;
let service: InstanceType<typeof PluginArtifactService>;
let netFetch: ReturnType<typeof vi.fn>;

const allowed = compileAllowedUrls(["https://api.example.com/v1"]);
const PLUGIN = "acme.media";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-service-"));
  store = new PluginArtifactStore({ rootDir: root });
  netFetch = vi.fn();
  service = new PluginArtifactService({
    store,
    netFetch: netFetch as never,
    sweepIntervalMs: 0,
    backoffMs: () => 1,
  });
});

afterEach(async () => {
  await service.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

async function leftovers(): Promise<string[]> {
  const out: string[] = [];
  for (const run of await fs.readdir(root)) {
    for (const entry of await fs.readdir(path.join(root, run))) out.push(entry);
  }
  return out;
}

function download(url: string, options: { signal?: AbortSignal; attempts?: number } = {}) {
  return service.download({
    pluginId: PLUGIN,
    projectId: null,
    url: new URL(url),
    headers: { authorization: "Bearer secret" },
    isAllowed: allowed,
    attempts: options.attempts ?? 3,
    signal: options.signal,
    onProgress: () => {},
  });
}

describe("import", () => {
  it("copies a large file into the cache through its descriptor", async () => {
    const source = path.join(root, "..", `src-${path.basename(root)}.mp4`);
    const bytes = synthetic(LARGE);
    await fs.writeFile(source, bytes);
    const handle = await fs.open(source);
    const progress: number[] = [];
    try {
      const artifact = await service.importFromHandle({
        pluginId: PLUGIN,
        projectId: null,
        handle,
        size: bytes.length,
        sourceName: "clip.mp4",
        onProgress: (p) => progress.push(p.transferredBytes),
      });
      expect(artifact).toMatchObject({ size: LARGE, mimeType: "video/mp4", name: "clip.mp4" });
      const opened = store.openForRead(PLUGIN, artifact.id)!;
      expect(Buffer.compare(await fs.readFile(opened.filePath), bytes)).toBe(0);
      opened.unpin();
      // Coalesced, and the last report is the whole file.
      expect(progress.length).toBeLessThan(LARGE / CHUNK);
      expect(progress.at(-1)).toBe(LARGE);
    } finally {
      await handle.close();
      await fs.rm(source, { force: true });
    }
  });

  it("leaves nothing behind when the copy is cancelled", async () => {
    const source = path.join(root, "..", `src-${path.basename(root)}.bin`);
    await fs.writeFile(source, synthetic(LARGE));
    const handle = await fs.open(source);
    const controller = new AbortController();
    try {
      const pending = service.importFromHandle({
        pluginId: PLUGIN,
        projectId: null,
        handle,
        size: LARGE,
        sourceName: "big.bin",
        signal: controller.signal,
        onProgress: () => controller.abort(),
      });
      await expect(pending).rejects.toMatchObject({ code: "ABORT_ERR" });
      expect(store.list(PLUGIN)).toEqual([]);
      expect(await leftovers()).toEqual([]);
      expect(store.usage()).toBe(0);
    } finally {
      await handle.close();
      await fs.rm(source, { force: true });
    }
  });
});

describe("download", () => {
  it("streams a large provider file and commits it only once complete", async () => {
    const bytes = synthetic(LARGE);
    netFetch.mockResolvedValueOnce(
      new Response(body(bytes), {
        status: 200,
        headers: { "content-length": String(LARGE), "content-type": "video/webm" },
      })
    );
    const artifact = await download("https://api.example.com/v1/files/clip.webm");
    expect(artifact).toMatchObject({ size: LARGE, mimeType: "video/webm", origin: "download" });
    const opened = store.openForRead(PLUGIN, artifact.id)!;
    expect(Buffer.compare(await fs.readFile(opened.filePath), bytes)).toBe(0);
    opened.unpin();
  });

  it("resumes a dropped body from where it stopped when the file is unchanged", async () => {
    const bytes = synthetic(LARGE);
    const cut = 2 * 1024 * 1024;
    const ranges: string[] = [];
    netFetch
      .mockResolvedValueOnce(
        new Response(body(bytes, { failAfter: cut }), {
          status: 200,
          headers: { "content-length": String(LARGE), etag: '"v1"' },
        })
      )
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        ranges.push(headers.range);
        expect(headers["if-range"]).toBe('"v1"');
        const from = Number(/^bytes=(\d+)-$/.exec(headers.range)![1]);
        return new Response(body(bytes.subarray(from)), {
          status: 206,
          headers: {
            "content-range": `bytes ${from}-${LARGE - 1}/${LARGE}`,
            "content-length": String(LARGE - from),
            etag: '"v1"',
          },
        });
      });
    const artifact = await download("https://api.example.com/v1/files/clip.mp4");
    expect(netFetch).toHaveBeenCalledTimes(2);
    // Resumed from bytes on disk: past the start, never past the cut.
    const from = Number(/^bytes=(\d+)-$/.exec(ranges[0]!)![1]);
    expect(from).toBeGreaterThan(0);
    expect(from).toBeLessThanOrEqual(cut);
    const opened = store.openForRead(PLUGIN, artifact.id)!;
    expect(Buffer.compare(await fs.readFile(opened.filePath), bytes)).toBe(0);
    opened.unpin();
  });

  it("starts over when a resumed range doesn't continue the file", async () => {
    const bytes = synthetic(1024 * 1024);
    const cut = 300_000;
    netFetch
      .mockResolvedValueOnce(
        new Response(body(bytes, { failAfter: cut }), {
          status: 200,
          headers: { "content-length": String(bytes.length), etag: '"v1"' },
        })
      )
      // Changed underneath: a different validator on the range.
      .mockResolvedValueOnce(
        new Response(body(bytes.subarray(cut)), {
          status: 206,
          headers: {
            "content-range": `bytes ${cut}-${bytes.length - 1}/${bytes.length}`,
            etag: '"v2"',
          },
        })
      )
      .mockResolvedValueOnce(
        new Response(body(bytes), {
          status: 200,
          headers: { "content-length": String(bytes.length), etag: '"v2"' },
        })
      );
    const artifact = await download("https://api.example.com/v1/files/a.bin");
    expect(netFetch).toHaveBeenCalledTimes(3);
    expect((netFetch.mock.calls[2]![1] as RequestInit).headers).not.toHaveProperty("range");
    const opened = store.openForRead(PLUGIN, artifact.id)!;
    expect(Buffer.compare(await fs.readFile(opened.filePath), bytes)).toBe(0);
    opened.unpin();
  });

  it("gives up after the attempts it was given and leaves no partial file", async () => {
    netFetch.mockImplementation(async () => new Response("busy", { status: 503 }));
    await expect(download("https://api.example.com/v1/x", { attempts: 2 })).rejects.toMatchObject({
      code: "ARTIFACT_TRANSFER_FAILED",
    });
    expect(netFetch).toHaveBeenCalledTimes(2);
    expect(await leftovers()).toEqual([]);
  });

  it("does not retry a verdict like 404", async () => {
    netFetch.mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(download("https://api.example.com/v1/x")).rejects.toMatchObject({
      code: "ARTIFACT_TRANSFER_FAILED",
    });
    expect(netFetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect out of the declared scope before connecting to it", async () => {
    netFetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://evil.example.net/x" } })
    );
    await expect(download("https://api.example.com/v1/x")).rejects.toMatchObject({
      code: "ARTIFACT_URL_NOT_ALLOWED",
    });
    expect(netFetch).toHaveBeenCalledTimes(1);
  });

  it("drops the plugin's headers on a hop that leaves the origin", async () => {
    const scoped = compileAllowedUrls(["https://api.example.com/v1", "https://cdn.example.com"]);
    netFetch
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://cdn.example.com/blob" } })
      )
      .mockResolvedValueOnce(
        new Response("ok", { status: 200, headers: { "content-length": "2" } })
      );
    await service.download({
      pluginId: PLUGIN,
      projectId: null,
      url: new URL("https://api.example.com/v1/x"),
      headers: { authorization: "Bearer secret" },
      isAllowed: scoped,
      attempts: 1,
    });
    const first = (netFetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    const second = (netFetch.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(first.authorization).toBe("Bearer secret");
    expect(second).not.toHaveProperty("authorization");
    for (const call of netFetch.mock.calls) {
      expect((call[1] as RequestInit).credentials).toBe("omit");
    }
  });

  it("cancels mid-body and leaves nothing behind", async () => {
    const controller = new AbortController();
    netFetch.mockResolvedValueOnce(
      new Response(
        body(synthetic(LARGE), { onPull: (sent) => sent > CHUNK * 4 && controller.abort() }),
        { status: 200, headers: { "content-length": String(LARGE) } }
      )
    );
    await expect(
      download("https://api.example.com/v1/x", { signal: controller.signal })
    ).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(await leftovers()).toEqual([]);
    expect(store.usage()).toBe(0);
  });

  it("fails a provider that sends more than it declared", async () => {
    netFetch.mockResolvedValueOnce(
      new Response(body(synthetic(1000)), { status: 200, headers: { "content-length": "10" } })
    );
    await expect(download("https://api.example.com/v1/x")).rejects.toMatchObject({
      code: "ARTIFACT_TRANSFER_FAILED",
    });
  });

  it("aborts a plugin's transfers when it is forgotten", async () => {
    let started!: () => void;
    const begun = new Promise<void>((resolve) => (started = resolve));
    netFetch.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          started();
          init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        })
    );
    const pending = download("https://api.example.com/v1/x");
    await begun;
    service.forgetPlugin(PLUGIN);
    await expect(pending).rejects.toMatchObject({ code: "ABORT_ERR" });
  });

  it("refuses a third concurrent transfer for one plugin", async () => {
    netFetch.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const a = download("https://api.example.com/v1/a", { signal: controller.signal });
    const b = download("https://api.example.com/v1/b", { signal: controller.signal });
    await expect(download("https://api.example.com/v1/c")).rejects.toMatchObject({
      code: "ARTIFACT_BUSY",
    });
    controller.abort();
    await Promise.allSettled([a, b]);
  });
});

describe("upload", () => {
  let server: http.Server;
  let received: { method?: string; length?: string; bytes: number };

  beforeEach(async () => {
    received = { bytes: 0 };
    server = http.createServer((req, res) => {
      received.method = req.method;
      received.length = req.headers["content-length"];
      req.on("data", (chunk: Buffer) => (received.bytes += chunk.length));
      req.on("end", () => {
        res.writeHead(201, { "content-type": "text/plain", "set-cookie": "s=1" });
        res.end("x".repeat(70 * 1024));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("streams the artifact with its length and caps the answer", async () => {
    const bytes = synthetic(LARGE);
    netFetch.mockResolvedValueOnce(
      new Response(body(bytes), { status: 200, headers: { "content-length": String(LARGE) } })
    );
    const artifact = await download("https://api.example.com/v1/clip.mp4");
    const { port } = server.address() as AddressInfo;
    const uploader = new PluginArtifactService({
      store,
      netFetch: netFetch as never,
      httpsRequest: http.request as never,
      sweepIntervalMs: 0,
    });
    const result = await uploader.upload({
      pluginId: PLUGIN,
      artifactId: artifact.id,
      url: new URL(`http://127.0.0.1:${port}/put`),
      method: "PUT",
      headers: {},
    });
    expect(received).toEqual({ method: "PUT", length: String(LARGE), bytes: LARGE });
    expect(result.status).toBe(201);
    expect(result.bodyTruncated).toBe(true);
    expect(result.body.length).toBe(64 * 1024);
    expect(result.headers).not.toHaveProperty("set-cookie");
  });

  it("rejects an artifact that has expired or been released", async () => {
    await expect(
      service.upload({
        pluginId: PLUGIN,
        artifactId: "0".repeat(32),
        url: new URL("https://api.example.com/v1/put"),
        method: "PUT",
        headers: {},
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
  });
});

describe("sources", () => {
  async function stored(mimeType: string): Promise<string> {
    netFetch.mockResolvedValueOnce(
      new Response("abcd", { status: 200, headers: { "content-length": "4" } })
    );
    const artifact = await service.download({
      pluginId: PLUGIN,
      projectId: null,
      url: new URL("https://api.example.com/v1/file"),
      headers: {},
      isAllowed: allowed,
      attempts: 1,
      mimeType,
    });
    return artifact.id;
  }

  it("mints a media URL for audio and video and an image URL for images", async () => {
    expect(service.mintSource(PLUGIN, await stored("video/mp4"), 1).url).toMatch(
      /^daintree-media:\/\/artifact\/[0-9a-f]{32}\?lease=[0-9a-f]{48}$/
    );
    expect(service.mintSource(PLUGIN, await stored("image/png"), 1).url).toMatch(
      /^daintree-file:\/\/artifact\//
    );
    expect(() => service.mintSource(PLUGIN, "f".repeat(32), 1)).toThrow(/ARTIFACT_NOT_FOUND/);
  });

  it("refuses a source for a type no element can play", async () => {
    const id = await stored("application/pdf");
    expect(() => service.mintSource(PLUGIN, id, 1)).toThrow(/ARTIFACT_SOURCE_UNSUPPORTED/);
    const svg = await stored("image/svg+xml");
    expect(() => service.mintSource(PLUGIN, svg, 1)).toThrow(/ARTIFACT_SOURCE_UNSUPPORTED/);
  });

  it("stops resolving a lease once its artifact is released", async () => {
    const id = await stored("audio/mpeg");
    const { url } = service.mintSource(PLUGIN, id, 9);
    const lease = new URL(url).searchParams.get("lease")!;
    const opened = service.openLeased(id, lease);
    expect(opened?.mimeType).toBe("audio/mpeg");
    opened!.unpin();
    store.release(PLUGIN, id);
    expect(service.openLeased(id, lease)).toBeNull();
  });
});
