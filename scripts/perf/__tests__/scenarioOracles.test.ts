import { describe, expect, it } from "vitest";
import {
  makeTerminalStream,
  simulateTerminalOutputPass,
  terminalOutputPassMisses,
  type TerminalOutputPassResult,
} from "../lib/workloads";
import type { AgentAnalysisSimResult } from "../lib/agentAnalysisSim";
import { analysisSweepMisses } from "../scenarios/agentAnalysis";
import { leakWorkloadMisses } from "../scenarios/soak";

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
