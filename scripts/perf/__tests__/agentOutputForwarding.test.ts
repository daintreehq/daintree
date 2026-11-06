import { describe, expect, it } from "vitest";
import { OSC_11_QUERY } from "../lib/ptyOutputPipelineFixture";
import {
  buildForwardingFleet,
  cohortCounts,
  forwardingMisses,
  runForwardingFleet,
  type ForwardingFleetObservation,
  type ForwardingFleetPlan,
} from "../lib/agentOutputForwardingFixture";

/**
 * PERF-037 counts the agent:output messages the PTY host hands to Main. These
 * tests pin what the fleet actually does today, then break each predicate on
 * purpose and assert it notices.
 */

function smallFleet(): ForwardingFleetPlan {
  return buildForwardingFleet({
    streamTerminals: 2,
    streamBytes: 12 * 1024,
    floodBytes: 64 * 1024,
    boundFloodBytes: 16 * 1024,
  });
}

/** A copy whose per-terminal records can be mutated without touching the run. */
function clone(observed: ForwardingFleetObservation): ForwardingFleetObservation {
  return {
    strayMessages: observed.strayMessages,
    terminals: observed.terminals.map((terminal) => ({ ...terminal })),
  };
}

function indexOf(plan: ForwardingFleetPlan, cohort: string): number {
  return plan.terminals.findIndex((terminal) => terminal.cohort === cohort);
}

describe("PERF-037 fleet plan", () => {
  it("floods in exact 2 KiB chunks and streams in 1-4 K-character chunks, in arrival order", () => {
    const plan = smallFleet();
    const flood = plan.terminals[indexOf(plan, "unboundFlood")]!;
    expect(flood.frames.length).toBe(32);
    expect(flood.frames.every((frame) => Buffer.byteLength(frame.text) === 2048)).toBe(true);

    for (const terminal of plan.terminals) {
      expect(terminal.frames.map((frame) => frame.text).join("")).toBe(terminal.stream);
      expect(terminal.arrivalsMs).toHaveLength(terminal.frames.length);
      const sorted = [...terminal.arrivalsMs].sort((a, b) => a - b);
      expect(terminal.arrivalsMs).toEqual(sorted);
    }

    const stream = plan.terminals[indexOf(plan, "unboundStream")]!;
    for (const frame of stream.frames.slice(0, -1)) {
      const text = frame.expectsOscResponse ? frame.text.slice(OSC_11_QUERY.length) : frame.text;
      expect(text.length).toBeGreaterThanOrEqual(1024);
      expect(text.length).toBeLessThanOrEqual(4096);
    }
    // Answered queries ride the raw stream and leave the renderer's copy.
    const queries = stream.frames.filter((frame) => frame.expectsOscResponse).length;
    expect(queries).toBeGreaterThan(0);
    expect(stream.rendererChars).toBe(stream.stream.length - queries * OSC_11_QUERY.length);
  });

  it("gives every terminal output no other terminal in the fleet produces", () => {
    const plan = smallFleet();
    const streams = plan.terminals.map((terminal) => terminal.stream);
    expect(new Set(streams).size).toBe(streams.length);
  });

  it("marks only the bound cohorts as Assistant terminals", () => {
    const plan = smallFleet();
    for (const terminal of plan.terminals) {
      expect(terminal.isAssistantTerminal).toBe(terminal.cohort.startsWith("bound"));
    }
  });
});

describe("PERF-037 run", () => {
  it("forwards an Assistant terminal's output whole and nothing from any other terminal", async () => {
    const plan = smallFleet();
    const observed = await runForwardingFleet(plan);

    expect(forwardingMisses(plan, observed)).toEqual({
      rendererDeliveryMisses: 0,
      outputRingMisses: 0,
      boundPayloadMisses: 0,
      unboundPayloadMisses: 0,
      attributionMisses: 0,
    });
    expect(cohortCounts(plan, observed, ["unboundStream", "unboundFlood"])).toMatchObject({
      messages: 0,
      forwardedBytes: 0,
    });

    const boundFlood = plan.terminals[indexOf(plan, "boundFlood")]!;
    const boundFloodCounts = cohortCounts(plan, observed, ["boundFlood"]);
    // Every 2 KiB chunk crosses the 2,000-char size trigger on arrival.
    expect(boundFloodCounts.messages).toBe(boundFlood.frames.length);
    expect(boundFloodCounts.forwardedBytes).toBe(boundFlood.ptyBytes);
    expect(boundFloodCounts.messagesPerMiB).toBe(512);

    const boundStream = plan.terminals[indexOf(plan, "boundStream")]!;
    const boundStreamCounts = cohortCounts(plan, observed, ["boundStream"]);
    // Batching never splits a chunk, and the raw stream arrives whole.
    expect(boundStreamCounts.messages).toBeGreaterThan(0);
    expect(boundStreamCounts.messages).toBeLessThanOrEqual(boundStream.frames.length);
    expect(boundStreamCounts.forwardedBytes).toBe(boundStream.ptyBytes);
  });

  it("restores the real clock even when the run throws", async () => {
    const before = Date.now;
    const plan = smallFleet();
    plan.terminals[0]!.frames[1] = undefined as never;

    await expect(runForwardingFleet(plan)).rejects.toThrow();
    expect(Date.now).toBe(before);
  });
});

describe("PERF-037 predicates notice a broken path", () => {
  async function baseline(): Promise<[ForwardingFleetPlan, ForwardingFleetObservation]> {
    const plan = smallFleet();
    return [plan, await runForwardingFleet(plan)];
  }

  it("fails an Assistant terminal that lost, reordered or duplicated a chunk", async () => {
    const [plan, observed] = await baseline();
    const bound = indexOf(plan, "boundStream");
    const frames = plan.terminals[bound]!.frames.map((frame) => frame.text);

    const dropped = clone(observed);
    dropped.terminals[bound]!.forwarded = frames.slice(1).join("");
    expect(forwardingMisses(plan, dropped).boundPayloadMisses).toBe(1);

    const reordered = clone(observed);
    reordered.terminals[bound]!.forwarded = [frames[1], frames[0], ...frames.slice(2)].join("");
    expect(forwardingMisses(plan, reordered).boundPayloadMisses).toBe(1);

    const duplicated = clone(observed);
    duplicated.terminals[bound]!.forwarded = [frames[0], ...frames].join("");
    expect(forwardingMisses(plan, duplicated).boundPayloadMisses).toBe(1);

    // The renderer's copy, with the answered colour queries stripped.
    const rendererCopy = clone(observed);
    rendererCopy.terminals[bound]!.forwarded = frames.join("").split(OSC_11_QUERY).join("");
    expect(forwardingMisses(plan, rendererCopy).boundPayloadMisses).toBe(1);
  });

  it("fails output emitted under another fleet terminal's id", async () => {
    const [plan, observed] = await baseline();
    const first = plan.terminals.findIndex((terminal) => terminal.cohort === "unboundStream");
    const second = plan.terminals.findIndex(
      (terminal, index) => index > first && terminal.cohort === "unboundStream"
    );

    // Each forwarding all of its output, but under the other's id.
    const swapped = clone(observed);
    swapped.terminals[first]!.forwarded = plan.terminals[second]!.stream;
    swapped.terminals[second]!.forwarded = plan.terminals[first]!.stream;
    expect(forwardingMisses(plan, swapped).unboundPayloadMisses).toBe(2);
  });

  it("accepts an ordinary terminal forwarding all of its output or none, and nothing between", async () => {
    const [plan, observed] = await baseline();
    const unbound = indexOf(plan, "unboundStream");

    const legacy = clone(observed);
    legacy.terminals[unbound]!.forwarded = plan.terminals[unbound]!.stream;
    expect(forwardingMisses(plan, legacy).unboundPayloadMisses).toBe(0);

    const partial = clone(observed);
    partial.terminals[unbound]!.forwarded = plan.terminals[unbound]!.frames[0]!.text;
    expect(forwardingMisses(plan, partial).unboundPayloadMisses).toBe(1);
  });

  it("fails output attributed to the wrong agent or to a terminal outside the fleet", async () => {
    const [plan, observed] = await baseline();

    const wrongAgent = clone(observed);
    wrongAgent.terminals[indexOf(plan, "boundFlood")]!.agentIdMisses = 2;
    expect(forwardingMisses(plan, wrongAgent).attributionMisses).toBe(2);

    const stray = clone(observed);
    stray.strayMessages = 1;
    expect(forwardingMisses(plan, stray).attributionMisses).toBe(1);
  });

  it("fails a renderer that missed a chunk and a ring that lost the tail", async () => {
    const [plan, observed] = await baseline();
    const flood = indexOf(plan, "unboundFlood");

    const shortRenderer = clone(observed);
    shortRenderer.terminals[flood]!.emitCalls -= 1;
    shortRenderer.terminals[flood]!.emittedChars -= 2048;
    expect(forwardingMisses(plan, shortRenderer).rendererDeliveryMisses).toBe(2);

    const staleRing = clone(observed);
    staleRing.terminals[flood]!.outputTail = "";
    expect(forwardingMisses(plan, staleRing).outputRingMisses).toBe(1);
  });
});
