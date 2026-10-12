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

const {
  buildContainedFileUrl,
  parseHostScopedFileUrl,
  registerDaintreeFileProtocol,
  registerDaintreeMediaProtocol,
  registerDaintreePdfProtocol,
  serveContainedFileRequest,
  serveOpenedContainedFile,
  setHostFileRequestProxy,
} = await import("../protocols.js");

let dir: string;
let offProxy: (() => void) | null = null;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hs-proto-")));
  await fs.writeFile(path.join(dir, "note.txt"), "local bytes");
  registerDaintreeFileProtocol();
  registerDaintreeMediaProtocol();
  registerDaintreePdfProtocol();
});

afterEach(async () => {
  offProxy?.();
  offProxy = null;
  await fs.rm(dir, { recursive: true, force: true });
});

const CAP = "0123456789abcdef0123456789abcdef";

function query(filePath: string, root: string): string {
  return `?path=${encodeURIComponent(filePath)}&root=${encodeURIComponent(root)}`;
}

describe("parseHostScopedFileUrl", () => {
  it("leaves this machine's URLs alone", () => {
    expect(parseHostScopedFileUrl(`daintree-file://load${query("/a", "/")}`)).toBeNull();
    expect(parseHostScopedFileUrl(`daintree-media://load/${query("/a", "/")}`)).toBeNull();
    expect(parseHostScopedFileUrl(`daintree-file://${query("/a", "/")}`)).toBeNull();
  });

  it("reads the host from a host-scoped URL on every scheme", () => {
    expect(
      parseHostScopedFileUrl(`daintree-file://host/studio-01/load${query("/a", "/")}`)
    ).toEqual({ hostId: "studio-01", viewCapability: null });
    expect(
      parseHostScopedFileUrl(`daintree-media://host/studio-01/${CAP}/load/${query("/a", "/")}`)
    ).toEqual({ hostId: "studio-01", viewCapability: CAP });
    expect(
      parseHostScopedFileUrl(`daintree-pdf://host/Mac.lan/${CAP}/load${query("/a", "/")}`)
    ).toEqual({ hostId: "Mac.lan", viewCapability: CAP });
  });

  it("refuses a host-scoped URL it can't read rather than treating it as local", () => {
    expect(parseHostScopedFileUrl(`daintree-file://host/local/load${query("/a", "/")}`)).toBe(
      "malformed"
    );
    expect(parseHostScopedFileUrl(`daintree-file://host/a:b/load${query("/a", "/")}`)).toBe(
      "malformed"
    );
    expect(parseHostScopedFileUrl(`daintree-file://host/studio/other${query("/a", "/")}`)).toBe(
      "malformed"
    );
    expect(
      parseHostScopedFileUrl(`daintree-file://host/studio/NOT-A-CAP/load${query("/a", "/")}`)
    ).toBe("malformed");
  });
});

describe("host-scoped routing", () => {
  it("serves a local URL from this machine and never consults the proxy", async () => {
    const proxy = vi.fn();
    offProxy = setHostFileRequestProxy(proxy);
    const file = path.join(dir, "note.txt");
    const response = await handlers.get("daintree-file")!(
      new Request(`daintree-file://load${query(file, dir)}`)
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("local bytes");
    expect(proxy).not.toHaveBeenCalled();
  });

  it("hands a host URL to the proxy and never reads this machine's file at that path", async () => {
    const proxy = vi.fn(async () => new Response("host bytes", { status: 200 }));
    offProxy = setHostFileRequestProxy(proxy);
    const file = path.join(dir, "note.txt");
    for (const [scheme, url] of [
      ["daintree-file", `daintree-file://host/studio-01/${CAP}/load${query(file, dir)}`],
      ["daintree-media", `daintree-media://host/studio-01/${CAP}/load/${query(file, dir)}`],
      ["daintree-pdf", `daintree-pdf://host/studio-01/${CAP}/load${query(file, dir)}`],
    ] as const) {
      const response = await handlers.get(scheme)!(new Request(url));
      expect(await response.text()).toBe("host bytes");
      expect(proxy).toHaveBeenLastCalledWith(
        scheme,
        { hostId: "studio-01", viewCapability: CAP },
        expect.any(Request)
      );
    }
  });

  it("answers 503 for a host URL when no remote client is running", async () => {
    const file = path.join(dir, "note.txt");
    const response = await handlers.get("daintree-file")!(
      new Request(`daintree-file://host/studio-01/load${query(file, dir)}`)
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("local bytes");
  });

  it("answers 400 for a malformed host URL", async () => {
    offProxy = setHostFileRequestProxy(vi.fn());
    const response = await handlers.get("daintree-pdf")!(
      new Request(`daintree-pdf://host/local/load${query("/a.pdf", "/")}`)
    );
    expect(response.status).toBe(400);
  });

  it("adds the CORS grant for the trusted app origin on proxied responses", async () => {
    offProxy = setHostFileRequestProxy(async () => new Response("x", { status: 200 }));
    const response = await handlers.get("daintree-file")!(
      new Request(`daintree-file://host/studio-01/load${query("/a", "/")}`, {
        headers: { origin: "app://daintree" },
      })
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("app://daintree");
  });
});

describe("serveContainedFileRequest", () => {
  it("builds the same local URL shape the renderer builds", () => {
    expect(buildContainedFileUrl("daintree-file", "/a b", "/")).toBe(
      "daintree-file://load?path=%2Fa%20b&root=%2F"
    );
    expect(buildContainedFileUrl("daintree-media", "/a", "/")).toBe(
      "daintree-media://load/?path=%2Fa&root=%2F"
    );
  });

  it("answers with the local handler's own containment", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hs-out-"));
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "secret");
      await fs.symlink(path.join(outside, "secret.txt"), path.join(dir, "link.txt"));
      const inside = await serveContainedFileRequest(
        "daintree-file",
        new Request(buildContainedFileUrl("daintree-file", path.join(dir, "note.txt"), dir))
      );
      expect(await inside.text()).toBe("local bytes");
      const escaped = await serveContainedFileRequest(
        "daintree-file",
        new Request(buildContainedFileUrl("daintree-file", path.join(dir, "link.txt"), dir))
      );
      expect(escaped.status).toBe(404);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("serveOpenedContainedFile", () => {
  async function serve(
    scheme: "daintree-file" | "daintree-media" | "daintree-pdf",
    name: string,
    init: RequestInit = {},
    admitBuffered?: (bytes: number) => boolean
  ) {
    const file = path.join(dir, name);
    const handle = await fs.open(file, "r");
    const close = vi.spyOn(handle, "close");
    const response = await serveOpenedContainedFile(
      scheme,
      handle,
      file,
      new Request(`${scheme}://load?path=x&root=y`, init),
      admitBuffered
    );
    return { response, close };
  }

  it("serves a buffered file from the descriptor with the local headers", async () => {
    const { response, close } = await serve("daintree-file", "note.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(await response.text()).toBe("local bytes");
    expect(close).toHaveBeenCalled();
  });

  it("answers HEAD from the descriptor's size without reading or reserving", async () => {
    const admit = vi.fn(() => true);
    const { response } = await serve("daintree-file", "note.txt", { method: "HEAD" }, admit);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String("local bytes".length));
    expect(admit).not.toHaveBeenCalled();
  });

  it("asks for the buffered bytes before reading and answers 503 when refused", async () => {
    const admit = vi.fn(() => false);
    const { response, close } = await serve("daintree-file", "note.txt", {}, admit);
    expect(admit).toHaveBeenCalledWith("local bytes".length);
    expect(response.status).toBe(503);
    expect(close).toHaveBeenCalled();
  });

  it("refuses an oversized file on its size, before reading", async () => {
    await fs.writeFile(path.join(dir, "big.txt"), Buffer.alloc(512 * 1024 + 1));
    const admit = vi.fn(() => true);
    const { response } = await serve("daintree-file", "big.txt", {}, admit);
    expect(response.status).toBe(413);
    expect(admit).not.toHaveBeenCalled();
  });

  it("keeps the PDF and media gates", async () => {
    expect((await serve("daintree-pdf", "note.txt")).response.status).toBe(415);
    expect((await serve("daintree-media", "note.txt")).response.status).toBe(404);
  });

  it("streams media ranges from the descriptor", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("0123456789"));
    const { response } = await serve("daintree-media", "clip.mp4", {
      headers: { range: "bytes=2-5" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await response.text()).toBe("2345");
  });
});
