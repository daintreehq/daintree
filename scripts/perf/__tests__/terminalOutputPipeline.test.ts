import { describe, expect, it } from "vitest";
import { terminalScenarios } from "../scenarios/terminal";
import {
  buildPipelinePlan,
  pipelinePassMisses,
  runPipelinePlan,
  type PipelineObservation,
  type PipelinePlan,
} from "../lib/ptyOutputPipelineFixture";

/**
 * PERF-030/031/032 drive the real `PtyDataPipeline`. These tests break each
 * half of the two-sided halves on purpose and assert the predicate notices —
 * the review obligation the harness cannot enforce mechanically.
 */

const CONTEXT = { mode: "ci" as const, now: () => performance.now() };

function smallPlan(): PipelinePlan {
  return buildPipelinePlan({
    chunks: 120,
    linesPerChunk: 3,
    oscEvery: 17,
    promptEvery: 13,
    seed: 7,
  });
}

/** What a pipeline that stopped doing anything per chunk would report. */
function deadPipeline(plan: PipelinePlan): PipelineObservation {
  return {
    emitCalls: 0,
    emittedChars: 0,
    analysisFeeds: 0,
    snapshotSchedules: 0,
    agentQueueCalls: 0,
    agentQueueChars: 0,
    agentQueueIdMisses: 0,
    firstByteStampMisses: plan.frames.length,
    lastOutputStampMisses: plan.frames.length,
    oscResponses: 0,
    oscStripLeaks: 0,
    oscOverStrips: 0,
    promptReturns: 0,
    promptReturnsMissed: plan.expectedPromptReturns,
    promptReturnsSpurious: 0,
    forensicTail: "",
    outputTail: "",
    semanticLines: [],
    chunksFed: 0,
  };
}

describe("terminal output pipeline scenarios", () => {
  for (const id of ["PERF-030", "PERF-031", "PERF-032"]) {
    it(`${id} emits every declared predicate and reports zero misses`, async () => {
      const scenario = terminalScenarios.find((candidate) => candidate.id === id);
      expect(scenario).toBeDefined();

      const sample = await scenario!.run(CONTEXT);
      const metrics = sample.metrics ?? {};
      for (const name of scenario!.correctness ?? []) {
        expect(name in metrics, `${id} did not emit ${name}`).toBe(true);
        expect(metrics[name], `${id} reported ${name}=${metrics[name]}`).toBe(0);
      }
    });
  }

  it("PERF-030..032 report a non-trivial amount of retained state", async () => {
    // A pipeline whose rings held nothing would be the fastest pipeline there
    // is, so the scenarios report what was actually retained alongside the
    // predicate.
    const scenario = terminalScenarios.find((candidate) => candidate.id === "PERF-032");
    const sample = await scenario!.run(CONTEXT);
    expect(sample.metrics!.retainedBytes).toBeGreaterThan(0);
    expect(sample.metrics!.semanticLineCount).toBeGreaterThan(0);
  });
});

describe("pipeline correctness predicate", () => {
  it("scores zero against the real pipeline", () => {
    const plan = smallPlan();
    const misses = pipelinePassMisses(plan, runPipelinePlan(plan));
    expect(Object.values(misses).every((value) => value === 0)).toBe(true);
  });

  it("catches a pipeline that does nothing per chunk", () => {
    const plan = smallPlan();
    const misses = pipelinePassMisses(plan, deadPipeline(plan));
    expect(misses.forwardMisses).toBe(plan.frames.length);
    expect(misses.analysisFeedMisses).toBe(plan.frames.length);
    expect(misses.snapshotScheduleMisses).toBe(plan.frames.length);
    expect(misses.agentQueueMisses).toBe(plan.frames.length);
    // The agent ring's payload and the timestamp bookkeeping, both of which a
    // dead pipeline stops producing entirely.
    expect(misses.agentQueuePayloadMisses).toBe(plan.totalChars);
    expect(misses.outputStampMisses).toBe(plan.frames.length * 2);
    expect(misses.oscResponseMisses).toBe(plan.expectedOscResponses);
    expect(misses.promptReturnMisses).toBe(plan.expectedPromptReturns);
    expect(misses.forensicRingMisses).toBe(1);
    expect(misses.outputRingMisses).toBe(1);
    expect(misses.semanticRingMisses).toBeGreaterThan(0);
  });

  it("catches a ring that stops trimming", () => {
    const plan = smallPlan();
    const observed = runPipelinePlan(plan);
    expect(pipelinePassMisses(plan, observed).forensicRingMisses).toBe(0);
    // An untrimmed ring holds the whole stream, not its tail.
    const untrimmed = { ...observed, forensicTail: plan.stream, outputTail: plan.stream };
    const misses = pipelinePassMisses(plan, untrimmed);
    expect(misses.forensicRingMisses).toBe(1);
    expect(misses.outputRingMisses).toBe(1);
  });

  it("catches a ring that drops the newest chunk", () => {
    const plan = smallPlan();
    const observed = runPipelinePlan(plan);
    const stale = {
      ...observed,
      forensicTail: observed.forensicTail.slice(0, -20),
      outputTail: observed.outputTail.slice(0, -20),
    };
    const misses = pipelinePassMisses(plan, stale);
    expect(misses.forensicRingMisses).toBe(1);
    expect(misses.outputRingMisses).toBe(1);
  });
});

describe("the agent output queue and the timestamp marks are graded", () => {
  it("grades getLiveAgentId's answer, not just that it was called", () => {
    // The plan plants a detected agent that disagrees with launch affinity, so
    // the id the pipeline queued is evidence of the precedence rule rather than
    // of a constant. A queue callback that discarded the id — which is what it
    // used to do — leaves this term unable to see the difference.
    const plan = smallPlan();
    const observed = runPipelinePlan(plan);
    expect(observed.agentQueueIdMisses).toBe(0);
    expect(observed.agentQueueChars).toBe(plan.totalChars);
    expect(pipelinePassMisses(plan, observed).agentQueuePayloadMisses).toBe(0);

    // A pipeline that queued the launch id instead of the detected one.
    const wrongAgent = { ...observed, agentQueueIdMisses: plan.frames.length };
    expect(pipelinePassMisses(plan, wrongAgent).agentQueuePayloadMisses).toBe(plan.frames.length);
    // One that queued the renderer-bound copy, short by every stripped query.
    const strippedCopy = { ...observed, agentQueueChars: observed.agentQueueChars - 42 };
    expect(pipelinePassMisses(plan, strippedCopy).agentQueuePayloadMisses).toBe(42);
  });

  it("grades firstByteAt as one-shot and lastOutputTime as per-chunk", () => {
    const plan = smallPlan();
    const observed = runPipelinePlan(plan);
    expect(observed.firstByteStampMisses).toBe(0);
    expect(observed.lastOutputStampMisses).toBe(0);
    expect(pipelinePassMisses(plan, observed).outputStampMisses).toBe(0);

    // A mark that is never stamped, and one that is re-stamped every chunk:
    // the fixture reports both as firstByteStampMisses, and either is a
    // deletion of the bookkeeping `handlePtyData` does before the pipeline.
    const noMark = { ...observed, firstByteStampMisses: 1 };
    expect(pipelinePassMisses(plan, noMark).outputStampMisses).toBe(1);
    const noStamp = { ...observed, lastOutputStampMisses: plan.frames.length };
    expect(pipelinePassMisses(plan, noStamp).outputStampMisses).toBe(plan.frames.length);
  });
});

describe("pipeline decoy halves are live", () => {
  it("the OSC decoy would be caught if the product answered it", () => {
    // Turn every planted OSC 12 decoy into a real OSC 11 query. The product now
    // answers AND strips them, which is exactly the over-eager responder the
    // decoy exists to catch — so both counters must move.
    const plan = smallPlan();
    for (const frame of plan.frames) {
      if (frame.oscDecoy !== undefined) {
        frame.text = frame.text.replace("\x1b]12;?\x07", "\x1b]11;?\x07");
      }
    }
    const observed = runPipelinePlan(plan);
    expect(observed.oscResponses).toBeGreaterThan(plan.expectedOscResponses);
    expect(pipelinePassMisses(plan, observed).oscStripMisses).toBeGreaterThan(0);
  });

  it("the prompt decoy would be caught if the product demoted on it", () => {
    // Drop the `command not found` line the decoy relies on. The prompt is now
    // an ordinary returned prompt, the product demotes, and the spurious half
    // of the predicate has to speak.
    const plan = smallPlan();
    expect(plan.expectedPromptDecoys).toBeGreaterThan(0);
    for (const frame of plan.frames) {
      if (frame.promptDecoy) {
        frame.text = frame.text.replace("zsh: command not found: buildd\r\n", "");
      }
    }
    const observed = runPipelinePlan(plan);
    expect(observed.promptReturnsSpurious).toBe(plan.expectedPromptDecoys);
    expect(pipelinePassMisses(plan, observed).promptReturnMisses).toBeGreaterThan(0);
  });
});
