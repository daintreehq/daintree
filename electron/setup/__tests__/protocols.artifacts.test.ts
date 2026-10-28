import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (request: Request) => Promise<Response>>());

vi.mock("electron", () => ({
  app: { isPackaged: true, on: vi.fn(), getPath: vi.fn(() => os.tmpdir()) },
  protocol: {
    handle: vi.fn((scheme: string, handler: (request: Request) => Promise<Response>) => {
      handlers.set(scheme, handler);
    }),
  },
  session: { fromPartition: vi.fn() },
  shell: { openExternal: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

const { registerDaintreeFileProtocol, registerDaintreeMediaProtocol } =
  await import("../protocols.js");
const { setArtifactSourceResolver } = await import("../artifactSourceResolver.js");

const ID = "0123456789abcdef0123456789abcdef";
const LEASE = "ab".repeat(24);
const SIZE = 200_000;

let dir: string;
let file: string;
let mimeType: string;
let unpins: number;

function media(init?: RequestInit, id = ID, lease = LEASE): Promise<Response> {
  return handlers.get("daintree-media")!(
    new Request(`daintree-media://artifact/${id}?lease=${lease}`, init)
  );
}

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "artifact-proto-")));
  file = path.join(dir, "payload");
  const bytes = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) bytes[i] = i & 0xff;
  await fs.writeFile(file, bytes);
  mimeType = "video/mp4";
  unpins = 0;
  setArtifactSourceResolver((artifactId, lease) =>
    artifactId === ID && lease === LEASE
      ? { filePath: file, mimeType, unpin: () => unpins++ }
      : null
  );
  registerDaintreeFileProtocol();
  registerDaintreeMediaProtocol();
});

afterEach(async () => {
  setArtifactSourceResolver(null);
  await fs.rm(dir, { recursive: true, force: true });
});

describe("artifact playback route", () => {
  it("streams the whole artifact and releases its pin when the body ends", async () => {
    const response = await media();
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe(String(SIZE));
    expect((await response.arrayBuffer()).byteLength).toBe(SIZE);
    await expect.poll(() => unpins).toBe(1);
  });

  it("answers a range with exactly the bytes asked for", async () => {
    const response = await media({ headers: { range: "bytes=1000-1999" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 1000-1999/${SIZE}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBe(1000);
    expect(bytes[0]).toBe(1000 & 0xff);
  });

  it("answers HEAD from the descriptor without a body", async () => {
    const response = await media({ method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(SIZE));
    expect(response.body).toBeNull();
    await expect.poll(() => unpins).toBe(1);
  });

  it("refuses an unsatisfiable range with the size", async () => {
    const response = await media({ headers: { range: `bytes=${SIZE}-` } });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${SIZE}`);
  });

  it("404s a wrong, malformed or expired lease, and never reads the query's path", async () => {
    expect((await media(undefined, ID, "cd".repeat(24))).status).toBe(404);
    expect((await media(undefined, ID, "short")).status).toBe(404);
    expect((await media(undefined, "not-an-id")).status).toBe(404);
    const smuggled = await handlers.get("daintree-media")!(
      new Request(
        `daintree-media://artifact/${ID}?lease=${"cd".repeat(24)}&path=${encodeURIComponent(file)}&root=${encodeURIComponent(dir)}`
      )
    );
    expect(smuggled.status).toBe(404);
    setArtifactSourceResolver(null);
    expect((await media()).status).toBe(404);
  });

  it("404s an artifact whose file went missing or became a symlink", async () => {
    await fs.rm(file);
    expect((await media()).status).toBe(404);
    await fs.writeFile(path.join(dir, "elsewhere"), "secret");
    await fs.symlink(path.join(dir, "elsewhere"), file);
    if (process.platform !== "win32") expect((await media()).status).toBe(404);
    expect(unpins).toBeGreaterThanOrEqual(1);
  });

  it("keeps each scheme to its kind: media on daintree-media, images on daintree-file", async () => {
    mimeType = "image/png";
    expect((await media()).status).toBe(404);
    const image = await handlers.get("daintree-file")!(
      new Request(`daintree-file://artifact/${ID}?lease=${LEASE}`)
    );
    expect(image.status).toBe(200);
    expect(image.headers.get("content-security-policy")).toContain("sandbox");
    mimeType = "image/svg+xml";
    const svg = await handlers.get("daintree-file")!(
      new Request(`daintree-file://artifact/${ID}?lease=${LEASE}`)
    );
    expect(svg.status).toBe(404);
    mimeType = "video/mp4";
    const video = await handlers.get("daintree-file")!(
      new Request(`daintree-file://artifact/${ID}?lease=${LEASE}`)
    );
    expect(video.status).toBe(404);
  });

  it("refuses anything but GET and HEAD", async () => {
    expect((await media({ method: "POST", body: "x" })).status).toBe(405);
  });
});
