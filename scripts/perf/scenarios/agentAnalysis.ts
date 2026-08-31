import type { PerfScenario } from "../types";
import {
  runAgentAnalysisSim,
  DEFAULT_PHASES,
  type AgentAnalysisSimResult,
} from "../lib/agentAnalysisSim";

/** Fleet sizes the scenario asks for — and therefore what it expects back. */
const SINGLE_AGENT = 1;
const TEN_AGENTS = 10;
const THIRTY_AGENTS = 30;

/**
 * What a sweep of `expectedAgents` agents must have produced.
 *
 * The expectation is the fleet size the scenario ASKED for, never the size the
 * sweep reports: a sim replaced by a constant returns zero agents alongside
 * zero flips and agrees with itself, taking every rate metric here to its
 * best-ever value while raising nothing. Every reading below comes off the
 * `agent:state-changed` stream or the feed loop, not off the bytes handed in.
 */
export function analysisSweepMisses(expectedAgents: number, sweep: AgentAnalysisSimResult): number {
  return (
    Math.abs(expectedAgents - sweep.agents) +
    Math.abs(expectedAgents - sweep.agentsWithWaitFlip) +
    Math.abs(expectedAgents - sweep.agentsWithResumeFlip) +
    // The record stream has to carry both canonical flips for every agent.
    (sweep.stateChangeRecords >= expectedAgents * 2 ? 0 : 1) +
    // The rate metrics divide by fedBytes, so a workload that shrank would
    // report a lower tax rather than a shorter run.
    (sweep.scriptedBytes > 0 && sweep.fedBytes === sweep.scriptedBytes ? 0 : 1)
  );
}

// PERF-035: agent-output analysis pipeline (AgentStateService / FSM / pattern
// detection). Every output chunk of every streaming agent terminal runs
// through the analysis stack, so the cost scales with fleet size. The sim
// (scripts/perf/lib/agentAnalysisSim.ts) drives the real production worker
// stack under a virtual clock and reports two orthogonal numbers:
//
//   * cpuMsPerMb{1,10,30} / cpuMsPerAgentSec30 — the TAX: real CPU per MB of
//     streamed output (and per agent-second) at 1/10/30 concurrent agents
//   * waitFlipLatencyMs / resumeFlipLatencyMs — the QUALITY: virtual-time
//     detection latency from the stream going quiet to the FSM's
//     working→waiting flip, and from resumed output to the waiting→working
//     flip. These drive the waiting-nudge, activity lights, and dashboard
//     truthfulness. They are deterministic in virtual time — treat any
//     movement as a semantic change, not noise.
//
// An optimization must lower the tax without raising the latency; the sim
// throws if an agent's FSM timeline loses its canonical transitions, so a
// fast-but-blind regression fails the scenario rather than flattering it.
export const agentAnalysisScenarios: PerfScenario[] = [
  {
    id: "PERF-035",
    name: "Agent Output Analysis - Fleet CPU Tax + Detection Latency",
    description:
      "Real AnalysisWorkerRuntime/AnalysisSession + AgentStateService pipeline under a " +
      "virtual clock: CPU per MB of streamed agent output at 1/10/30 concurrent agents, " +
      "plus working→waiting and waiting→working detection latency in virtual ms.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 8 },
    warmups: 1,
    correctness: ["analysisMisses"],
    async run() {
      const single = await runAgentAnalysisSim({ agents: SINGLE_AGENT, phases: DEFAULT_PHASES });
      const ten = await runAgentAnalysisSim({ agents: TEN_AGENTS, phases: DEFAULT_PHASES });
      const thirty = await runAgentAnalysisSim({ agents: THIRTY_AGENTS, phases: DEFAULT_PHASES });

      const analysisMisses =
        analysisSweepMisses(SINGLE_AGENT, single) +
        analysisSweepMisses(TEN_AGENTS, ten) +
        analysisSweepMisses(THIRTY_AGENTS, thirty);

      return {
        // Wall-clock fallback: the whole simulated fleet sweep is awaited, so
        // wall-clock tracks the total analysis cost of the workload.
        durationMs: -1,
        metrics: {
          cpuMsPerMb1: single.cpuMsPerMb,
          cpuMsPerMb10: ten.cpuMsPerMb,
          cpuMsPerMb30: thirty.cpuMsPerMb,
          cpuMsPerAgentSec30: thirty.cpuMsPerAgentSecond,
          fleetCpuMs30: thirty.cpuMs,
          waitFlipLatencyMs: thirty.waitFlipLatencyMs,
          resumeFlipLatencyMs: thirty.resumeFlipLatencyMs,
          analysisMisses,
        },
      };
    },
  },
];
