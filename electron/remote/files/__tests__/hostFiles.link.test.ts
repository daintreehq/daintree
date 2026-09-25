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
import { serveContainedFileRequest, type ContainedFileScheme } from "../../../setup/protocols.js";
import { HostFileService, type HostFileEndpoint } from "../HostFileService.js";
import { DOWNLOAD_SINK_PREFIX, FileDownloadPayloadSchema, FileLinkMethod } from "../linkMethods.js";

const HOST = "studio-01";

let socketDir: string;
let project: string;
let outside: string;
let downloads: string;
const sessions: LinkSession[] = [];
const services: HostFileService[] = [];

class FakeEndpoint implements HostFileEndpoint {
  readonly endpointId = "session-1:view-7";
  readonly clientEndpointId = "view-7";
  readonly clientId = "client-a";
  projectId: string | null = "p1";
  private closed = false;
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
  downloads = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hf-dl-")));
});

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  for (const session of sessions.splice(0)) session.close("test done");
  await removeTempDir(socketDir);
  for (const dir of [project, outside, downloads])
    await fs.rm(dir, { recursive: true, force: true });
});

async function setup(
  options: {
    driving?: () => boolean;
    hostPulls?: number;
    clientPulls?: number;
    grant?: (projectId: string, candidate: string) => Promise<string | null>;
    serve?: (scheme: ContainedFileScheme, request: Request) => Promise<Response>;
  } = {}
) {
  const { host, client } = await openSessionPair(socketDir);
  sessions.push(host, client);
  const endpoint = new FakeEndpoint();
  const service = new HostFileService({
    rootsFor: async (projectId) => (projectId === "p1" ? [project] : []),
    grantDownload: options.grant,
    serve: options.serve,
    isDriving: () => options.driving?.() ?? true,
    maxConcurrentPulls: options.hostPulls,
  });
  services.push(service);
  service.attach(host, endpoint);
  const transport = new ClientFileTransport({ maxConcurrentPulls: options.clientPulls });
  transport.noteEndpointOpened(HOST, { session: client, webContentsId: 7, endpointId: "view-7" });
  const proxy = createHostFileProxy(transport);
  return { host, client, endpoint, service, transport, proxy };
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
      HOST,
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
      HOST,
      new Request(url("daintree-file", path.join(outside, "secret.txt"), project))
    );
    expect(outsideRoot.status).toBe(404);

    const symlinkEscape = await proxy(
      "daintree-file",
      HOST,
      new Request(url("daintree-file", path.join(project, "escape.txt"), project))
    );
    expect(symlinkEscape.status).toBe(404);

    const nul = await proxy(
      "daintree-file",
      HOST,
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
      HOST,
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
      HOST,
      new Request(url("daintree-media", file, project), { method: "HEAD" })
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("accept-ranges")).toBe("bytes");
    expect(Number(head.headers.get("content-length"))).toBe(video.byteLength);
    expect(head.body).toBeNull();

    const ranged = await proxy(
      "daintree-media",
      HOST,
      new Request(url("daintree-media", file, project), { headers: { range: "bytes=100-2500099" } })
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 100-2500099/${video.byteLength}`);
    const body = new Uint8Array(await ranged.arrayBuffer());
    expect(body.byteLength).toBe(2_500_000);
    expect(sha256(body)).toBe(sha256(video.subarray(100, 2_500_100)));

    const tail = await proxy(
      "daintree-media",
      HOST,
      new Request(url("daintree-media", file, project), { headers: { range: "bytes=-10" } })
    );
    expect(tail.status).toBe(206);
    expect(Buffer.from(await tail.arrayBuffer()).equals(video.subarray(-10))).toBe(true);

    const unsatisfiable = await proxy(
      "daintree-media",
      HOST,
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
      HOST,
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
      HOST,
      new Request(url("daintree-pdf", path.join(project, "notes.txt"), project))
    );
    expect(response.status).toBe(415);
  });

  it("answers 403 to a window that doesn't drive the project", async () => {
    const { proxy } = await setup({ driving: () => false });
    await fs.writeFile(path.join(project, "a.txt"), "x");
    const response = await proxy(
      "daintree-file",
      HOST,
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
          HOST,
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
          HOST,
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
      HOST,
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
      HOST,
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
      serve: async (scheme, request) => {
        endpointRef!.projectId = "p2";
        return serveContainedFileRequest(scheme, request);
      },
    });
    endpointRef = ctx.endpoint;
    const file = path.join(project, "long.mp4");
    await fs.writeFile(file, crypto.randomBytes(1024));
    const response = await ctx.proxy(
      "daintree-media",
      HOST,
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
      destinationDir: downloads,
    });
    expect(path.basename(second.localPath)).toBe("report (1).bin");
    expect((await fs.readdir(downloads)).sort()).toEqual(["report (1).bin", "report.bin"]);
  });

  it("refuses a file outside the project and leaves nothing behind", async () => {
    const { transport } = await setup();
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await expect(
      transport.download(HOST, path.join(outside, "secret.txt"), { destinationDir: downloads })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await fs.readdir(downloads)).toEqual([]);
  });

  it("allows a file outside the project only when the host grants that file", async () => {
    const granted = path.join(outside, "bundle.xml");
    const { transport } = await setup({
      grant: async (_projectId, candidate) => (candidate === granted ? granted : null),
    });
    await fs.writeFile(granted, "<bundle/>");
    await fs.writeFile(path.join(outside, "other.xml"), "<other/>");
    await expect(
      transport.download(HOST, path.join(outside, "other.xml"), { destinationDir: downloads })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const result = await transport.download(HOST, path.join(outside, "bundle.xml"), {
      destinationDir: downloads,
    });
    expect(await fs.readFile(result.localPath, "utf8")).toBe("<bundle/>");
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
      transport.download(HOST, "/anything", { destinationDir: downloads })
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

  it("fails, rather than hangs, when the download can't be saved here", async () => {
    const { transport } = await setup();
    await fs.writeFile(path.join(project, "report.bin"), "x");
    const blocked = path.join(downloads, "not-a-dir");
    await fs.writeFile(blocked, "");
    await expect(
      transport.download(HOST, path.join(project, "report.bin"), { destinationDir: blocked })
    ).rejects.toBeInstanceOf(AppError);
  });

  it("cancels a download and removes the partial file", async () => {
    const { transport } = await setup();
    await fs.writeFile(path.join(project, "big.bin"), crypto.randomBytes(8 * 1024 * 1024));
    const controller = new AbortController();
    const pending = transport.download(HOST, path.join(project, "big.bin"), {
      destinationDir: downloads,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await expectEventuallyEmpty(downloads);
  });
});
