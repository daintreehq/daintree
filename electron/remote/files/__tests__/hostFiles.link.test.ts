import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, on: vi.fn(), getPath: vi.fn(() => os.tmpdir()) },
  protocol: { handle: vi.fn() },
  session: { fromPartition: vi.fn() },
  shell: { openExternal: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

import { AppError } from "../../../utils/errorTypes.js";
import type { LinkSession } from "../../link/session.js";
import {
  makeTempDir,
  openSessionPair,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import { ClientFileTransport } from "../ClientFileTransport.js";
import { createHostFileProxy } from "../hostFileProxy.js";
import { serveOpenedContainedFile } from "../../../setup/protocols.js";
import { HostFileService, type HostFileEndpoint } from "../HostFileService.js";
import { DOWNLOAD_SINK_PREFIX, FileDownloadPayloadSchema, FileLinkMethod } from "../linkMethods.js";
import { ViewFileCapabilities } from "../viewCapabilities.js";
import { expectClientBundle } from "../../projects/bundleSinks.js";
import { BUNDLE_SINK_PREFIX } from "../../projects/linkMethods.js";

const HOST = "studio-01";

let socketDir: string;
let project: string;
let outside: string;
let other: string;
let downloads: string;
const sessions: LinkSession[] = [];
const services: HostFileService[] = [];

class FakeEndpoint implements HostFileEndpoint {
  readonly endpointId: string;
  readonly clientEndpointId: string;
  readonly clientId = "client-a";
  projectId: string | null;
  private closed = false;
  constructor(view = 7, projectId: string | null = "p1") {
    this.endpointId = `session-1:view-${view}`;
    this.clientEndpointId = `view-${view}`;
    this.projectId = projectId;
  }
  private readonly listeners = new Set<() => void>();
  isClosed() {
    return this.closed;
  }
  onClose(cb: () => void) {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }
  close() {
    this.closed = true;
    for (const cb of [...this.listeners]) cb();
  }
}

beforeEach(async () => {
  socketDir = await makeTempDir();
  project = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hf-proj-")));
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hf-out-")));
  other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hf-other-")));
  downloads = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hf-dl-")));
});

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  for (const session of sessions.splice(0)) session.close("test done");
  await removeTempDir(socketDir);
  for (const dir of [project, outside, other, downloads])
    await fs.rm(dir, { recursive: true, force: true });
});

async function setup(
  options: {
    driving?: () => boolean;
    hostPulls?: number;
    clientPulls?: number;
    serve?: typeof serveOpenedContainedFile;
    maxRequestsPerSession?: number;
    maxBufferedBytes?: number;
    maxDownloadsPerSession?: number;
    bundleTtlMs?: number;
    /** Project p1's roots as configured; the real project folder by default. */
    roots?: string[];
  } = {}
) {
  const { host, client } = await openSessionPair(socketDir);
  sessions.push(host, client);
  const endpoint = new FakeEndpoint();
  const service = new HostFileService({
    rootsFor: async (projectId) =>
      projectId === "p1" ? (options.roots ?? [project]) : projectId === "p2" ? [other] : [],
    serve: options.serve,
    isDriving: (_projectId, asking) => (asking === endpoint ? (options.driving?.() ?? true) : true),
    maxConcurrentPulls: options.hostPulls,
    maxRequestsPerSession: options.maxRequestsPerSession,
    maxBufferedBytes: options.maxBufferedBytes,
    maxDownloadsPerSession: options.maxDownloadsPerSession,
    bundleTtlMs: options.bundleTtlMs,
  });
  services.push(service);
  service.attach(host, endpoint);
  const transport = new ClientFileTransport({ maxConcurrentPulls: options.clientPulls });
  transport.noteEndpointOpened(HOST, { session: client, webContentsId: 7, endpointId: "view-7" });
  const capabilities = new ViewFileCapabilities(() => () => {});
  const cap = capabilities.capabilityFor(7);
  const views = { viewForCapability: (token: string) => capabilities.viewFor(token) };
  const rawProxy = createHostFileProxy(transport, { ...views, hostForView: () => HOST });
  // Previews as view 7 builds them: its own capability in the URL.
  const proxy = (scheme: Parameters<typeof rawProxy>[0], request: Request) =>
    rawProxy(scheme, { hostId: HOST, viewCapability: cap }, request);
  /** A second view on the same host, attached to project p2. */
  const secondView = () => {
    const second = new FakeEndpoint(8, "p2");
    service.attach(host, second);
    transport.noteEndpointOpened(HOST, { session: client, webContentsId: 8, endpointId: "view-8" });
    return { endpoint: second, cap: capabilities.capabilityFor(8) };
  };
  return { host, client, endpoint, service, transport, proxy, rawProxy, cap, secondView };
}

function url(scheme: string, filePath: string, root: string): string {
  const query = `?path=${encodeURIComponent(filePath)}&root=${encodeURIComponent(root)}`;
  return scheme === "daintree-media"
    ? `${scheme}://host/${HOST}/load/${query}`
    : `${scheme}://host/${HOST}/load${query}`;
}

async function expectEventuallyEmpty(dir: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let names = await fs.readdir(dir);
  while (names.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    names = await fs.readdir(dir);
  }
  expect(names).toEqual([]);
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

describe("previews over the link", () => {
  it("serves a project file from the host", async () => {
    const { proxy } = await setup();
    await fs.writeFile(path.join(project, "a.png"), "hello from the host");
    const response = await proxy(
      "daintree-file",
      new Request(url("daintree-file", path.join(project, "a.png"), project))
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(await response.text()).toBe("hello from the host");
  });

  it("refuses paths the host's own handler refuses: outside root, symlink escape, NUL", async () => {
    const { proxy } = await setup();
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(project, "escape.txt"));

    const outsideRoot = await proxy(
      "daintree-file",
      new Request(url("daintree-file", path.join(outside, "secret.txt"), project))
    );
    expect(outsideRoot.status).toBe(404);

    const symlinkEscape = await proxy(
      "daintree-file",
      new Request(url("daintree-file", path.join(project, "escape.txt"), project))
    );
    expect(symlinkEscape.status).toBe(404);

    const nul = await proxy(
      "daintree-file",
      new Request(url("daintree-file", `${project}/a\0.txt`, project))
    );
    expect(nul.status).toBe(400);
    for (const response of [outsideRoot, symlinkEscape, nul]) {
      expect(await response.text()).not.toContain("secret");
    }
  });

  it("binds the root to the endpoint's project instead of trusting the caller", async () => {
    const { proxy } = await setup();
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    const response = await proxy(
      "daintree-file",
      new Request(url("daintree-file", path.join(outside, "secret.txt"), outside))
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("secret");
  });

  it("answers media ranges with 206 and unsatisfiable ones with 416", async () => {
    const { proxy } = await setup();
    const video = crypto.randomBytes(3 * 1024 * 1024 + 123);
    const file = path.join(project, "clip.mp4");
    await fs.writeFile(file, video);

    const head = await proxy(
      "daintree-media",
      new Request(url("daintree-media", file, project), { method: "HEAD" })
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("accept-ranges")).toBe("bytes");
    expect(Number(head.headers.get("content-length"))).toBe(video.byteLength);
    expect(head.body).toBeNull();

    const ranged = await proxy(
      "daintree-media",
      new Request(url("daintree-media", file, project), { headers: { range: "bytes=100-2500099" } })
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 100-2500099/${video.byteLength}`);
    const body = new Uint8Array(await ranged.arrayBuffer());
    expect(body.byteLength).toBe(2_500_000);
    expect(sha256(body)).toBe(sha256(video.subarray(100, 2_500_100)));

    const tail = await proxy(
      "daintree-media",
      new Request(url("daintree-media", file, project), { headers: { range: "bytes=-10" } })
    );
    expect(tail.status).toBe(206);
    expect(Buffer.from(await tail.arrayBuffer()).equals(video.subarray(-10))).toBe(true);

    const unsatisfiable = await proxy(
      "daintree-media",
      new Request(url("daintree-media", file, project), {
        headers: { range: `bytes=${video.byteLength + 5}-` },
      })
    );
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${video.byteLength}`);
  });

  it("streams a whole media file as 200 in verified slices", async () => {
    const { proxy } = await setup();
    const audio = crypto.randomBytes(2 * 1024 * 1024 + 7);
    await fs.writeFile(path.join(project, "talk.mp3"), audio);
    const response = await proxy(
      "daintree-file",
      new Request(url("daintree-file", path.join(project, "talk.mp3"), project))
    );
    expect(response.status).toBe(200);
    expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(sha256(audio));
  });

  it("keeps the PDF gate: a non-PDF under a .pdf request is refused", async () => {
    const { proxy } = await setup();
    await fs.writeFile(path.join(project, "notes.txt"), "not a pdf");
    const response = await proxy(
      "daintree-pdf",
      new Request(url("daintree-pdf", path.join(project, "notes.txt"), project))
    );
    expect(response.status).toBe(415);
  });

  it("answers 403 to a window that doesn't drive the project", async () => {
    const { proxy } = await setup({ driving: () => false });
    await fs.writeFile(path.join(project, "a.txt"), "x");
    const response = await proxy(
      "daintree-file",
      new Request(url("daintree-file", path.join(project, "a.txt"), project))
    );
    expect(response.status).toBe(403);
  });

  it("bounds concurrent reads on the host and queues them on the Shell", async () => {
    const files = await Promise.all(
      [0, 1, 2].map(async (index) => {
        const bytes = crypto.randomBytes(1024 * 1024 + index);
        const file = path.join(project, `v${index}.mp4`);
        await fs.writeFile(file, bytes);
        return { file, bytes };
      })
    );
    const { proxy, transport } = await setup({ hostPulls: 1, clientPulls: 1 });
    const pull = vi.spyOn(transport, "pull");
    const bodies = await Promise.all(
      files.map(async ({ file }) => {
        const response = await proxy(
          "daintree-media",
          new Request(url("daintree-media", file, project))
        );
        return new Uint8Array(await response.arrayBuffer());
      })
    );
    bodies.forEach((body, index) => expect(sha256(body)).toBe(sha256(files[index]!.bytes)));
    expect(pull).toHaveBeenCalled();
  });

  it("refuses reads beyond the host's concurrency bound", async () => {
    const files = await Promise.all(
      [0, 1, 2, 3].map(async (index) => {
        const file = path.join(project, `w${index}.mp4`);
        await fs.writeFile(file, crypto.randomBytes(2 * 1024 * 1024));
        return file;
      })
    );
    const { proxy } = await setup({ hostPulls: 1, clientPulls: 4 });
    const outcomes = await Promise.allSettled(
      files.map(async (file) => {
        const response = await proxy(
          "daintree-media",
          new Request(url("daintree-media", file, project))
        );
        return response.arrayBuffer();
      })
    );
    expect(outcomes.some((outcome) => outcome.status === "rejected")).toBe(true);
  });
});

describe("revocation", () => {
  async function openStream() {
    const ctx = await setup();
    const file = path.join(project, "long.mp4");
    await fs.writeFile(file, crypto.randomBytes(3 * 1024 * 1024));
    const response = await ctx.proxy(
      "daintree-media",
      new Request(url("daintree-media", file, project))
    );
    expect(response.status).toBe(200);
    expect(ctx.service.openStreams).toBe(1);
    return { ...ctx, response };
  }

  it("closes a stream when its endpoint moves to another project", async () => {
    const { endpoint, service, response } = await openStream();
    endpoint.projectId = "p2";
    service.onEndpointsChanged();
    expect(service.openStreams).toBe(0);
    await expect(response.arrayBuffer()).rejects.toBeDefined();
  });

  it("closes a stream when the project closes under the endpoint", async () => {
    const { endpoint, service } = await openStream();
    endpoint.projectId = null;
    service.onEndpointsChanged();
    expect(service.openStreams).toBe(0);
  });

  it("closes a stream when the drive lease moves away from the endpoint", async () => {
    let driving = true;
    const ctx = await setup({ driving: () => driving });
    const file = path.join(project, "long.mp4");
    await fs.writeFile(file, crypto.randomBytes(3 * 1024 * 1024));
    const response = await ctx.proxy(
      "daintree-media",
      new Request(url("daintree-media", file, project))
    );
    expect(ctx.service.openStreams).toBe(1);
    ctx.service.onLeaseChanged("other-project");
    expect(ctx.service.openStreams).toBe(1);
    driving = false;
    ctx.service.onLeaseChanged("p1");
    expect(ctx.service.openStreams).toBe(0);
    await expect(response.arrayBuffer()).rejects.toBeDefined();
  });

  it("refuses a preview whose endpoint moved while the host was answering", async () => {
    let endpointRef: FakeEndpoint | null = null;
    const ctx = await setup({
      serve: async (...args) => {
        endpointRef!.projectId = "p2";
        return serveOpenedContainedFile(...args);
      },
    });
    endpointRef = ctx.endpoint;
    const file = path.join(project, "long.mp4");
    await fs.writeFile(file, crypto.randomBytes(1024));
    const response = await ctx.proxy(
      "daintree-media",
      new Request(url("daintree-media", file, project))
    );
    expect(response.status).toBe(403);
    expect(ctx.service.openStreams).toBe(0);
  });

  it("closes a stream when its endpoint closes", async () => {
    const { endpoint, service } = await openStream();
    endpoint.close();
    expect(service.openStreams).toBe(0);
  });

  it("closes a stream the Shell stops reading", async () => {
    const { service, response } = await openStream();
    await response.body!.cancel();
    await waitFor(() => service.openStreams === 0);
  });
});

describe("save locally", () => {
  it("downloads a host file here, verified by sha256, without overwriting", async () => {
    const { transport } = await setup();
    const bytes = crypto.randomBytes(700 * 1024 + 3);
    await fs.writeFile(path.join(project, "report.bin"), bytes);
    const progress: number[] = [];

    const first = await transport.download(HOST, path.join(project, "report.bin"), {
      webContentsId: 7,
      destinationDir: downloads,
      onProgress: (received) => progress.push(received),
    });
    expect(path.dirname(first.localPath)).toBe(downloads);
    expect(path.basename(first.localPath)).toBe("report.bin");
    expect(sha256(await fs.readFile(first.localPath))).toBe(sha256(bytes));
    expect(progress.at(-1)).toBe(bytes.byteLength);

    const second = await transport.download(HOST, path.join(project, "report.bin"), {
      webContentsId: 7,
      destinationDir: downloads,
    });
    expect(path.basename(second.localPath)).toBe("report (1).bin");
    expect((await fs.readdir(downloads)).sort()).toEqual(["report (1).bin", "report.bin"]);
  });

  it("refuses a file outside the project and leaves nothing behind", async () => {
    const { transport } = await setup();
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await expect(
      transport.download(HOST, path.join(outside, "secret.txt"), {
        webContentsId: 7,
        destinationDir: downloads,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await fs.readdir(downloads)).toEqual([]);
  });

  it("discards a download whose bytes don't match the announced sha256", async () => {
    const { host, client } = await openSessionPair(socketDir);
    sessions.push(host, client);
    host.registerCallHandler(FileLinkMethod.DOWNLOAD, FileDownloadPayloadSchema, ({ token }) => {
      const bytes = new Uint8Array(4096).fill(7);
      void host.transfers
        .send(
          {
            size: bytes.byteLength,
            sha256: "0".repeat(64),
            read: async (o, l) => bytes.subarray(o, o + l),
          },
          {
            name: "tampered.bin",
            destination: { kind: "path", path: `${DOWNLOAD_SINK_PREFIX}${token}` },
          }
        )
        .catch(() => {});
      return { name: "tampered.bin", size: bytes.byteLength };
    });
    const transport = new ClientFileTransport();
    transport.noteEndpointOpened(HOST, { session: client, webContentsId: 7, endpointId: "view-7" });

    await expect(
      transport.download(HOST, "/anything", { webContentsId: 7, destinationDir: downloads })
    ).rejects.toBeInstanceOf(AppError);
    await expectEventuallyEmpty(downloads);
  });

  it("refuses a transfer to a destination it never asked for", async () => {
    const { host, client } = await setup();
    const sent = host.transfers.send(
      { size: 4, sha256: sha256(new Uint8Array(4)), read: async () => new Uint8Array(4) },
      {
        name: "unsolicited",
        destination: { kind: "path", path: `${DOWNLOAD_SINK_PREFIX}${"a".repeat(32)}` },
      }
    );
    await expect(sent).rejects.toBeDefined();
    expect(client.isOpen).toBe(true);
    expect(await fs.readdir(downloads)).toEqual([]);
  });

  it("accepts a repository bundle the Shell asked for, once, beside its own downloads", async () => {
    const { host } = await setup();
    const token = crypto.randomBytes(16).toString("hex");
    const target = path.join(downloads, "repository.bundle");
    const release = expectClientBundle(token, target);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const send = () =>
      host.transfers.send(
        {
          size: bytes.byteLength,
          sha256: sha256(bytes),
          read: async (o, l) => bytes.subarray(o, o + l),
        },
        {
          name: "repository.bundle",
          destination: { kind: "path", path: `${BUNDLE_SINK_PREFIX}${token}` },
        }
      );
    await send();
    expect(await fs.readFile(target)).toEqual(Buffer.from(bytes));
    // The slot is spent: a second bundle for it is refused.
    await expect(send()).rejects.toBeDefined();
    release();
  });

  it("fails, rather than hangs, when the download can't be saved here", async () => {
    const { transport } = await setup();
    await fs.writeFile(path.join(project, "report.bin"), "x");
    const blocked = path.join(downloads, "not-a-dir");
    await fs.writeFile(blocked, "");
    await expect(
      transport.download(HOST, path.join(project, "report.bin"), {
        webContentsId: 7,
        destinationDir: blocked,
      })
    ).rejects.toBeInstanceOf(AppError);
  });

  it("cancels a download and removes the partial file", async () => {
    const { transport } = await setup();
    await fs.writeFile(path.join(project, "big.bin"), crypto.randomBytes(8 * 1024 * 1024));
    const controller = new AbortController();
    const pending = transport.download(HOST, path.join(project, "big.bin"), {
      webContentsId: 7,
      destinationDir: downloads,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await expectEventuallyEmpty(downloads);
  });
});

describe("roots a remote view may name to the host's file readers", () => {
  it("holds the project's folder and folders in it, and nothing outside", async () => {
    const { service } = await setup();
    await fs.mkdir(path.join(project, "src"));
    await fs.symlink(outside, path.join(project, "escape"));

    await expect(service.holdsRoot("p1", project)).resolves.toBe(true);
    await expect(service.holdsRoot("p1", path.join(project, "src"))).resolves.toBe(true);
    await expect(service.holdsRoot("p1", outside)).resolves.toBe(false);
    await expect(service.holdsRoot("p1", path.join(project, "escape"))).resolves.toBe(false);
    await expect(service.holdsRoot("p1", path.join(project, "missing"))).resolves.toBe(false);
    await expect(service.holdsRoot("p2", project)).resolves.toBe(false);

    service.dispose();
    await expect(service.holdsRoot("p1", project)).resolves.toBe(false);
  });
});

describe("a file call runs under the asking view's own endpoint", () => {
  it("never lends one view's project to another view on the same host", async () => {
    const { rawProxy, transport, secondView } = await setup();
    const { cap: secondCap } = secondView();
    await fs.writeFile(path.join(project, "p1-only.txt"), "p1 secret");
    await fs.writeFile(path.join(other, "p2.txt"), "p2 file");

    const asSecond = (filePath: string, root: string) =>
      rawProxy(
        "daintree-file",
        { hostId: HOST, viewCapability: secondCap },
        new Request(url("daintree-file", filePath, root))
      );
    const borrowed = await asSecond(path.join(project, "p1-only.txt"), project);
    expect(borrowed.status).toBe(404);
    expect(await borrowed.text()).not.toContain("p1 secret");
    const own = await asSecond(path.join(other, "p2.txt"), other);
    expect(await own.text()).toBe("p2 file");

    await expect(
      transport.download(HOST, path.join(project, "p1-only.txt"), {
        webContentsId: 8,
        destinationDir: downloads,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await fs.readdir(downloads)).toEqual([]);
  });

  it("refuses a preview URL without a live view's capability", async () => {
    const { rawProxy } = await setup();
    await fs.writeFile(path.join(project, "a.txt"), "x");
    const request = () => new Request(url("daintree-file", path.join(project, "a.txt"), project));
    for (const viewCapability of [null, "f".repeat(32)]) {
      const response = await rawProxy("daintree-file", { hostId: HOST, viewCapability }, request());
      expect(response.status).toBe(403);
    }
  });

  it("refuses a capability used against a host its view isn't bound to", async () => {
    const { transport, cap } = await setup();
    const capabilities = { viewForCapability: (token: string) => (token === cap ? 7 : null) };
    const proxy = createHostFileProxy(transport, { ...capabilities, hostForView: () => "other" });
    const response = await proxy(
      "daintree-file",
      { hostId: HOST, viewCapability: cap },
      new Request(url("daintree-file", path.join(project, "a.txt"), project))
    );
    expect(response.status).toBe(403);
  });

  it("fails a view with no endpoint on the host instead of borrowing one", async () => {
    const { transport } = await setup();
    await fs.writeFile(path.join(project, "a.txt"), "x");
    await expect(
      transport.download(HOST, path.join(project, "a.txt"), {
        webContentsId: 99,
        destinationDir: downloads,
      })
    ).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
  });
});

describe("containment on the host resolves symlinks only inside the root", () => {
  async function read(
    proxy: Awaited<ReturnType<typeof setup>>["proxy"],
    filePath: string,
    root = project
  ) {
    return proxy("daintree-file", new Request(url("daintree-file", filePath, root)));
  }

  it("serves through links that stay inside the project and refuses ones that leave it", async () => {
    const { proxy } = await setup();
    await fs.mkdir(path.join(project, "real"));
    await fs.writeFile(path.join(project, "real", "a.txt"), "inside");
    await fs.symlink(path.join(project, "real"), path.join(project, "alias"));
    await fs.writeFile(path.join(outside, "a.txt"), "secret");
    await fs.symlink(outside, path.join(project, "escape"));

    expect(await (await read(proxy, path.join(project, "real", "a.txt"))).text()).toBe("inside");
    expect(await (await read(proxy, path.join(project, "alias", "a.txt"))).text()).toBe("inside");
    for (const [filePath, root] of [
      [path.join(project, "escape", "a.txt"), project],
      [path.join(project, "escape", "a.txt"), path.join(project, "escape")],
      [path.join(project, "real", "..", "..", path.basename(outside), "a.txt"), project],
    ] as const) {
      const response = await read(proxy, filePath, root);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("secret");
    }
  });

  it("follows pnpm-style relative links and link chains that end inside the project", async () => {
    const { proxy, transport } = await setup();
    const store = path.join(project, "node_modules", ".pnpm", "pkg@1.0.0", "node_modules", "pkg");
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(store, "index.js"), "module.exports = 1;");
    await fs.symlink(".pnpm/pkg@1.0.0/node_modules/pkg", path.join(project, "node_modules", "pkg"));
    await fs.symlink("node_modules/pkg", path.join(project, "pkg-link"));
    await fs.symlink("index.js", path.join(store, "main.js"));

    for (const filePath of [
      path.join(project, "node_modules", "pkg", "index.js"),
      path.join(project, "pkg-link", "index.js"),
      path.join(project, "pkg-link", "main.js"),
    ]) {
      expect(await (await read(proxy, filePath)).text()).toBe("module.exports = 1;");
    }
    const result = await transport.download(HOST, path.join(project, "pkg-link", "main.js"), {
      webContentsId: 7,
      destinationDir: downloads,
    });
    expect(await fs.readFile(result.localPath, "utf8")).toBe("module.exports = 1;");
  });

  it("refuses a relative link that climbs out, even one that points back in", async () => {
    const { proxy } = await setup();
    await fs.writeFile(path.join(outside, "a.txt"), "secret");
    await fs.mkdir(path.join(project, "sub"));
    await fs.symlink(`../../${path.basename(outside)}/a.txt`, path.join(project, "sub", "up.txt"));
    await fs.writeFile(path.join(project, "inside.txt"), "inside");
    await fs.symlink(path.join(project, "inside.txt"), path.join(outside, "back.txt"));
    await fs.symlink(path.join(outside, "back.txt"), path.join(project, "round-trip.txt"));

    for (const filePath of [
      path.join(project, "sub", "up.txt"),
      path.join(project, "round-trip.txt"),
    ]) {
      const response = await read(proxy, filePath);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("secret");
    }
  });

  it("refuses a link loop instead of walking it forever", async () => {
    const { proxy } = await setup();
    await fs.symlink("b", path.join(project, "a"));
    await fs.symlink("a", path.join(project, "b"));
    await fs.symlink("self", path.join(project, "self"));
    for (const name of ["a", "self"]) {
      expect((await read(proxy, path.join(project, name, "x.txt"))).status).toBe(404);
      expect((await read(proxy, path.join(project, name))).status).toBe(404);
    }
  });

  it("accepts an absolute link written against the root's configured spelling", async () => {
    const spelled = path.join(outside, "project-alias");
    await fs.symlink(project, spelled);
    await fs.mkdir(path.join(project, "real"));
    await fs.writeFile(path.join(project, "real", "a.txt"), "inside");
    await fs.symlink(path.join(spelled, "real"), path.join(project, "via-spelling"));
    const { proxy } = await setup({ roots: [spelled] });
    expect(
      await (await read(proxy, path.join(spelled, "via-spelling", "a.txt"), spelled)).text()
    ).toBe("inside");
  });

  it("serves the file it opened even when a link it resolved is retargeted outside after admission", async () => {
    await fs.mkdir(path.join(project, "real"));
    await fs.writeFile(path.join(project, "real", "a.txt"), "original");
    await fs.writeFile(path.join(outside, "a.txt"), "secret");
    await fs.symlink(path.join(project, "real"), path.join(project, "alias"));
    const { proxy } = await setup({
      serve: async (...args) => {
        await fs.rm(path.join(project, "alias"));
        await fs.symlink(outside, path.join(project, "alias"));
        return serveOpenedContainedFile(...args);
      },
    });
    const response = await read(proxy, path.join(project, "alias", "a.txt"));
    expect(await response.text()).toBe("original");
  });

  it("serves the file it opened even when its folder is swapped for a symlink after admission", async () => {
    await fs.mkdir(path.join(project, "docs"));
    await fs.writeFile(path.join(project, "docs", "a.txt"), "original");
    await fs.writeFile(path.join(outside, "a.txt"), "secret");
    const { proxy } = await setup({
      serve: async (...args) => {
        await fs.rename(path.join(project, "docs"), path.join(project, "docs-old"));
        await fs.symlink(outside, path.join(project, "docs"));
        return serveOpenedContainedFile(...args);
      },
    });
    const response = await proxy(
      "daintree-file",
      new Request(url("daintree-file", path.join(project, "docs", "a.txt"), project))
    );
    expect(await response.text()).toBe("original");
  });

  it("downloads only regular files, and never waits on a FIFO", async () => {
    const { transport } = await setup();
    const fifo = path.join(project, "pipe");
    execFileSync("mkfifo", [fifo]);
    await fs.mkdir(path.join(project, "folder"));
    for (const target of [fifo, path.join(project, "folder")]) {
      await expect(
        transport.download(HOST, target, { webContentsId: 7, destinationDir: downloads })
      ).rejects.toMatchObject({ code: "NOT_A_FILE" });
    }
    expect(await fs.readdir(downloads)).toEqual([]);
  }, 5_000);
});

describe("CopyTree bundles", () => {
  async function bundleSetup(options: { bundleTtlMs?: number } = {}) {
    const ctx = await setup(options);
    const bundle = path.join(outside, "My-App-main-2026.xml");
    await fs.writeFile(bundle, "<bundle/>");
    await fs.writeFile(path.join(outside, "My-App-main-secret.xml"), "<other/>");
    return { ...ctx, bundle };
  }

  it("lets the endpoint it was generated for download exactly that file", async () => {
    const { transport, service, endpoint, bundle } = await bundleSetup();
    service.recordBundle(endpoint, bundle);
    const result = await transport.download(HOST, bundle, {
      webContentsId: 7,
      destinationDir: downloads,
    });
    expect(await fs.readFile(result.localPath, "utf8")).toBe("<bundle/>");
    await expect(
      transport.download(HOST, path.join(outside, "My-App-main-secret.xml"), {
        webContentsId: 7,
        destinationDir: downloads,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("is not a grant for another view, another project, or after it expires", async () => {
    const { transport, service, endpoint, secondView, bundle } = await bundleSetup({
      bundleTtlMs: 50,
    });
    secondView();
    service.recordBundle(endpoint, bundle);
    await expect(
      transport.download(HOST, bundle, { webContentsId: 8, destinationDir: downloads })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    endpoint.projectId = "p2";
    await expect(
      transport.download(HOST, bundle, { webContentsId: 7, destinationDir: downloads })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    endpoint.projectId = "p1";

    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(
      transport.download(HOST, bundle, { webContentsId: 7, destinationDir: downloads })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a recorded bundle that was replaced by a symlink", async () => {
    const { transport, service, endpoint, bundle } = await bundleSetup();
    service.recordBundle(endpoint, bundle);
    await fs.rm(bundle);
    await fs.writeFile(path.join(project, "secret.txt"), "secret");
    await fs.symlink(path.join(project, "secret.txt"), bundle);
    await expect(
      transport.download(HOST, bundle, { webContentsId: 7, destinationDir: downloads })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("capacity is reserved before any filesystem work", () => {
  it("refuses a preview beyond the per-Shell request bound while another is answered", async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const serve = vi.fn(async (...args: Parameters<typeof serveOpenedContainedFile>) => {
      await blocked;
      return serveOpenedContainedFile(...args);
    });
    const { proxy } = await setup({ maxRequestsPerSession: 1, serve });
    await fs.writeFile(path.join(project, "a.txt"), "a");
    const request = () => new Request(url("daintree-file", path.join(project, "a.txt"), project));
    const first = proxy("daintree-file", request());
    await waitFor(() => serve.mock.calls.length === 1);
    const second = await proxy("daintree-file", request());
    expect(second.status).toBe(503);
    expect(serve).toHaveBeenCalledTimes(1);
    unblock();
    expect(await (await first).text()).toBe("a");
    expect((await proxy("daintree-file", request())).status).toBe(200);
  });

  it("bounds the bytes previews buffer and returns them when a preview is done", async () => {
    const { proxy, service } = await setup({ maxBufferedBytes: 1024 });
    await fs.writeFile(path.join(project, "small.txt"), Buffer.alloc(600, 97));
    const request = () =>
      new Request(url("daintree-file", path.join(project, "small.txt"), project));
    const first = await proxy("daintree-file", request());
    expect(first.status).toBe(200);
    expect(service.heldBufferedBytes).toBe(600);
    expect((await proxy("daintree-file", request())).status).toBe(503);
    await first.arrayBuffer();
    await waitFor(() => service.heldBufferedBytes === 0);
    expect((await proxy("daintree-file", request())).status).toBe(200);
  });

  it("bounds downloads in flight per Shell and frees the slot when one ends", async () => {
    const { transport, service } = await setup({ maxDownloadsPerSession: 1 });
    await fs.writeFile(path.join(project, "big.bin"), crypto.randomBytes(4 * 1024 * 1024));
    await fs.writeFile(path.join(project, "small.bin"), "x");
    const first = transport.download(HOST, path.join(project, "big.bin"), {
      webContentsId: 7,
      destinationDir: downloads,
    });
    await waitFor(() => service.activeDownloads === 1);
    await expect(
      transport.download(HOST, path.join(project, "small.bin"), {
        webContentsId: 7,
        destinationDir: downloads,
      })
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await first;
    await waitFor(() => service.activeDownloads === 0);
    await expect(
      transport.download(HOST, path.join(project, "small.bin"), {
        webContentsId: 7,
        destinationDir: downloads,
      })
    ).resolves.toMatchObject({ bytes: 1 });
  });
});

describe("saving on the Shell", () => {
  it("writes every byte even when the disk takes a chunk in pieces", async () => {
    const { transport } = await setup();
    const bytes = crypto.randomBytes(300 * 1024 + 11);
    await fs.writeFile(path.join(project, "pieces.bin"), bytes);
    const realOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof fs.open>));
      if (String(args[0]).endsWith(".daintree-part")) {
        const write = handle.write.bind(handle) as (
          ...a: unknown[]
        ) => Promise<{ bytesWritten: number }>;
        handle.write = ((buffer: Uint8Array, offset: number, length: number, position: number) =>
          write(buffer, offset, Math.min(length, 1000), position)) as typeof handle.write;
      }
      return handle;
    });
    try {
      const result = await transport.download(HOST, path.join(project, "pieces.bin"), {
        webContentsId: 7,
        destinationDir: downloads,
      });
      expect(sha256(await fs.readFile(result.localPath))).toBe(sha256(bytes));
    } finally {
      open.mockRestore();
    }
  });

  it("never places a file whose saved length differs from what was sent", async () => {
    const { transport } = await setup();
    await fs.writeFile(path.join(project, "short.bin"), crypto.randomBytes(64 * 1024));
    const realOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof fs.open>));
      if (String(args[0]).endsWith(".daintree-part")) {
        const stat = handle.stat.bind(handle);
        handle.stat = (async () => {
          const real = await stat();
          return Object.assign(real, { size: real.size - 1 });
        }) as typeof handle.stat;
      }
      return handle;
    });
    try {
      await expect(
        transport.download(HOST, path.join(project, "short.bin"), {
          webContentsId: 7,
          destinationDir: downloads,
        })
      ).rejects.toBeInstanceOf(AppError);
      await expectEventuallyEmpty(downloads);
    } finally {
      open.mockRestore();
    }
  });
});
