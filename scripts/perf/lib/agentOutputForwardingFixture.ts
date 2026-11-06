import { AgentOutputForwarder } from "../../../electron/services/pty/AgentOutputForwarder";
import { events } from "../../../electron/services/events";
import { OUTPUT_BUFFER_SIZE } from "../../../electron/services/pty/types";
import { VirtualClock } from "./agentAnalysisSim";
import {
  createPipelineHarness,
  EXPECTED_LIVE_AGENT_ID,
  OSC_11_QUERY,
  type PipelineFrame,
  type PipelineHarness,
} from "./ptyOutputPipelineFixture";

/**
 * Fixture for PERF-037: how much raw agent output the PTY host hands to Main.
 *
 * Every terminal runs through the real `PtyDataPipeline` (the PERF-030 harness,
 * with its real retention rings and identity watcher) and queues into a real
 * `AgentOutputForwarder`, whose `agent:output` emits are counted on the real
 * event bus. That bus is the exact stream `pty-host.ts` forwards to Main, one
 * message per emit, so the counts are what Main would receive.
 *
 * Time is virtual. The forwarder flushes on a 50 ms timer or when its pending
 * text reaches `OUTPUT_BUFFER_SIZE`, so how many messages a stream becomes
 * depends on when its chunks arrive. Arrivals are scheduled from a declared
 * rate and the `VirtualClock` fires the forwarder's own timer between them,
 * which makes the counts deterministic and comparable across machines.
 */

const MIB = 1024 * 1024;

/** An agent streaming an answer: node-pty hands over 1-4 K characters at a time. */
const STREAM_CHUNK_CHARS = [1024, 1536, 2048, 3072, 4096] as const;
const STREAM_BYTES_PER_SECOND = 32 * 1024;
/** A test run or build log at 1 MiB/s, in the 2 KiB chunks the flow-control scenarios model. */
const FLOOD_CHUNK_CHARS = 2048;
const FLOOD_BYTES_PER_SECOND = MIB;
/** Staggers each terminal's first chunk so the fleet interleaves. */
const START_STAGGER_MS = 7;
/** Past every coalescing window, so the last pending batch flushes on its own timer. */
const SETTLE_MS = 500;
/**
 * Every fifth streamed chunk opens with an OSC 11 colour query, which the
 * pipeline answers and strips from the renderer's copy. Main must get the raw
 * chunk, so forwarding the renderer copy instead shows up as a payload miss.
 */
const STREAM_OSC_EVERY = 5;

/**
 * Agent-style lines, box-drawing included because TUI output is. None ends in
 * `$`, `>`, `%` or `#`, none carries `@` or `➜`, and none has a command-failure
 * phrase, so the identity watcher never reads one as a returned prompt.
 */
const STREAM_LINES = [
  "│ \x1b[1mPlan\x1b[0m: route the forwarder gate through the data pipeline",
  "│   • reading electron/services/pty/AgentOutputForwarder.ts",
  "│   • 3 files changed, 41 insertions(+), 12 deletions(-)",
  "╰─ \x1b[2mthinking…\x1b[0m 2.4s · 1,204 tokens",
  "\x1b[36m●\x1b[0m Update(src/store/slices/panelRegistry/restart.ts)",
  "│ The coalescing window stays at 50 ms; only the consumer set changes.",
] as const;

/** Plain ASCII, so a 2,048-char chunk is exactly 2 KiB on the wire. */
const FLOOD_LINES = [
  " PASS  src/services/terminal/WriteQueue.test.ts (412 ms)",
  " PASS  electron/services/pty/__tests__/PtyDataPipeline.test.ts (88 ms)",
  "   transform 1.42s, setup 0.31s, collect 6.10s, tests 12.88s",
  " RUN   v4.0.0 /workspace/daintree shard 3/6",
] as const;

export type ForwardingCohort = "unboundStream" | "unboundFlood" | "boundStream" | "boundFlood";

export const FORWARDING_COHORTS: readonly ForwardingCohort[] = [
  "unboundStream",
  "unboundFlood",
  "boundStream",
  "boundFlood",
];

/** The issue's fleet: every agent the user runs, none of them the Assistant. */
export const FLEET_COHORTS: readonly ForwardingCohort[] = ["unboundStream", "unboundFlood"];

export interface ForwardingTerminalPlan {
  terminalId: string;
  cohort: ForwardingCohort;
  isAssistantTerminal: boolean;
  frames: PipelineFrame[];
  /** Virtual arrival time of each frame, relative to the fleet's start. */
  arrivalsMs: number[];
  stream: string;
  /** The stream minus the colour queries the pipeline answers and strips. */
  rendererChars: number;
  ptyBytes: number;
}

export interface ForwardingFleetPlan {
  terminals: ForwardingTerminalPlan[];
}

export interface ForwardingFleetOptions {
  streamTerminals?: number;
  streamBytes?: number;
  floodBytes?: number;
  boundFloodBytes?: number;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function composeText(lines: readonly string[], minChars: number, seed: number): string {
  let text = "";
  let index = seed;
  while (text.length < minChars) {
    text += `${lines[index % lines.length]!}\r\n`;
    index += 1;
  }
  return text;
}

function buildTerminal(
  terminalId: string,
  cohort: ForwardingCohort,
  shape: "stream" | "flood",
  targetBytes: number,
  startMs: number,
  seed: number
): ForwardingTerminalPlan {
  const isFlood = shape === "flood";
  // A first line naming the terminal makes every stream unique, so output
  // emitted under another fleet terminal's id cannot match by coincidence.
  const marker = isFlood ? ` RUN   ${terminalId}` : `│ session ${terminalId}`;
  const text = `${marker}\r\n${composeText(isFlood ? FLOOD_LINES : STREAM_LINES, targetBytes, seed)}`;
  const bytesPerMs = (isFlood ? FLOOD_BYTES_PER_SECOND : STREAM_BYTES_PER_SECOND) / 1000;
  const frames: PipelineFrame[] = [];
  const arrivalsMs: number[] = [];
  let offset = 0;
  let sentBytes = 0;
  let chunkIndex = 0;
  let oscQueries = 0;
  // Stop at the target so a flood is a whole number of exact 2 KiB chunks.
  while (offset < text.length && sentBytes < targetBytes) {
    const size = isFlood
      ? FLOOD_CHUNK_CHARS
      : STREAM_CHUNK_CHARS[(seed + chunkIndex) % STREAM_CHUNK_CHARS.length]!;
    const slice = text.slice(offset, offset + size);
    const query = !isFlood && chunkIndex % STREAM_OSC_EVERY === STREAM_OSC_EVERY - 1;
    const chunk = query ? `${OSC_11_QUERY}${slice}` : slice;
    if (query) oscQueries += 1;
    // A chunk lands once the stream has produced every byte up to its end.
    sentBytes += utf8Bytes(chunk);
    arrivalsMs.push(startMs + Math.floor(sentBytes / bytesPerMs));
    frames.push(query ? { text: chunk, expectsOscResponse: true } : { text: chunk });
    offset += slice.length;
    chunkIndex += 1;
  }
  const stream = frames.map((frame) => frame.text).join("");
  return {
    terminalId,
    cohort,
    isAssistantTerminal: cohort === "boundStream" || cohort === "boundFlood",
    frames,
    arrivalsMs,
    stream,
    rendererChars: stream.length - oscQueries * OSC_11_QUERY.length,
    ptyBytes: utf8Bytes(stream),
  };
}

/**
 * Twelve unbound agents streaming answers plus one unbound flood (the issue's
 * fleet), and one Assistant terminal of each shape as the bound control.
 */
export function buildForwardingFleet(options: ForwardingFleetOptions = {}): ForwardingFleetPlan {
  const streamTerminals = options.streamTerminals ?? 12;
  const streamBytes = options.streamBytes ?? 48 * 1024;
  const floodBytes = options.floodBytes ?? MIB;
  const boundFloodBytes = options.boundFloodBytes ?? 256 * 1024;

  const terminals: ForwardingTerminalPlan[] = [];
  let slot = 0;
  const add = (
    cohort: ForwardingCohort,
    shape: "stream" | "flood",
    targetBytes: number,
    index: number
  ): void => {
    terminals.push(
      buildTerminal(
        `perf-037-${cohort}-${index}`,
        cohort,
        shape,
        targetBytes,
        slot * START_STAGGER_MS,
        slot
      )
    );
    slot += 1;
  };

  for (let i = 0; i < streamTerminals; i += 1) add("unboundStream", "stream", streamBytes, i);
  add("unboundFlood", "flood", floodBytes, 0);
  add("boundStream", "stream", streamBytes, 0);
  add("boundFlood", "flood", boundFloodBytes, 0);
  return { terminals };
}

export interface ForwardingTerminalObservation {
  terminalId: string;
  chunksFed: number;
  emitCalls: number;
  emittedChars: number;
  outputTail: string;
  /** `agent:output` emits for this terminal: one host-to-Main message each. */
  messages: number;
  forwardedBytes: number;
  /** Every forwarded payload, concatenated in emit order. */
  forwarded: string;
  /** Payloads naming an agent other than the one `getLiveAgentId` must answer. */
  agentIdMisses: number;
}

export interface ForwardingFleetObservation {
  terminals: ForwardingTerminalObservation[];
  /** Emits naming a terminal outside the fleet. */
  strayMessages: number;
}

/**
 * Drive the fleet in arrival order on one virtual clock, the way one PTY host
 * thread serves every pane. The clock is installed only for the run and always
 * restored, so a throw cannot leak patched timers into the next scenario.
 */
export async function runForwardingFleet(
  plan: ForwardingFleetPlan
): Promise<ForwardingFleetObservation> {
  const byId = new Map<string, ForwardingTerminalObservation>();
  for (const terminal of plan.terminals) {
    byId.set(terminal.terminalId, {
      terminalId: terminal.terminalId,
      chunksFed: 0,
      emitCalls: 0,
      emittedChars: 0,
      outputTail: "",
      messages: 0,
      forwardedBytes: 0,
      forwarded: "",
      agentIdMisses: 0,
    });
  }
  let strayMessages = 0;

  const arrivals: Array<{ at: number; terminal: number; frame: number }> = [];
  plan.terminals.forEach((terminal, index) => {
    terminal.arrivalsMs.forEach((at, frame) => arrivals.push({ at, terminal: index, frame }));
  });
  arrivals.sort((a, b) => a.at - b.at || a.terminal - b.terminal || a.frame - b.frame);

  const clock = new VirtualClock();
  const off = events.on("agent:output", (payload) => {
    const observed = payload.terminalId ? byId.get(payload.terminalId) : undefined;
    if (!observed) {
      strayMessages += 1;
      return;
    }
    observed.messages += 1;
    observed.forwardedBytes += utf8Bytes(payload.data);
    observed.forwarded += payload.data;
    if (payload.agentId !== EXPECTED_LIVE_AGENT_ID) observed.agentIdMisses += 1;
  });

  const harnesses: PipelineHarness[] = [];
  clock.install();
  try {
    const startMs = clock.now();
    for (const terminal of plan.terminals) {
      const forwarder = new AgentOutputForwarder({
        terminalId: terminal.terminalId,
        traceId: undefined,
      });
      harnesses.push(
        createPipelineHarness(terminal.terminalId, {
          isAssistantTerminal: terminal.isAssistantTerminal,
          onAgentOutput: (agentId, data) => forwarder.queue(agentId, data),
        })
      );
    }

    for (const arrival of arrivals) {
      const wait = startMs + arrival.at - clock.now();
      if (wait > 0) await clock.tick(wait);
      harnesses[arrival.terminal]!.feed(plan.terminals[arrival.terminal]!.frames[arrival.frame]!);
    }
    // Graded here, before any teardown flush: the forwarder's own timer must
    // have delivered every byte, so one that held output until teardown misses.
    await clock.tick(SETTLE_MS);

    plan.terminals.forEach((terminal, index) => {
      const finished = harnesses[index]!.finish();
      const observed = byId.get(terminal.terminalId)!;
      observed.chunksFed = finished.chunksFed;
      observed.emitCalls = finished.emitCalls;
      observed.emittedChars = finished.emittedChars;
      observed.outputTail = finished.outputTail;
    });
  } finally {
    harnesses.forEach((harness) => harness.dispose());
    clock.uninstall();
    off();
  }

  return {
    terminals: plan.terminals.map((terminal) => byId.get(terminal.terminalId)!),
    strayMessages,
  };
}

export interface ForwardingMisses {
  /** Chunks or characters that did not reach the renderer. */
  rendererDeliveryMisses: number;
  /** The host-local 2,000-char agent output ring does not hold the stream's tail. */
  outputRingMisses: number;
  /**
   * An Assistant terminal whose forwarded output, once the coalescing window
   * has closed, is not its raw PTY output byte for byte and in order.
   */
  boundPayloadMisses: number;
  /**
   * Any other terminal that forwarded part of its output. Forwarding all of it
   * and forwarding none of it are both whole answers; a dropped, reordered or
   * duplicated chunk is not.
   */
  unboundPayloadMisses: number;
  /** Payloads attributed to the wrong agent, or to a terminal outside the fleet. */
  attributionMisses: number;
}

export function forwardingMisses(
  plan: ForwardingFleetPlan,
  observed: ForwardingFleetObservation
): ForwardingMisses {
  const misses: ForwardingMisses = {
    rendererDeliveryMisses: 0,
    outputRingMisses: 0,
    boundPayloadMisses: 0,
    unboundPayloadMisses: 0,
    attributionMisses: observed.strayMessages,
  };
  plan.terminals.forEach((terminal, index) => {
    const seen = observed.terminals[index]!;
    if (seen.chunksFed !== terminal.frames.length) misses.rendererDeliveryMisses += 1;
    if (seen.emitCalls !== terminal.frames.length) misses.rendererDeliveryMisses += 1;
    if (seen.emittedChars !== terminal.rendererChars) misses.rendererDeliveryMisses += 1;
    if (seen.outputTail !== terminal.stream.slice(-OUTPUT_BUFFER_SIZE)) {
      misses.outputRingMisses += 1;
    }
    if (terminal.isAssistantTerminal) {
      if (seen.forwarded !== terminal.stream) misses.boundPayloadMisses += 1;
    } else if (seen.forwarded !== "" && seen.forwarded !== terminal.stream) {
      misses.unboundPayloadMisses += 1;
    }
    misses.attributionMisses += seen.agentIdMisses;
  });
  return misses;
}

export interface CohortCounts {
  messages: number;
  forwardedBytes: number;
  ptyBytes: number;
  messagesPerMiB: number;
  bytesPerMiB: number;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Messages and bytes handed to Main, per MiB of PTY output, over the named cohorts. */
export function cohortCounts(
  plan: ForwardingFleetPlan,
  observed: ForwardingFleetObservation,
  cohorts: readonly ForwardingCohort[]
): CohortCounts {
  let messages = 0;
  let forwardedBytes = 0;
  let ptyBytes = 0;
  plan.terminals.forEach((terminal, index) => {
    if (!cohorts.includes(terminal.cohort)) return;
    const seen = observed.terminals[index]!;
    messages += seen.messages;
    forwardedBytes += seen.forwardedBytes;
    ptyBytes += terminal.ptyBytes;
  });
  const mib = ptyBytes / MIB;
  return {
    messages,
    forwardedBytes,
    ptyBytes,
    messagesPerMiB: mib > 0 ? round3(messages / mib) : 0,
    bytesPerMiB: mib > 0 ? round3(forwardedBytes / mib) : 0,
  };
}
