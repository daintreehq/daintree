import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("electron", () => ({
  app: { isPackaged: true, on: vi.fn(), getPath: vi.fn(() => os.tmpdir()) },
  protocol: { handle: vi.fn() },
  session: { fromPartition: vi.fn() },
  shell: { openExternal: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

import type { FileTransferEvent } from "../../../../shared/types/ipc/fileTransfer.js";
import { AppError } from "../../../utils/errorTypes.js";
import type { LinkSession } from "../../link/session.js";
import {
  makeTempDir,
  openSessionPair,
  removeTempDir,
  waitFor,
  type LinkConditions,
} from "../../link/__tests__/linkTestUtils.js";
import { ClientFileTransport, type HostFileBody } from "../ClientFileTransport.js";
import { createHostFileClient } from "../clientInstall.js";
import { createHostFileProxy } from "../hostFileProxy.js";
import type { HostPickerBridge } from "../HostPickerBridge.js";
import { serveOpenedContainedFile } from "../../../setup/protocols.js";
import { HostFileService, type HostFileEndpoint } from "../HostFileService.js";
import {
  DOWNLOAD_SINK_PREFIX,
  FileDownloadPayloadSchema,
  FileLinkMethod,
  PREVIEW_PULL_DEPTH,
  PULL_MAX_BYTES,
  type FileRequestPayload,
  type FileResponse,
} from "../linkMethods.js";
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
    uploadTtlMs?: number;
    clickedTtlMs?: number;
    streamIdleMs?: number;
    /** Project p1's roots as configured; the real project folder by default. */
    roots?: string[];
    /** The link between the two, emulated; a plain socket when absent. */
    conditions?: LinkConditions;
    clientPullDepth?: number;
    clientCommitTimeoutMs?: number;
    /** Answer as a host from before pull depths: never sees the Shell's ask, never grants one. */
    legacyHost?: boolean;
  } = {}
) {
  const { host, client } = await openSessionPair(socketDir, {}, {}, options.conditions);
  sessions.push(host, client);
  if (options.legacyHost) {
    const register = host.registerCallHandler.bind(host);
    vi.spyOn(host, "registerCallHandler").mockImplementation(((
      method: string,
      schema: Parameters<typeof register>[1],
      handler: (payload: unknown) => unknown
    ) =>
      register(
        method,
        schema,
        method === FileLinkMethod.REQUEST
          ? async (payload: unknown) => {
              const { pullDepth: _asked, ...asked } = payload as FileRequestPayload;
              const { pullDepth: _granted, ...answer } = (await handler(asked)) as FileResponse;
              return answer;
            }
          : handler
      )) as typeof host.registerCallHandler);
  }
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
    uploadTtlMs: options.uploadTtlMs,
    clickedTtlMs: options.clickedTtlMs,
    streamIdleMs: options.streamIdleMs,
  });
  services.push(service);
  service.attach(host, endpoint);
  const transport = new ClientFileTransport({
    maxConcurrentPulls: options.clientPulls,
    pullDepth: options.clientPullDepth,
    commitTimeoutMs: options.clientCommitTimeoutMs,
  });
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

  it("names why it refused: another window's control, or a file outside the project", async () => {
    let driving = false;
    const { proxy } = await setup({ driving: () => driving });
    await fs.writeFile(path.join(project, "a.png"), "x");
    await fs.writeFile(path.join(outside, "b.png"), "y");

    const watched = await proxy(
      "daintree-file",
      new Request(url("daintree-file", path.join(project, "a.png"), project), { method: "HEAD" })
    );
    expect(watched.status).toBe(403);
    expect(watched.headers.get("x-daintree-refusal")).toBe("driven-elsewhere");

    driving = true;
    const elsewhere = await proxy(
      "daintree-file",
      new Request(url("daintree-file", path.join(outside, "b.png"), outside), { method: "HEAD" })
    );
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.headers.get("x-daintree-refusal")).toBe("outside-project");

    const missing = await proxy(
      "daintree-file",
      new Request(url("daintree-file", path.join(project, "gone.png"), project), {
        method: "HEAD",
      })
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-daintree-refusal")).toBeNull();
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
    const pull = vi.spyOn(transport, "openBody");
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

describe("previews pulled ahead", () => {
  const MiB = PULL_MAX_BYTES;

  /**
   * The host's transfers and body reads, watched. `holdFirstSend(n)` keeps the
   * next transfer from finishing until `n` transfers have started counting it
   * and every one but it has finished, so later slices settle before an
   * earlier one; `stats.held` says whether that happened or a watchdog gave up.
   */
  function observeHost(host: LinkSession) {
    const stats = {
      sends: 0,
      maxSends: 0,
      entered: 0,
      reading: 0,
      maxReading: 0,
      bytesRead: 0,
      held: null as "barrier" | "watchdog" | null,
    };
    let hold: { until: number; base: number } | null = null;
    let slowFirstRead = true;
    const send = host.transfers.send.bind(host.transfers);
    vi.spyOn(host.transfers, "send").mockImplementation(async (source, options) => {
      stats.sends++;
      stats.entered++;
      stats.maxSends = Math.max(stats.maxSends, stats.sends);
      const held = hold;
      hold = null;
      try {
        const result = await send(source, options);
        if (held) {
          stats.held = await waitFor(
            () => stats.entered - held.base >= held.until && stats.sends === 1,
            5_000
          ).then(
            () => "barrier" as const,
            () => "watchdog" as const
          );
        }
        return result;
      } finally {
        stats.sends--;
      }
    });
    const serve: typeof serveOpenedContainedFile = async (...args) => {
      const response = await serveOpenedContainedFile(...args);
      const body = response.body;
      if (!body) return response;
      const getReader = body.getReader.bind(body) as () => ReadableStreamDefaultReader<Uint8Array>;
      body.getReader = (() => {
        const reader = getReader();
        const read = reader.read.bind(reader);
        reader.read = async () => {
          stats.reading++;
          stats.maxReading = Math.max(stats.maxReading, stats.reading);
          try {
            // Long enough for the pulls sent behind the first to arrive while it reads.
            if (slowFirstRead) {
              slowFirstRead = false;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            const next = await read();
            stats.bytesRead += next.value?.byteLength ?? 0;
            return next;
          } finally {
            stats.reading--;
          }
        };
        return reader;
      }) as typeof body.getReader;
      return response;
    };
    const holdFirstSend = (until: number) => {
      hold = { until, base: stats.entered };
      stats.held = null;
    };
    const reset = () => {
      stats.maxSends = stats.sends;
      stats.maxReading = stats.reading;
      slowFirstRead = true;
    };
    return { stats, serve, holdFirstSend, reset };
  }

  async function pipelined(options: Parameters<typeof setup>[0] = {}) {
    let observed: ReturnType<typeof observeHost> | null = null;
    const ctx = await setup({
      ...options,
      serve: (...args) => observed!.serve(...args),
    });
    observed = observeHost(ctx.host);
    const bodies: HostFileBody[] = [];
    const openBody = ctx.transport.openBody.bind(ctx.transport);
    vi.spyOn(ctx.transport, "openBody").mockImplementation((...args) => {
      const body = openBody(...args);
      bodies.push(body);
      return body;
    });
    const pulls = () =>
      vi.mocked(ctx.client.call).mock.calls.filter(([method]) => method === FileLinkMethod.PULL)
        .length;
    vi.spyOn(ctx.client, "call");
    const open = (file: string) =>
      ctx.proxy("daintree-media", new Request(url("daintree-media", file, project)));
    return { ...ctx, ...observed, bodies, pulls, open };
  }

  async function write(name: string, size: number): Promise<{ file: string; bytes: Buffer }> {
    const bytes = crypto.randomBytes(size);
    const file = path.join(project, name);
    await fs.writeFile(file, bytes);
    return { file, bytes };
  }

  it("sends later slices while the first waits for its acknowledgement, in order, reading one at a time", async () => {
    const ctx = await pipelined({ conditions: { oneWayDelayMs: 5 } });
    const { file, bytes } = await write("clip.mp4", 6 * MiB + 17);
    // Slice 0 finishes only after the slice behind it has: they reach the reader in order anyway.
    ctx.holdFirstSend(2);
    const response = await ctx.open(file);
    expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(sha256(bytes));
    expect(ctx.stats.held).toBe("barrier");
    expect(ctx.stats.maxSends).toBeGreaterThan(1);
    expect(ctx.stats.maxSends).toBeLessThanOrEqual(PREVIEW_PULL_DEPTH);
    expect(ctx.stats.maxReading).toBe(1);
    expect(ctx.bodies[0]!.peakBufferedBytes).toBeLessThanOrEqual(PREVIEW_PULL_DEPTH * MiB);
    // Read to its end: the Shell lets the host go of the stream it kept.
    await waitFor(() => ctx.service.openStreams === 0);
  });

  it.each([
    ["one byte", 1],
    ["exactly one slice", MiB],
    ["exactly three slices", 3 * MiB],
    ["a slice and a bit", MiB + 1],
  ])(
    "delivers exactly the file's bytes for %s, whatever order slices finish in",
    async (_label, size) => {
      const ctx = await pipelined({ conditions: { oneWayDelayMs: 5 } });
      const { file, bytes } = await write("exact.mp4", size);
      // With two slices or more, the first finishes last.
      if (size > MiB) ctx.holdFirstSend(2);
      const response = await ctx.open(file);
      expect(Number(response.headers.get("content-length"))).toBe(size);
      expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(sha256(bytes));
      if (size > MiB) expect(ctx.stats.held).toBe("barrier");
      await waitFor(() => ctx.service.openStreams === 0);
    }
  );

  it.each([
    ["one byte", 1, 1],
    ["exactly one slice", MiB, 2],
  ])(
    "pulls nothing past the announced length of %s but the one pull that finds its end",
    async (_label, size, expected) => {
      const ctx = await pipelined({ conditions: { oneWayDelayMs: 5 } });
      const { file } = await write("short.mp4", size);
      await (await ctx.open(file)).arrayBuffer();
      expect(ctx.pulls()).toBe(expected);
    }
  );

  it("answers a range with exactly its bytes when the range spans slices", async () => {
    const ctx = await pipelined({ conditions: { oneWayDelayMs: 5 } });
    const { file, bytes } = await write("range.mp4", 5 * MiB);
    const start = MiB - 3;
    const end = 3 * MiB + 9;
    const response = await ctx.proxy(
      "daintree-media",
      new Request(url("daintree-media", file, project), {
        headers: { range: `bytes=${start}-${end}` },
      })
    );
    expect(response.status).toBe(206);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBe(end - start + 1);
    expect(sha256(body)).toBe(sha256(bytes.subarray(start, end + 1)));
  });

  it("stops reading on the host within a slice of a cancel, read-ahead included", async () => {
    const ctx = await pipelined({ conditions: { oneWayDelayMs: 5 } });
    const { file } = await write("long.mp4", 32 * MiB);
    const reader = (await ctx.open(file)).body!.getReader();
    const first = await reader.read();
    expect(first.value!.byteLength).toBe(MiB);
    await reader.cancel();
    await waitFor(() => ctx.service.openStreams === 0);
    await waitFor(() => ctx.stats.sends === 0 && ctx.stats.reading === 0);
    const readAtClose = ctx.stats.bytesRead;
    // The slice handed over and the slices in flight when the cancel landed,
    // give or take the part of a read the last slice left over.
    expect(readAtClose).toBeLessThanOrEqual((PREVIEW_PULL_DEPTH + 2) * MiB);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ctx.stats.bytesRead).toBe(readAtClose);
    expect(ctx.bodies[0]!.bufferedBytes).toBe(0);
  });

  it("gives back every pull slot a cancelled body held, in flight or read ahead", async () => {
    const ctx = await pipelined({ conditions: { oneWayDelayMs: 5 } });
    const a = await write("a.mp4", 8 * MiB);
    const b = await write("b.mp4", 8 * MiB);
    const c = await write("c.mp4", 6 * MiB);
    // Cancelled while its read-ahead is still in flight.
    const readerA = (await ctx.open(a.file)).body!.getReader();
    await readerA.read();
    await readerA.cancel();
    // Cancelled once its read-ahead has all arrived.
    const readerB = (await ctx.open(b.file)).body!.getReader();
    await readerB.read();
    await waitFor(() => ctx.bodies[1]!.bufferedBytes === PREVIEW_PULL_DEPTH * MiB);
    await waitFor(() => ctx.stats.sends === 0);
    await readerB.cancel();
    await waitFor(() => ctx.service.openStreams === 0 && ctx.stats.sends === 0);
    // A body on the same transport still gets its whole depth.
    ctx.reset();
    ctx.holdFirstSend(PREVIEW_PULL_DEPTH);
    const response = await ctx.open(c.file);
    expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(sha256(c.bytes));
    expect(ctx.stats.held).toBe("barrier");
    expect(ctx.stats.maxSends).toBe(PREVIEW_PULL_DEPTH);
  });

  it("leaves a pull slot for another preview while ones whose readers paused hold their read-ahead", async () => {
    const ctx = await pipelined({ conditions: { oneWayDelayMs: 2 } });
    const first = await write("first.mp4", 8 * MiB);
    const second = await write("second.mp4", 8 * MiB);
    const other = await write("other.mp4", 3 * MiB + 5);
    const pausedA = (await ctx.open(first.file)).body!.getReader();
    await pausedA.read();
    await waitFor(() => ctx.bodies[0]!.bufferedBytes === PREVIEW_PULL_DEPTH * MiB);
    const pausedB = (await ctx.open(second.file)).body!.getReader();
    await pausedB.read();
    await waitFor(() => ctx.stats.sends === 0);
    const response = await ctx.open(other.file);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const body = await Promise.race([
      response.arrayBuffer(),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("starved of a pull slot")), 5_000);
      }),
    ]).finally(() => clearTimeout(watchdog));
    expect(sha256(new Uint8Array(body))).toBe(sha256(other.bytes));
    // The first paused body kept everything it read ahead.
    expect(ctx.bodies[0]!.bufferedBytes).toBe(PREVIEW_PULL_DEPTH * MiB);
    await pausedA.cancel();
    await pausedB.cancel();
  });

  it("drops what it read ahead the moment the host revokes the stream", async () => {
    const ctx = await pipelined();
    const { file } = await write("long.mp4", 8 * MiB);
    const reader = (await ctx.open(file)).body!.getReader();
    await reader.read();
    const body = ctx.bodies[0]!;
    // Every pull answered: only the host's notice can reach what is held now.
    await waitFor(() => body.bufferedBytes === PREVIEW_PULL_DEPTH * MiB);
    await waitFor(() => ctx.stats.sends === 0);
    ctx.endpoint.projectId = "p2";
    ctx.service.onEndpointsChanged();
    expect(ctx.service.openStreams).toBe(0);
    await waitFor(() => body.bufferedBytes === 0);
    await expect(reader.read()).rejects.toBeDefined();
  });

  it("drops what it read ahead when the host idles out a stream nobody reads", async () => {
    const ctx = await pipelined({ streamIdleMs: 500 });
    const { file } = await write("paused.mp4", 8 * MiB);
    const reader = (await ctx.open(file)).body!.getReader();
    await reader.read();
    const body = ctx.bodies[0]!;
    await waitFor(() => body.bufferedBytes === PREVIEW_PULL_DEPTH * MiB);
    await waitFor(() => ctx.service.openStreams === 0);
    await waitFor(() => body.bufferedBytes === 0);
    await expect(reader.read()).rejects.toBeDefined();
  });

  it("drops the link when the Shell can't take the host's notice, so nothing read ahead survives", async () => {
    const ctx = await pipelined();
    const { file } = await write("long.mp4", 8 * MiB);
    const reader = (await ctx.open(file)).body!.getReader();
    await reader.read();
    const body = ctx.bodies[0]!;
    await waitFor(() => body.bufferedBytes === PREVIEW_PULL_DEPTH * MiB);
    await waitFor(() => ctx.stats.sends === 0);
    ctx.client.registerCallHandler(FileLinkMethod.STREAM_CLOSED, z.unknown(), () => {
      throw new AppError({ code: "RATE_LIMITED", message: "Too many requests" });
    });
    ctx.endpoint.projectId = "p2";
    ctx.service.onEndpointsChanged();
    await waitFor(() => !ctx.client.isOpen);
    await waitFor(() => body.bufferedBytes === 0);
    await expect(reader.read()).rejects.toBeDefined();
  });

  it("sends the notice again to a Shell that was only busy, keeping the link", async () => {
    const ctx = await pipelined();
    const { file } = await write("long.mp4", 8 * MiB);
    const reader = (await ctx.open(file)).body!.getReader();
    await reader.read();
    const body = ctx.bodies[0]!;
    await waitFor(() => body.bufferedBytes === PREVIEW_PULL_DEPTH * MiB);
    await waitFor(() => ctx.stats.sends === 0);
    const handled = vi.fn();
    let busy = true;
    ctx.client.registerCallHandler(
      FileLinkMethod.STREAM_CLOSED,
      z.object({ streamId: z.string() }),
      ({ streamId }) => {
        if (busy) {
          busy = false;
          throw new AppError({ code: "RATE_LIMITED", message: "Too many requests" });
        }
        handled(streamId);
        return null;
      }
    );
    ctx.endpoint.projectId = "p2";
    ctx.service.onEndpointsChanged();
    await waitFor(() => handled.mock.calls.length === 1);
    expect(ctx.client.isOpen).toBe(true);
  });

  it("reads ahead only on spare pull slots", async () => {
    const ctx = await pipelined({ clientPulls: 1, conditions: { oneWayDelayMs: 2 } });
    const { file, bytes } = await write("solo.mp4", 3 * MiB + 5);
    const response = await ctx.open(file);
    expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(sha256(bytes));
    expect(ctx.stats.maxSends).toBe(1);
  });

  it("pulls one slice at a time from a host that grants no depth", async () => {
    const ctx = await pipelined({ legacyHost: true, conditions: { oneWayDelayMs: 2 } });
    const { file, bytes } = await write("old-host.mp4", 3 * MiB + 5);
    const response = await ctx.open(file);
    expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(sha256(bytes));
    expect(ctx.stats.maxSends).toBe(1);
    // The host closed the stream itself at the end, as it always has.
    expect(ctx.service.openStreams).toBe(0);
  });

  it("serves a Shell that asks for no depth one slice at a time, closing at the end", async () => {
    const ctx = await pipelined({ clientPullDepth: 1, conditions: { oneWayDelayMs: 2 } });
    const answered = vi.spyOn(ctx.transport, "request");
    const { file, bytes } = await write("old-shell.mp4", 3 * MiB + 5);
    const response = await ctx.open(file);
    expect((await answered.mock.results[0]!.value) as FileResponse).not.toHaveProperty("pullDepth");
    expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(sha256(bytes));
    expect(ctx.stats.maxSends).toBe(1);
    expect(ctx.service.openStreams).toBe(0);
  });

  it("fails a body opened after the link dropped, without pulling", async () => {
    const { transport, client } = await setup();
    client.close("gone");
    const body = transport.openBody(HOST, "d".repeat(32), { pullDepth: 4, expectedBytes: 10 });
    await expect(body.read()).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
    expect(() => body.cancel()).not.toThrow();
  });

  it("refuses a pull out of sequence on a pipelined stream, and closes it", async () => {
    const { client, service } = await setup({ hostPulls: 3 });
    const { file } = await write("order.mp4", 3 * MiB);
    const answer = (await client.call(FileLinkMethod.REQUEST, {
      endpointId: "view-7",
      scheme: "daintree-media",
      path: file,
      root: project,
      method: "GET",
      range: null,
      pullDepth: 64,
    })) as FileResponse;
    // Granted no deeper than the host's own pull cap.
    expect(answer.pullDepth).toBe(3);
    await expect(
      client.call(FileLinkMethod.PULL, {
        streamId: answer.streamId,
        token: "c".repeat(32),
        maxBytes: MiB,
        sequence: 1,
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(service.openStreams).toBe(0);
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

  it("names a download for the file that was asked for, whatever the host calls it", async () => {
    const { host, client } = await openSessionPair(socketDir);
    sessions.push(host, client);
    const bytes = new Uint8Array(64).fill(3);
    host.registerCallHandler(FileLinkMethod.DOWNLOAD, FileDownloadPayloadSchema, ({ token }) => {
      void host.transfers
        .send(
          {
            size: bytes.byteLength,
            sha256: sha256(bytes),
            read: async (o, l) => bytes.subarray(o, o + l),
          },
          {
            name: "invoice\u202egpj.app",
            destination: { kind: "path", path: `${DOWNLOAD_SINK_PREFIX}${token}` },
          }
        )
        .catch(() => {});
      return { name: "invoice\u202egpj.app", size: bytes.byteLength };
    });
    const transport = new ClientFileTransport();
    transport.noteEndpointOpened(HOST, { session: client, webContentsId: 7, endpointId: "view-7" });

    const saved = await transport.download(HOST, "/work/notes\u202etxt.sh", {
      webContentsId: 7,
      destinationDir: downloads,
    });
    expect(path.basename(saved.localPath)).toBe("notestxt.sh");
    if (process.platform === "darwin") {
      const { execFileSync } = await import("node:child_process");
      // Only where this volume takes extended attributes: elsewhere the tag is skipped by design.
      const probe = path.join(downloads, ".xattr-probe");
      await fs.writeFile(probe, "");
      let tagsWork = true;
      try {
        execFileSync("/usr/bin/xattr", ["-w", "dev.daintree.probe", "1", probe]);
      } catch {
        tagsWork = false;
      }
      await fs.rm(probe, { force: true });
      if (tagsWork) {
        const tag = execFileSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", saved.localPath]);
        expect(tag.toString()).toMatch(/^0081;[0-9a-f]+;Daintree;/);
      }
    }
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

describe("a download the link drops", () => {
  /** Relinks still opening when a test ends, so their sessions are torn down with the rest. */
  const relinking: Promise<void>[] = [];
  afterEach(async () => {
    await Promise.allSettled(relinking.splice(0));
  });
  /** The link comes back: a new session, and the view's endpoint on it, for the same Shell. */
  const relink = (transport: ClientFileTransport, service: HostFileService): Promise<void> => {
    const opened = (async () => {
      const { host, client } = await openSessionPair(socketDir);
      sessions.push(host, client);
      service.attach(host, new FakeEndpoint());
      transport.noteEndpointOpened(HOST, {
        session: client,
        webContentsId: 7,
        endpointId: "view-7",
      });
    })();
    relinking.push(opened);
    opened.catch(() => {});
    return opened;
  };
  const windowDownloads = (
    transport: ClientFileTransport,
    sendToView: (webContentsId: number, event: FileTransferEvent) => void,
    reconnectWaitMs?: number
  ) =>
    createHostFileClient({
      transport,
      pickers: {} as HostPickerBridge,
      capabilities: new ViewFileCapabilities(() => () => {}),
      hostForView: () => HOST,
      sendToView,
      downloadsDir: () => downloads,
      tempDir: () => downloads,
      reconnectWaitMs,
    });
  /** Cuts the link the first time the download reports progress short of its end. */
  const dropMidTransfer = (cut: () => void) => {
    let dropped = false;
    return {
      dropped: () => dropped,
      sendToView: (_id: number, event: FileTransferEvent) => {
        if (dropped || event.type !== "progress" || event.transferredBytes >= event.totalBytes) {
          return;
        }
        dropped = true;
        cut();
      },
    };
  };

  it("downloads the whole file again once the link is back, from the caller's one request", async () => {
    const { transport, client: firstLink, service } = await setup();
    const bytes = crypto.randomBytes(4 * 1024 * 1024 + 5);
    await fs.writeFile(path.join(project, "big.bin"), bytes);
    const drop = dropMidTransfer(() => {
      firstLink.close("network went away");
      void relink(transport, service);
    });
    const events: FileTransferEvent[] = [];
    const result = await windowDownloads(transport, (id, event) => {
      events.push(event);
      drop.sendToView(id, event);
    }).download(7, {
      hostId: HOST,
      hostPath: path.join(project, "big.bin"),
      opId: "op-big",
    });
    expect(drop.dropped()).toBe(true);
    expect(result).toEqual({ localPath: path.join(downloads, "big.bin"), bytes: bytes.byteLength });
    expect(sha256(await fs.readFile(result.localPath))).toBe(sha256(bytes));
    // The view's progress follows the restart through to the last byte.
    expect(events.at(-1)).toEqual({
      type: "progress",
      opId: "op-big",
      transferredBytes: bytes.byteLength,
      totalBytes: bytes.byteLength,
    });
    // The dropped attempt's part file is gone, and nothing was placed twice.
    await vi.waitFor(async () => expect(await fs.readdir(downloads)).toEqual(["big.bin"]));
  });

  it("fails as disconnected, leaving nothing behind, when the link doesn't come back in time", async () => {
    const { transport, client: firstLink } = await setup();
    await fs.writeFile(path.join(project, "big.bin"), crypto.randomBytes(4 * 1024 * 1024));
    const drop = dropMidTransfer(() => firstLink.close("network went away"));
    const attempts = vi.spyOn(transport, "download");
    const failure = await windowDownloads(transport, drop.sendToView, 50)
      .download(7, { hostId: HOST, hostPath: path.join(project, "big.bin"), opId: "op-big" })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "HOST_DISCONNECTED" });
    expect((failure as AppError).userMessage).toMatch(/didn't reconnect/);
    expect(drop.dropped()).toBe(true);
    expect(attempts).toHaveBeenCalledTimes(1);
    await expectEventuallyEmpty(downloads);
  });

  it("starts over when the link drops before the host answered the download", async () => {
    const { transport, client: firstLink, service } = await setup();
    const bytes = crypto.randomBytes(64 * 1024);
    await fs.writeFile(path.join(project, "notes.bin"), bytes);
    const realCall = firstLink.call.bind(firstLink);
    let lost: unknown = null;
    vi.spyOn(firstLink, "call").mockImplementationOnce((...args) => {
      const answer = realCall(...args);
      answer.catch((error: unknown) => {
        lost = error;
      });
      // After the session's own flush: the request is on the wire, its answer not yet back.
      setImmediate(() => {
        firstLink.close("network went away");
        void relink(transport, service);
      });
      return answer;
    });
    const result = await windowDownloads(transport, () => {}).download(7, {
      hostId: HOST,
      hostPath: path.join(project, "notes.bin"),
      opId: "op-notes",
    });
    expect(lost).toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(sha256(await fs.readFile(result.localPath))).toBe(sha256(bytes));
    await vi.waitFor(async () => expect(await fs.readdir(downloads)).toEqual(["notes.bin"]));
  });

  /** Holds the download just after it is linked into Downloads, until released. */
  const holdPlacement = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const placing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const realLink = fs.link.bind(fs);
    const spy = vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      await realLink(from, to);
      if (String(to).startsWith(downloads)) {
        started();
        await held;
      }
    });
    return { placing, release, restore: () => spy.mockRestore() };
  };

  it("keeps a file the link dropped under while it was being placed, fetching it once", async () => {
    const { transport, client: firstLink, service } = await setup();
    const bytes = crypto.randomBytes(256 * 1024);
    await fs.writeFile(path.join(project, "report.bin"), bytes);
    const placement = holdPlacement();
    const attempts = vi.spyOn(transport, "download");
    try {
      const pending = windowDownloads(transport, () => {}).download(7, {
        hostId: HOST,
        hostPath: path.join(project, "report.bin"),
        opId: "op-report",
      });
      await placement.placing;
      firstLink.close("network went away");
      await relink(transport, service);
      placement.release();
      const result = await pending;
      expect(result.localPath).toBe(path.join(downloads, "report.bin"));
      expect(sha256(await fs.readFile(result.localPath))).toBe(sha256(bytes));
      expect(attempts).toHaveBeenCalledTimes(1);
      await vi.waitFor(async () => expect(await fs.readdir(downloads)).toEqual(["report.bin"]));
    } finally {
      placement.release();
      placement.restore();
    }
  });

  it("fails a save the link dropped under that never finishes, removing what it placed late", async () => {
    const { transport, client: firstLink, service } = await setup({ clientCommitTimeoutMs: 50 });
    await fs.writeFile(path.join(project, "report.bin"), crypto.randomBytes(256 * 1024));
    const placement = holdPlacement();
    const attempts = vi.spyOn(transport, "download");
    try {
      const pending = windowDownloads(transport, () => {}).download(7, {
        hostId: HOST,
        hostPath: path.join(project, "report.bin"),
        opId: "op-report",
      });
      const failed = expect(pending).rejects.toMatchObject({
        code: "INTERNAL",
        message: expect.stringMatching(/timeout/),
      });
      await placement.placing;
      firstLink.close("network went away");
      await relink(transport, service);
      await failed;
      // The file was already linked into place: finishing now must take it back out.
      placement.release();
      expect(attempts).toHaveBeenCalledTimes(1);
      await expectEventuallyEmpty(downloads);
    } finally {
      placement.release();
      placement.restore();
    }
  });

  it("reports a save that fails after the link dropped as itself, without fetching again", async () => {
    const { transport, client: firstLink, service } = await setup();
    await fs.writeFile(path.join(project, "report.bin"), crypto.randomBytes(256 * 1024));
    let releaseSync!: () => void;
    const syncHeld = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    let syncing!: () => void;
    const syncStarted = new Promise<void>((resolve) => {
      syncing = resolve;
    });
    const diskError = Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
    const realOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof fs.open>));
      if (String(args[0]).endsWith(".daintree-part")) {
        handle.sync = async () => {
          syncing();
          await syncHeld;
          throw diskError;
        };
      }
      return handle;
    });
    const attempts = vi.spyOn(transport, "download");
    try {
      const pending = windowDownloads(transport, () => {}).download(7, {
        hostId: HOST,
        hostPath: path.join(project, "report.bin"),
        opId: "op-report",
      });
      const failed = expect(pending).rejects.toBe(diskError);
      await syncStarted;
      firstLink.close("network went away");
      await relink(transport, service);
      releaseSync();
      await failed;
      expect(attempts).toHaveBeenCalledTimes(1);
      await expectEventuallyEmpty(downloads);
    } finally {
      releaseSync();
      open.mockRestore();
    }
  });
});

describe("waiting for a view to be reachable on its host", () => {
  it("resolves once the view's own endpoint is on an open link again, not another view's", async () => {
    const { transport, client: firstLink } = await setup();
    firstLink.close("network went away");
    transport.noteEndpointClosed(HOST, { endpointId: "view-7" });
    expect(transport.isReachable(HOST, 7)).toBe(false);
    let reachable: boolean | null = null;
    const waiting = transport.whenReachable(HOST, 7, 5_000).then((answer) => {
      reachable = answer;
    });
    const { host, client } = await openSessionPair(socketDir);
    sessions.push(host, client);
    transport.noteEndpointOpened(HOST, { session: client, webContentsId: 8, endpointId: "view-8" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(reachable).toBeNull();
    transport.noteEndpointOpened(HOST, { session: client, webContentsId: 7, endpointId: "view-7" });
    await waiting;
    expect(reachable).toBe(true);
    // Already back: answered at once, whatever the wait.
    await expect(transport.whenReachable(HOST, 7, 0)).resolves.toBe(true);
  });

  it("gives up when its wait runs out, or when it is aborted", async () => {
    const { transport, client: firstLink } = await setup();
    firstLink.close("network went away");
    await expect(transport.whenReachable(HOST, 7, 20)).resolves.toBe(false);
    const controller = new AbortController();
    const waiting = transport.whenReachable(HOST, 7, 5_000, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBe(false);
    expect((transport as unknown as { openedListeners: Set<unknown> }).openedListeners.size).toBe(
      0
    );
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

  it("refuses a recorded bundle that another file has taken the place of", async () => {
    const { transport, service, endpoint, bundle } = await bundleSetup();
    service.recordBundle(endpoint, bundle);
    // Let the record take the generated file's identity, then swap it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.rm(bundle);
    await fs.writeFile(bundle, "<injected/>");
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

describe("a view's own inbox uploads", () => {
  async function uploadSetup(options: { uploadTtlMs?: number } = {}) {
    const ctx = await setup(options);
    // The inbox: one folder per dropped file, beside everyone else's.
    const folder = path.join(outside, "files", "20261022-101500-abc123");
    await fs.mkdir(folder, { recursive: true });
    const upload = path.join(folder, "shot.png");
    await fs.writeFile(upload, "my upload");
    const theirs = path.join(outside, "files", "20261022-101501-def456", "theirs.png");
    await fs.mkdir(path.dirname(theirs), { recursive: true });
    await fs.writeFile(theirs, "someone else's upload");
    const preview = (filePath: string, cap = ctx.cap) =>
      ctx.rawProxy(
        "daintree-file",
        { hostId: HOST, viewCapability: cap },
        new Request(url("daintree-file", filePath, path.dirname(filePath)))
      );
    return { ...ctx, folder, upload, theirs, preview };
  }

  it("previews, reads and downloads exactly the file the view uploaded", async () => {
    const { service, endpoint, upload, theirs, preview, transport } = await uploadSetup();
    service.recordUpload(endpoint, "p1", upload);

    const own = await preview(upload);
    expect(own.status).toBe(200);
    expect(await own.text()).toBe("my upload");
    await expect(service.uploadIdentity(endpoint, upload)).resolves.not.toBeNull();
    const saved = await transport.download(HOST, upload, {
      webContentsId: 7,
      destinationDir: downloads,
    });
    expect(await fs.readFile(saved.localPath, "utf8")).toBe("my upload");

    const other = await preview(theirs);
    expect(other.status).toBe(404);
    expect(other.headers.get("x-daintree-refusal")).toBe("outside-project");
    expect(await other.text()).not.toContain("someone else");
    await expect(service.uploadIdentity(endpoint, theirs)).resolves.toBeNull();
  });

  it("is not a grant for another view, another project, or after it expires", async () => {
    const { service, endpoint, upload, preview, secondView } = await uploadSetup({
      uploadTtlMs: 50,
    });
    const second = secondView();
    service.recordUpload(endpoint, "p1", upload);

    expect((await preview(upload, second.cap)).status).toBe(404);
    await expect(service.uploadIdentity(second.endpoint, upload)).resolves.toBeNull();

    endpoint.projectId = "p2";
    await expect(service.uploadIdentity(endpoint, upload)).resolves.toBeNull();
    endpoint.projectId = "p1";

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await preview(upload)).status).toBe(404);
  });

  it("refuses an upload another file or a symlink has taken the place of", async () => {
    const { service, endpoint, upload, preview } = await uploadSetup();
    service.recordUpload(endpoint, "p1", upload);
    await vi.waitFor(async () => expect((await preview(upload)).status).toBe(200));

    await fs.rm(upload);
    await fs.writeFile(upload, "injected");
    expect((await preview(upload)).status).toBe(404);
    await expect(service.uploadIdentity(endpoint, upload)).resolves.toBeNull();

    await fs.rm(upload);
    await fs.writeFile(path.join(project, "secret.txt"), "secret");
    await fs.symlink(path.join(project, "secret.txt"), upload);
    const linked = await preview(upload);
    expect(linked.status).toBe(404);
    expect(await linked.text()).not.toContain("secret");
    await expect(service.uploadIdentity(endpoint, upload)).resolves.toBeNull();
  });

  it("keeps an upload readable when the inbox touches its times for a duplicate", async () => {
    const { service, endpoint, upload, preview } = await uploadSetup();
    service.recordUpload(endpoint, "p1", upload);
    await vi.waitFor(async () => expect((await preview(upload)).status).toBe(200));
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(upload, later, later);
    expect((await preview(upload)).status).toBe(200);
  });

  it("forgets a view's uploads when its endpoint closes, and records none after", async () => {
    const { service, endpoint, upload } = await uploadSetup();
    service.recordUpload(endpoint, "p1", upload);
    await expect(service.uploadIdentity(endpoint, upload)).resolves.not.toBeNull();
    endpoint.close();
    await expect(service.uploadIdentity(endpoint, upload)).resolves.toBeNull();
    // A placement that finished after the close must not bring the grant back.
    service.recordUpload(endpoint, "p1", upload);
    await expect(service.uploadIdentity(endpoint, upload)).resolves.toBeNull();
  });

  it("records nothing for an endpoint that moved to another project meanwhile", async () => {
    const { service, endpoint, upload } = await uploadSetup();
    endpoint.projectId = "p2";
    service.recordUpload(endpoint, "p1", upload);
    endpoint.projectId = "p1";
    await expect(service.uploadIdentity(endpoint, upload)).resolves.toBeNull();
  });
});

describe("a file the person clicked in a terminal", () => {
  async function clickSetup(options: { clickedTtlMs?: number; driving?: () => boolean } = {}) {
    const ctx = await setup(options);
    const clicked = path.join(outside, "shot.png");
    await fs.writeFile(clicked, "clicked bytes");
    const sibling = path.join(outside, "notes.txt");
    await fs.writeFile(sibling, "not clicked");
    const preview = (filePath: string, cap = ctx.cap) =>
      ctx.rawProxy(
        "daintree-file",
        { hostId: HOST, viewCapability: cap },
        new Request(url("daintree-file", filePath, path.dirname(filePath)))
      );
    const click = (filePath: string, webContentsId = 7) =>
      ctx.transport.grantClicked(HOST, filePath, webContentsId);
    return { ...ctx, clicked, sibling, preview, click };
  }

  it("previews, reads and downloads exactly the clicked file, and nothing beside it", async () => {
    const { service, endpoint, clicked, sibling, preview, click, transport } = await clickSetup();
    const before = await preview(clicked);
    expect(before.status).toBe(404);
    expect(before.headers.get("x-daintree-refusal")).toBe("outside-project");
    expect(service.isClicked(endpoint, clicked)).toBe(false);

    await click(clicked);

    const own = await preview(clicked);
    expect(own.status).toBe(200);
    expect(await own.text()).toBe("clicked bytes");
    expect(service.isClicked(endpoint, clicked)).toBe(true);
    const saved = await transport.download(HOST, clicked, {
      webContentsId: 7,
      destinationDir: downloads,
    });
    expect(await fs.readFile(saved.localPath, "utf8")).toBe("clicked bytes");

    const beside = await preview(sibling);
    expect(beside.status).toBe(404);
    expect(await beside.text()).not.toContain("not clicked");
    expect(service.isClicked(endpoint, sibling)).toBe(false);
  });

  it("is a grant for the view that clicked, not another view of the same project", async () => {
    const { service, endpoint, clicked, sibling, preview, click, secondView } = await clickSetup();
    const second = secondView();
    second.endpoint.projectId = "p1";

    await click(clicked);
    expect((await preview(clicked)).status).toBe(200);
    expect((await preview(clicked, second.cap)).status).toBe(404);
    expect(service.isClicked(second.endpoint, clicked)).toBe(false);

    await click(sibling, 8);
    expect((await preview(sibling, second.cap)).status).toBe(200);
    expect((await preview(sibling)).status).toBe(404);
    expect(service.isClicked(endpoint, sibling)).toBe(false);
  });

  it("is not a grant once the view moves to another project", async () => {
    const { service, endpoint, clicked, click } = await clickSetup();
    await click(clicked);
    expect(service.isClicked(endpoint, clicked)).toBe(true);
    endpoint.projectId = "p2";
    expect(service.isClicked(endpoint, clicked)).toBe(false);
  });

  it("expires", async () => {
    const { service, endpoint, clicked, preview, click } = await clickSetup({ clickedTtlMs: 50 });
    await click(clicked);
    expect((await preview(clicked)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await preview(clicked)).status).toBe(404);
    expect(service.isClicked(endpoint, clicked)).toBe(false);
  });

  it("isn't refused by an upload grant whose file was replaced since", async () => {
    const { service, endpoint, clicked, preview, click } = await clickSetup();
    service.recordUpload(endpoint, "p1", clicked);
    await vi.waitFor(async () => expect((await preview(clicked)).status).toBe(200));
    await fs.rm(clicked);
    await fs.writeFile(clicked, "replaced");
    expect((await preview(clicked)).status).toBe(404);

    await click(clicked);
    const after = await preview(clicked);
    expect(after.status).toBe(200);
    expect(await after.text()).toBe("replaced");
  });

  it("grants only a regular file, never a folder, a missing file or a symlink", async () => {
    const { service, endpoint, click } = await clickSetup();
    await fs.writeFile(path.join(project, "secret.txt"), "secret");
    const link = path.join(outside, "link.txt");
    await fs.symlink(path.join(project, "secret.txt"), link);

    await expect(click(outside)).rejects.toMatchObject({ code: "NOT_A_FILE" });
    await expect(click(path.join(outside, "gone.txt"))).rejects.toMatchObject({
      code: "NOT_A_FILE",
    });
    await expect(click(link)).rejects.toMatchObject({ code: "NOT_A_FILE" });
    expect(service.isClicked(endpoint, link)).toBe(false);
  });

  it("never reads through a symlink put in the clicked file's place", async () => {
    const { clicked, preview, click } = await clickSetup();
    await click(clicked);
    await fs.rm(clicked);
    await fs.writeFile(path.join(other, "secret.txt"), "secret");
    await fs.symlink(path.join(other, "secret.txt"), clicked);

    const linked = await preview(clicked);
    expect(linked.status).toBe(404);
    expect(await linked.text()).not.toContain("secret");
  });

  it("never reads a file beside it through a link put in the clicked file's place", async () => {
    const { clicked, sibling, preview, click, transport } = await clickSetup();
    await click(clicked);
    await fs.rm(clicked);
    await fs.symlink(sibling, clicked);

    const linked = await preview(clicked);
    expect(linked.status).toBe(404);
    expect(await linked.text()).not.toContain("not clicked");
    await expect(
      transport.download(HOST, clicked, { webContentsId: 7, destinationDir: downloads })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await fs.readdir(downloads)).toEqual([]);
  });

  it("stops letting a text read through once the view loses control", async () => {
    let driving = true;
    const { service, endpoint, clicked, click } = await clickSetup({ driving: () => driving });
    await click(clicked);
    expect(service.isClicked(endpoint, clicked)).toBe(true);
    driving = false;
    expect(service.isClicked(endpoint, clicked)).toBe(false);
  });

  it("keeps showing whatever file is at the clicked path when it is written again", async () => {
    const { clicked, preview, click } = await clickSetup();
    await click(clicked);
    await fs.rm(clicked);
    await fs.writeFile(clicked, "saved over");
    const again = await preview(clicked);
    expect(again.status).toBe(200);
    expect(await again.text()).toBe("saved over");
  });

  it("refuses a view that doesn't drive the project", async () => {
    const { service, endpoint, clicked, click } = await clickSetup({ driving: () => false });
    await expect(click(clicked)).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    expect(service.isClicked(endpoint, clicked)).toBe(false);
  });

  it("forgets a view's clicked files when its endpoint closes", async () => {
    const { service, endpoint, clicked, click } = await clickSetup();
    await click(clicked);
    expect(service.isClicked(endpoint, clicked)).toBe(true);
    endpoint.close();
    expect(service.isClicked(endpoint, clicked)).toBe(false);
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
        handle.stat = (async (opts?: { bigint?: boolean }) => {
          const real = await stat(opts as { bigint: false });
          const size = real.size as number | bigint;
          return Object.assign(real, { size: typeof size === "bigint" ? size - 1n : size - 1 });
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

  function noHardLinks() {
    return vi
      .spyOn(fs, "link")
      .mockRejectedValue(
        Object.assign(new Error("operation not supported"), { code: "EOPNOTSUPP" })
      );
  }

  it("copies into place when the destination has no hard links, never overwriting", async () => {
    const { transport } = await setup();
    const bytes = crypto.randomBytes(300 * 1024 + 5);
    await fs.writeFile(path.join(project, "report.bin"), bytes);
    await fs.writeFile(path.join(downloads, "report.bin"), "already here");
    const link = noHardLinks();
    try {
      const saved = await transport.download(HOST, path.join(project, "report.bin"), {
        webContentsId: 7,
        destinationDir: downloads,
      });
      expect(link).toHaveBeenCalled();
      expect(path.basename(saved.localPath)).toBe("report (1).bin");
      expect(sha256(await fs.readFile(saved.localPath))).toBe(sha256(bytes));
      expect(await fs.readFile(path.join(downloads, "report.bin"), "utf8")).toBe("already here");
      expect((await fs.readdir(downloads)).sort()).toEqual(["report (1).bin", "report.bin"]);
      if (process.platform === "darwin") {
        const probe = path.join(downloads, ".xattr-probe");
        await fs.writeFile(probe, "");
        let tagsWork = true;
        try {
          execFileSync("/usr/bin/xattr", ["-w", "dev.daintree.probe", "1", probe]);
        } catch {
          tagsWork = false;
        }
        await fs.rm(probe, { force: true });
        if (tagsWork) {
          const tag = execFileSync("/usr/bin/xattr", [
            "-p",
            "com.apple.quarantine",
            saved.localPath,
          ]);
          expect(tag.toString()).toMatch(/^0081;[0-9a-f]+;Daintree;/);
        }
      }
    } finally {
      link.mockRestore();
    }
  });

  it("removes a partial copy when the fallback copy fails", async () => {
    const { transport } = await setup();
    await fs.writeFile(path.join(project, "broken.bin"), crypto.randomBytes(200 * 1024));
    const link = noHardLinks();
    const realOpen = fs.open.bind(fs);
    let failed = false;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof fs.open>));
      if (String(args[0]) === path.join(downloads, "broken.bin")) {
        const write = handle.write.bind(handle) as (...a: unknown[]) => Promise<unknown>;
        let calls = 0;
        // The first chunk lands, so the target is genuinely partial when the disk fills.
        handle.write = ((...a: unknown[]) => {
          if (++calls === 1) return write(...a);
          failed = true;
          return Promise.reject(new Error("disk full"));
        }) as typeof handle.write;
      }
      return handle;
    });
    try {
      await expect(
        transport.download(HOST, path.join(project, "broken.bin"), {
          webContentsId: 7,
          destinationDir: downloads,
        })
      ).rejects.toThrow();
      expect(failed).toBe(true);
      await expectEventuallyEmpty(downloads);
    } finally {
      open.mockRestore();
      link.mockRestore();
    }
  });

  it("discards a fallback copy cancelled while it is being written", async () => {
    const { transport } = await setup();
    await fs.writeFile(path.join(project, "slow.bin"), crypto.randomBytes(200 * 1024));
    const link = noHardLinks();
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let copyStarted!: () => void;
    const started = new Promise<void>((resolve) => (copyStarted = resolve));
    const realOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof fs.open>));
      if (String(args[0]) === path.join(downloads, "slow.bin")) {
        const write = handle.write.bind(handle) as (...a: unknown[]) => Promise<unknown>;
        handle.write = (async (...a: unknown[]) => {
          copyStarted();
          await held;
          return write(...a);
        }) as typeof handle.write;
      }
      return handle;
    });
    try {
      const pending = transport.download(HOST, path.join(project, "slow.bin"), {
        webContentsId: 7,
        destinationDir: downloads,
        signal: controller.signal,
      });
      await started;
      controller.abort();
      release();
      await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
      await expectEventuallyEmpty(downloads);
    } finally {
      open.mockRestore();
      link.mockRestore();
    }
  });

  it("still fails on a link error a copy would not fix", async () => {
    const { transport } = await setup();
    await fs.writeFile(path.join(project, "denied.bin"), "bytes");
    const link = vi
      .spyOn(fs, "link")
      .mockRejectedValue(Object.assign(new Error("no space"), { code: "ENOSPC" }));
    try {
      await expect(
        transport.download(HOST, path.join(project, "denied.bin"), {
          webContentsId: 7,
          destinationDir: downloads,
        })
      ).rejects.toMatchObject({ code: "ENOSPC" });
      await expectEventuallyEmpty(downloads);
    } finally {
      link.mockRestore();
    }
  });
});
