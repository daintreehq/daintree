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
    ).toEqual({ hostId: "studio-01" });
    expect(
      parseHostScopedFileUrl(`daintree-media://host/studio-01/load/${query("/a", "/")}`)
    ).toEqual({ hostId: "studio-01" });
    expect(parseHostScopedFileUrl(`daintree-pdf://host/Mac.lan/load${query("/a", "/")}`)).toEqual({
      hostId: "Mac.lan",
    });
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
      ["daintree-file", `daintree-file://host/studio-01/load${query(file, dir)}`],
      ["daintree-media", `daintree-media://host/studio-01/load/${query(file, dir)}`],
      ["daintree-pdf", `daintree-pdf://host/studio-01/load${query(file, dir)}`],
    ] as const) {
      const response = await handlers.get(scheme)!(new Request(url));
      expect(await response.text()).toBe("host bytes");
      expect(proxy).toHaveBeenLastCalledWith(scheme, "studio-01", expect.any(Request));
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
