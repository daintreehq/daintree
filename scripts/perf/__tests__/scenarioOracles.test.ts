import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, promises as fsPromises, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeTerminalStream,
  simulateTerminalOutputPass,
  terminalOutputPassMisses,
  type TerminalOutputPassResult,
} from "../lib/workloads";
import type { AgentAnalysisSimResult } from "../lib/agentAnalysisSim";
import { analysisSweepMisses } from "../scenarios/agentAnalysis";
import { leakWorkloadMisses } from "../scenarios/soak";
import {
  BINARY_SNIFF_BYTES,
  firstSightingReadMisses,
  observeUntrackedReads,
  type FixtureFile,
  type UntrackedBinaryFixture,
} from "../lib/untrackedBinaryFixture";

/**
 * The three predicates a review found were satisfiable by a subject that did
 * nothing. Each test below stubs the subject exactly that way — a pass that
 * consumed nothing, a sweep that analysed nothing, an allocator that allocated
 * empty records beside a sampler that reported a constant — and asserts the
 * predicate says so.
 */

const LEAK_SAMPLE_CYCLES = 40;
const LEAK_TRANSIENTS_PER_CYCLE = 600;
const LEAK_PAYLOAD_CHARS = 64;

function healthySweep(agents: number): AgentAnalysisSimResult {
  return {
    agents,
    fedBytes: 4096 * agents,
    virtualMs: 20_000,
    wallMs: 100,
    cpuMs: 50,
    cpuMsPerMb: 12,
    cpuMsPerAgentSecond: 0.1,
    waitFlipLatencyMs: 8000,
    resumeFlipLatencyMs: 900,
    stateChangeRecords: agents * 3,
    agentsWithWaitFlip: agents,
    agentsWithResumeFlip: agents,
    scriptedBytes: 4096 * agents,
  };
}

function leakObservation() {
  const retained: Array<{ id: string; data: string }> = [];
  let payloadChars = 0;
  const heapSamples: number[] = [];
  for (let cycle = 0; cycle < LEAK_SAMPLE_CYCLES; cycle += 1) {
    for (let index = 0; index < LEAK_TRANSIENTS_PER_CYCLE; index += 1) {
      const id = `${cycle}-${index}`;
      const data = id.padEnd(LEAK_PAYLOAD_CHARS, "-leak-payload");
      retained.push({ id, data });
      payloadChars += data.length;
    }
    if (cycle % 4 === 0) heapSamples.push(100 + cycle * 0.25);
  }
  return { retained, payloadChars, heapSamples };
}

describe("terminalOutputPassMisses", () => {
  const stream = makeTerminalStream(400, 90);

  it("clears on a pass that walked every chunk", () => {
    const result = simulateTerminalOutputPass(stream.chunks, 250);
    expect(terminalOutputPassMisses(stream, 250, result)).toBe(0);
  });

  it("scores a pass that consumed nothing but posted the best possible numbers", () => {
    const noop: TerminalOutputPassResult = {
      renderedBytes: 0,
      retainedBytes: 0,
      checksum: 0,
      consumedChunks: 0,
      retainedLineCount: 0,
    };
    expect(terminalOutputPassMisses(stream, 250, noop)).toBeGreaterThan(0);
  });

  it("scores a pass that skipped bytes while keeping its chunk tally", () => {
    const partial = simulateTerminalOutputPass(stream.chunks, 250);
    expect(terminalOutputPassMisses(stream, 250, { ...partial, renderedBytes: 1 })).toBeGreaterThan(
      0
    );
  });

  it("takes its byte expectation from the generator, not from the result", () => {
    // The scenarios wall-clock the whole run(), so the oracle must not re-walk
    // the chunks to work out what it expects.
    let expectedBytes = 0;
    for (const chunk of stream.chunks) expectedBytes += chunk.length;
    expect(stream.totalBytes).toBe(expectedBytes);
  });
});

describe("analysisSweepMisses", () => {
  it("clears on a sweep where every agent produced both canonical flips", () => {
    expect(analysisSweepMisses(30, healthySweep(30))).toBe(0);
  });

  it("scores a sweep that reports zeros, which used to agree with itself", () => {
    const zeroed: AgentAnalysisSimResult = {
      ...healthySweep(0),
      cpuMs: 0,
      cpuMsPerMb: 0,
      cpuMsPerAgentSecond: 0,
      waitFlipLatencyMs: 0,
      resumeFlipLatencyMs: 0,
      stateChangeRecords: 0,
      fedBytes: 0,
      scriptedBytes: 0,
    };
    expect(analysisSweepMisses(30, zeroed)).toBeGreaterThan(0);
  });

  it("scores a fleet where only some agents were detected", () => {
    expect(
      analysisSweepMisses(30, { ...healthySweep(30), agentsWithResumeFlip: 29 })
    ).toBeGreaterThan(0);
  });

  it("scores a feed loop that stopped short of the scripted workload", () => {
    // fedBytes is the denominator of every rate, so a shrunken workload would
    // report a lower tax rather than a shorter run.
    expect(analysisSweepMisses(30, { ...healthySweep(30), fedBytes: 1000 })).toBeGreaterThan(0);
  });
});

describe("leakWorkloadMisses", () => {
  it("clears on the workload the scenario actually runs", () => {
    expect(leakWorkloadMisses(leakObservation())).toBe(0);
  });

  it("scores records allocated empty, which cost nothing to keep", () => {
    const observed = leakObservation();
    expect(
      leakWorkloadMisses({
        ...observed,
        payloadChars: 0,
        retained: observed.retained.map(() => ({ id: "", data: "" })),
      })
    ).toBeGreaterThan(0);
  });

  it("scores a sampler that reported a constant instead of reading the heap", () => {
    const observed = leakObservation();
    expect(
      leakWorkloadMisses({ ...observed, heapSamples: observed.heapSamples.map(() => 100) })
    ).toBeGreaterThan(0);
  });

  it("scores a run that dropped each cycle's records before the next reading", () => {
    const observed = leakObservation();
    expect(leakWorkloadMisses({ ...observed, retained: [] })).toBeGreaterThan(0);
  });

  it("scores interval samples that were never taken", () => {
    expect(leakWorkloadMisses({ ...leakObservation(), heapSamples: [1, 2] })).toBeGreaterThan(0);
  });
});

describe("firstSightingReadMisses (PERF-113)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "perf113-oracle-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const files: Array<[string, Buffer, boolean]> = [
    ["one-byte.bin", Buffer.from([0]), true],
    // Two binaries of one size, so a skipped one and a twice-read one balance out in totals.
    ["a.bin", Buffer.concat([Buffer.from([0]), Buffer.alloc(20_000, 7)]), true],
    ["b.bin", Buffer.concat([Buffer.from([0]), Buffer.alloc(20_000, 9)]), true],
    ["notes.txt", Buffer.from("a\nb\n"), false],
  ];
  const untracked = new Map<string, FixtureFile>();
  for (const [rel, content, binary] of files) {
    const abs = join(root, rel);
    writeFileSync(abs, content);
    untracked.set(abs, { rel, content, insertions: binary ? null : 2, binary, batch: false });
  }
  const fixture = { root, repoPath: root, untracked } as UntrackedBinaryFixture;
  const binaries = [...untracked].filter(([, file]) => file.binary).map(([abs]) => abs);

  async function sniff(abs: string): Promise<void> {
    const handle = await fsPromises.open(abs, "r");
    try {
      const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, bytesRead).indexOf(0) === -1) await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async function observe(subject: () => Promise<void>): Promise<number> {
    const reads = observeUntrackedReads(fixture);
    try {
      await subject();
      return firstSightingReadMisses(fixture, reads.take());
    } finally {
      reads.dispose();
    }
  }

  it("clears on a pass that sniffed every file once", async () => {
    const misses = await observe(async () => {
      await Promise.all([...untracked.keys()].map(sniff));
    });
    expect(misses).toBe(0);
  });

  it("scores every binary when the pass read each one whole", async () => {
    const misses = await observe(async () => {
      for (const abs of untracked.keys()) await fsPromises.readFile(abs);
    });
    expect(misses).toBe(binaries.length);
  });

  it("scores every binary when the observer saw nothing", async () => {
    expect(await observe(async () => {})).toBe(binaries.length);
  });

  it("scores a skipped binary and a twice-read one even when the totals balance", async () => {
    const [oneByte, , b] = binaries;
    const misses = await observe(async () => {
      await sniff(oneByte);
      await sniff(b);
      await sniff(b);
    });
    expect(misses).toBe(2);
  });

  it("scores a sniff followed by a whole read through the path", async () => {
    const misses = await observe(async () => {
      for (const abs of binaries) await sniff(abs);
      await fsPromises.readFile(binaries[1]);
    });
    expect(misses).toBe(1);
  });

  it.each([
    ["the handle's own readFile", (handle: FileHandle) => handle.readFile()],
    ["fs.promises.readFile given the handle", (handle: FileHandle) => fsPromises.readFile(handle)],
  ])("scores a sniff followed by a whole read through %s", async (_name, readWhole) => {
    const misses = await observe(async () => {
      for (const abs of binaries.slice(0, 2)) await sniff(abs);
      const handle = await fsPromises.open(binaries[2], "r");
      try {
        await handle.read(Buffer.alloc(BINARY_SNIFF_BYTES), 0, BINARY_SNIFF_BYTES, 0);
        await readWhole(handle);
      } finally {
        await handle.close();
      }
    });
    expect(misses).toBe(1);
  });

  it("scores a binary read past its sniff through one handle", async () => {
    const misses = await observe(async () => {
      for (const abs of binaries.slice(0, 2)) await sniff(abs);
      const handle = await fsPromises.open(binaries[2], "r");
      try {
        const span = BINARY_SNIFF_BYTES * 2;
        await handle.read(Buffer.alloc(span), 0, span, 0);
      } finally {
        await handle.close();
      }
    });
    expect(misses).toBe(1);
  });

  it("scores a binary opened a second time without reading", async () => {
    const misses = await observe(async () => {
      for (const abs of binaries) await sniff(abs);
      await (await fsPromises.open(binaries[1], "r")).close();
    });
    expect(misses).toBe(1);
  });
});
