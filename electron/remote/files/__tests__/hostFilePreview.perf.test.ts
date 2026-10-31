import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, on: vi.fn(), getPath: vi.fn(() => os.tmpdir()) },
  protocol: { handle: vi.fn() },
  session: { fromPartition: vi.fn() },
  shell: { openExternal: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

import { Lane } from "../../link/frames.js";
import { InteractiveKind } from "../../link/messages.js";
import {
  makeTempDir,
  openSessionPair,
  removeTempDir,
  type LinkConditions,
} from "../../link/__tests__/linkTestUtils.js";
import { ClientFileTransport, type HostFileBody } from "../ClientFileTransport.js";
import { createHostFileProxy } from "../hostFileProxy.js";
import { HostFileService, type HostFileEndpoint } from "../HostFileService.js";
import { ViewFileCapabilities } from "../viewCapabilities.js";

/**
 * Remote preview transport, measured: a whole image and a whole PDF pulled
 * through the real proxy, transport, host service and link sessions over an
 * emulated link, one slice at a time (as before pull depths) and pipelined.
 *
 * Opt-in: `DAINTREE_REMOTE_PREVIEW_BENCH=1 npm test -- <this file>`. Knobs:
 * `…_DELAYS` (one-way ms, default `0,5,20`), `…_DEPTHS` (default `1,2`),
 * `…_RATE_MBPS` (link rate each way, unlimited by default), `…_RUNS`
 * (default 3, the median is reported) and `…_OUT` (a JSON file for the raw
 * samples). A socket mechanism measurement: it says how long the transport
 * takes to deliver verified bytes, not how long a PDF takes to paint.
 */

const ENV = "DAINTREE_REMOTE_PREVIEW_BENCH";
const BENCH = process.env[ENV] === "1";
const MiB = 1024 * 1024;

function listOf(name: string, fallback: number[]): number[] {
  const raw = process.env[`${ENV}_${name}`];
  if (!raw) return fallback;
  return raw.split(",").map((value) => Number(value.trim()));
}

const DELAYS = listOf("DELAYS", [0, 5, 20]);
const DEPTHS = listOf("DEPTHS", [1, 2]);
const RUNS = Number(process.env[`${ENV}_RUNS`] ?? 3);
const RATE_MBPS = process.env[`${ENV}_RATE_MBPS`]
  ? Number(process.env[`${ENV}_RATE_MBPS`])
  : null;

const FIXTURES = [
  { name: "image.png", scheme: "daintree-file" as const, size: 25 * MiB },
  { name: "document.pdf", scheme: "daintree-pdf" as const, size: 50 * MiB },
];

class BenchEndpoint implements HostFileEndpoint {
  readonly endpointId = "session-1:view-7";
  readonly clientEndpointId = "view-7";
  readonly clientId = "client-a";
  readonly projectId = "p1";
  isClosed() {
    return false;
  }
  onClose() {
    return { dispose: () => {} };
  }
}

interface Sample {
  fixture: string;
  delayMs: number;
  depth: number;
  ttfbMs: number;
  ttlbMs: number;
  hostSlicePeakBytes: number;
  hostPreviewBufferBytes: number;
  clientPeakBytes: number;
  echoP50Ms: number;
  echoP95Ms: number;
  echoMaxMs: number;
  echoSamples: number;
  idleEchoP50Ms: number;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function median(values: number[]): number {
  return percentile(values, 50);
}

let dir: string;
let socketDir: string;
const hashes = new Map<string, string>();

beforeAll(async () => {
  if (!BENCH) return;
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hf-bench-")));
  socketDir = await makeTempDir();
  for (const fixture of FIXTURES) {
    // Real headers, random bodies: nothing on the path parses them, and random
    // bytes can't be made smaller by anything along the way.
    const bytes = crypto.randomBytes(fixture.size);
    const header = fixture.name.endsWith(".pdf")
      ? Buffer.from("%PDF-1.7\n")
      : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    header.copy(bytes);
    await fs.writeFile(path.join(dir, fixture.name), bytes);
    hashes.set(fixture.name, crypto.createHash("sha256").update(bytes).digest("hex"));
  }
}, 120_000);

afterAll(async () => {
  if (!BENCH) return;
  await removeTempDir(socketDir);
  await fs.rm(dir, { recursive: true, force: true });
});

async function measure(
  fixture: (typeof FIXTURES)[number],
  delayMs: number,
  depth: number
): Promise<Sample> {
  const conditions: LinkConditions = {
    oneWayDelayMs: delayMs,
    ...(RATE_MBPS !== null ? { bytesPerSecond: (RATE_MBPS * 1_000_000) / 8 } : {}),
  };
  const { host, client } = await openSessionPair(socketDir, {}, {}, conditions);
  const endpoint = new BenchEndpoint();
  const service = new HostFileService({
    rootsFor: async () => [dir],
    isDriving: () => true,
  });
  try {
    service.attach(host, endpoint);
    const transport = new ClientFileTransport({ pullDepth: depth });
    transport.noteEndpointOpened("bench", { session: client, webContentsId: 7, endpointId: "view-7" });
    const capabilities = new ViewFileCapabilities(() => () => {});
    const cap = capabilities.capabilityFor(7);
    const proxy = createHostFileProxy(transport, {
      viewForCapability: (token) => capabilities.viewFor(token),
      hostForView: () => "bench",
    });

    // Bytes of slices the host is sending (hashed and held until acknowledged).
    let hostSliceBytes = 0;
    let hostSlicePeakBytes = 0;
    let hostPreviewBufferBytes = 0;
    const send = host.transfers.send.bind(host.transfers);
    vi.spyOn(host.transfers, "send").mockImplementation(async (source, options) => {
      hostSliceBytes += source.size;
      hostSlicePeakBytes = Math.max(hostSlicePeakBytes, hostSliceBytes);
      hostPreviewBufferBytes = Math.max(hostPreviewBufferBytes, service.heldBufferedBytes);
      try {
        return await send(source, options);
      } finally {
        hostSliceBytes -= source.size;
      }
    });
    let body: HostFileBody | null = null;
    const openBody = transport.openBody.bind(transport);
    vi.spyOn(transport, "openBody").mockImplementation((...args) => {
      body = openBody(...args);
      return body;
    });

    // A keystroke's echo on the same link: in on the interactive lane, straight back out.
    let seq = 0;
    host.on(Lane.INTERACTIVE, InteractiveKind.TERMINAL_IN, (message) => {
      host.post({
        lane: Lane.INTERACTIVE,
        kind: InteractiveKind.TERMINAL_OUT,
        body: {
          endpointId: message.endpointId,
          terminalId: "t-echo",
          incarnation: 1,
          seq: ++seq,
          message: message.message,
        },
      });
    });
    const waiting = new Map<string, () => void>();
    client.on(Lane.INTERACTIVE, InteractiveKind.TERMINAL_OUT, (message) => {
      const key = String(message.message);
      waiting.get(key)?.();
      waiting.delete(key);
    });
    let keyCount = 0;
    const keystroke = async (): Promise<number> => {
      const key = `k${keyCount++}`;
      const echoed = new Promise<void>((resolve) => waiting.set(key, resolve));
      const started = performance.now();
      client.post({
        lane: Lane.INTERACTIVE,
        kind: InteractiveKind.TERMINAL_IN,
        body: { endpointId: "view-7", message: key },
      });
      await echoed;
      return performance.now() - started;
    };
    const idle: number[] = [];
    for (let i = 0; i < 10; i++) idle.push(await keystroke());

    let loading = true;
    const echoes: number[] = [];
    const typing = (async () => {
      while (loading) {
        echoes.push(await keystroke());
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();

    const started = performance.now();
    const response = await proxy(
      fixture.scheme,
      { hostId: "bench", viewCapability: cap },
      new Request(
        `${fixture.scheme}://host/bench/load?path=${encodeURIComponent(
          path.join(dir, fixture.name)
        )}&root=${encodeURIComponent(dir)}`
      )
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const hash = crypto.createHash("sha256");
    let ttfbMs = Number.NaN;
    let received = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (received === 0) ttfbMs = performance.now() - started;
      received += next.value.byteLength;
      hash.update(next.value);
    }
    const ttlbMs = performance.now() - started;
    loading = false;
    await typing;

    expect(received).toBe(fixture.size);
    expect(hash.digest("hex")).toBe(hashes.get(fixture.name));
    return {
      fixture: fixture.name,
      delayMs,
      depth,
      ttfbMs,
      ttlbMs,
      hostSlicePeakBytes,
      hostPreviewBufferBytes,
      clientPeakBytes: (body as HostFileBody | null)?.peakBufferedBytes ?? Number.NaN,
      echoP50Ms: percentile(echoes, 50),
      echoP95Ms: percentile(echoes, 95),
      echoMaxMs: percentile(echoes, 100),
      echoSamples: echoes.length,
      idleEchoP50Ms: percentile(idle, 50),
    };
  } finally {
    vi.restoreAllMocks();
    service.dispose();
    host.close("bench done");
    client.close("bench done");
  }
}

describe.runIf(BENCH)("remote preview transport bench", () => {
  it(
    "measures time to first and last byte, buffered bytes and echo latency, per delay and depth",
    async () => {
      const samples: Sample[] = [];
      for (const delayMs of DELAYS) {
        for (const fixture of FIXTURES) {
          // Arms alternate run by run so drift on the machine lands on both.
          for (let run = 0; run < RUNS; run++) {
            for (const depth of DEPTHS) samples.push(await measure(fixture, delayMs, depth));
          }
        }
      }

      const rows: string[] = [
        `[remote-preview-bench] rate ${RATE_MBPS === null ? "unlimited" : `${RATE_MBPS} Mbit/s`}, median of ${RUNS}`,
        "| fixture | one-way delay | depth | TTFB ms | TTLB ms | host slice peak MiB | host preview buffer MiB | client peak MiB | echo p50/p95/max ms (n) | idle echo p50 ms |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ];
      for (const delayMs of DELAYS) {
        for (const fixture of FIXTURES) {
          for (const depth of DEPTHS) {
            const cell = samples.filter(
              (s) => s.delayMs === delayMs && s.fixture === fixture.name && s.depth === depth
            );
            const m = (pick: (s: Sample) => number) => median(cell.map(pick));
            const mib = (bytes: number) => (bytes / MiB).toFixed(1);
            rows.push(
              `| ${fixture.name} | ${delayMs} ms | ${depth} | ${m((s) => s.ttfbMs).toFixed(0)} | ${m((s) => s.ttlbMs).toFixed(0)} | ${mib(m((s) => s.hostSlicePeakBytes))} | ${mib(m((s) => s.hostPreviewBufferBytes))} | ${mib(m((s) => s.clientPeakBytes))} | ${m((s) => s.echoP50Ms).toFixed(1)}/${m((s) => s.echoP95Ms).toFixed(1)}/${m((s) => s.echoMaxMs).toFixed(1)} (${m((s) => s.echoSamples)}) | ${m((s) => s.idleEchoP50Ms).toFixed(1)} |`
            );
          }
        }
      }
      // vitest.config drops console output; whoever runs the bench reads stdout.
      process.stdout.write(`${rows.join("\n")}\n`);
      const out = process.env[`${ENV}_OUT`];
      if (out) {
        await fs.writeFile(
          out,
          JSON.stringify({ rateMbps: RATE_MBPS, runs: RUNS, node: process.version, samples }, null, 2)
        );
      }
    },
    30 * 60_000
  );
});
