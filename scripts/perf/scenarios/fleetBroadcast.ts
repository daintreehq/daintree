import { performance } from "node:perf_hooks";
import type { PerfScenario } from "../types";
import type { PanelInstance } from "../../../shared/types/panel";
import { RequestResponseBroker } from "../../../electron/services/rpc/RequestResponseBroker";
import { buildFleet, loadFleetEligibility, type FleetPanel } from "../lib/fleetBroadcastFixture";

// Fleet broadcast fan-out — the headline multi-agent path: one payload dispatched
// to every armed terminal at once. This models the RENDERER-SIDE fan-out only —
// it does NOT measure the full IPC + PTY write round-trip. What it does measure
// is the three parts that scale with fleet size and run in our code on the
// broadcast path: (1) filtering the armed set to live targets through the REAL
// `isTerminalFleetEligible` from `src/store/fleetEligibility.ts`, (2) the
// per-target recipe-variable substitution, and (3) the awaited per-target
// dispatch orchestration, modeled with the REAL RequestResponseBroker — the
// same correlation layer the IPC scenarios exercise. The gate watches the
// per-target amortized cost so fan-out that degrades super-linearly with fleet
// size (the failure a large fleet feels most) is caught.
//
// The eligibility gate used to be a hand-mirror in this file, on the belief
// that the real module could not be linked outside Vite. `lib/fleetBroadcastFixture.ts`
// links it, states what that costs, and explains why the mirror was the worse
// option: a copy of a predicate cannot regress when the predicate does.
//
// Three paired readings, one per operation inside the timed bracket, because a
// fan-out can lose any one of them and get faster at zero cost to the others:
//
// - `eligibilityMisses` — a filter that keeps nothing dispatches nothing and
//   posts the fastest fan-out the harness can record; one that keeps everything
//   posts a plausible number over the wrong denominator. The expectation is the
//   fixture's own arithmetic, never a second call to the predicate. It used to
//   be a throw, which aborted the whole run instead of reporting a number — the
//   harness measures and never gates, so a wrong target count belongs in the
//   results file.
// - `substitutionMisses` — every dispatched payload must have both recipe
//   variables replaced with THIS target's worktree and panel id, and carry no
//   `{{` residue. Skipping substitution is a pure saving no target count sees.
// - `dispatchMisses` — every ack must come back through the broker carrying the
//   nonce minted for that target. A fan-out that stops correlating (or resolves
//   one pending promise with another target's reply) is materially cheaper and
//   otherwise invisible.

const DRAFT = "cd {{worktree}} && npm run check -- --scope {{id}}\r";

interface FanOutResult {
  fanoutMs: number;
  eligible: number;
  ackBytes: number;
  substitutionMisses: number;
  dispatchMisses: number;
}

/**
 * Filter the armed set, then fan the payload out to every target as an awaited
 * per-target round-trip through the real broker — the shape of the managed
 * broadcast that waits on each pane's submission result.
 */
async function broadcastFanOut(
  panels: FleetPanel[],
  isTerminalFleetEligible: (panel: PanelInstance | undefined) => boolean
): Promise<FanOutResult> {
  const broker = new RequestResponseBroker({ defaultTimeoutMs: 8000, idPrefix: "perf-fleet" });
  try {
    const start = performance.now();
    const targets = panels.filter((panel) =>
      isTerminalFleetEligible(panel as unknown as PanelInstance)
    );

    let ackBytes = 0;
    let substitutionMisses = 0;
    const expected: string[] = [];
    const sends = targets.map((target, index): Promise<{ nonce: string }> => {
      // Recipe-variable substitution runs per target on the broadcast path.
      const payload = DRAFT.replaceAll("{{worktree}}", target.worktreeId).replaceAll(
        "{{id}}",
        target.id
      );
      ackBytes += payload.length;
      if (payload.includes("{{")) substitutionMisses += 1;
      if (!payload.includes(target.worktreeId)) substitutionMisses += 1;
      if (!payload.includes(target.id)) substitutionMisses += 1;

      const nonce = `${target.id}:${index}`;
      expected.push(nonce);
      const id = broker.generateId(target.id);
      const pending = broker.register<{ nonce: string }>(id);
      // Mix sync and microtask acks so the fan-out exercises real correlation
      // scheduling under concurrency rather than a tight resolve-in-order loop.
      if (index % 3 === 0) {
        queueMicrotask(() => broker.resolve(id, { nonce }));
      } else {
        broker.resolve(id, { nonce });
      }
      return pending;
    });

    const acks = await Promise.all(sends);
    const fanoutMs = performance.now() - start;
    // Graded after the bracket against the nonces minted inside it: an ack
    // count short of the target count, or one carrying another target's nonce,
    // both mean the correlated round trip the timing is attributed to did not
    // happen for every pane.
    let dispatchMisses = Math.abs(acks.length - targets.length);
    for (let i = 0; i < expected.length; i += 1) {
      if (acks[i]?.nonce !== expected[i]) dispatchMisses += 1;
    }
    // Broker-side reading: `generateId` stamps a monotonic counter into every
    // id it hands out, so one probe afterwards says how many ids the fan-out
    // actually took. A dispatch loop that resolved its own promises without
    // going through the broker leaves the counter at zero — which no check on
    // the acks alone could tell apart from a correlated round trip.
    const probeSeq = Number(broker.generateId().split("-").at(-1));
    dispatchMisses += Math.abs(probeSeq - (targets.length + 1));
    // Every registration must have settled; a leaked pending is a dispatch the
    // fan-out never waited for.
    dispatchMisses += broker.size;
    return { fanoutMs, eligible: targets.length, ackBytes, substitutionMisses, dispatchMisses };
  } finally {
    broker.dispose();
  }
}

export const fleetBroadcastScenarios: PerfScenario[] = [
  {
    id: "PERF-150",
    name: "Fleet Broadcast - Concurrent Fan-Out (24 armed)",
    description:
      "Model the renderer-side fan-out of one payload to a realistic armed fleet of 24 live grid " +
      "terminals mixed with ineligible chaff (dock, exited, PTY-less, browser panes). Filters " +
      "through the REAL isTerminalFleetEligible from src/store/fleetEligibility.ts and fans out " +
      "awaited per-target dispatches through the real RequestResponseBroker. durationMs is the " +
      "fan-out wall time; eligibilityMisses is the signed difference from the 24 targets the " +
      "fixture built, so keeping too many is distinguishable from keeping too few.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 18, nightly: 24 },
    warmups: 2,
    correctness: ["eligibilityMisses", "substitutionMisses", "dispatchMisses"],
    async run() {
      const EXPECTED = 24;
      const { isTerminalFleetEligible } = await loadFleetEligibility();
      const panels = buildFleet(EXPECTED, 12, 150);
      const { fanoutMs, eligible, ackBytes, substitutionMisses, dispatchMisses } =
        await broadcastFanOut(panels, isTerminalFleetEligible);
      const eligibilityMisses = eligible - EXPECTED;
      return {
        durationMs: fanoutMs,
        metrics: {
          eligibleTargets: eligible,
          totalPanels: panels.length,
          ackBytes,
          eligibilityMisses,
          substitutionMisses,
          dispatchMisses,
        },
        notes:
          eligibilityMisses !== 0
            ? `eligibility filter kept ${eligible} targets, expected ${EXPECTED} — the fan-out timing is over the wrong denominator`
            : undefined,
      };
    },
  },
  {
    id: "PERF-151",
    name: "Fleet Broadcast - Fan-Out Scaling",
    description:
      "Renderer-side fan-out latency across growing fleets (6/12/24/48 armed terminals), filtered " +
      "through the real isTerminalFleetEligible. Budgets msPerTargetAt48 (amortized per-target " +
      "dispatch at the largest fleet) so a broadcast whose cost grows super-linearly with fleet " +
      "size — the failure the multi-agent workflow feels most — trips the gate even when small " +
      "fleets still look instant. eligibilityMisses sums the absolute per-size difference (four " +
      "sizes in one sample, so a signed sum could net out), and the substitution and dispatch " +
      "misses accumulate across every size.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 14, nightly: 20 },
    warmups: 1,
    correctness: ["eligibilityMisses", "substitutionMisses", "dispatchMisses"],
    async run() {
      const sizes = [6, 12, 24, 48];
      const { isTerminalFleetEligible } = await loadFleetEligibility();
      const msBySize = new Map<number, number>();
      let eligibleAt48 = 0;
      let eligibilityMisses = 0;
      let substitutionMisses = 0;
      let dispatchMisses = 0;

      const start = performance.now();
      for (const size of sizes) {
        const panels = buildFleet(size, Math.ceil(size / 2), 1510 + size);
        const result = await broadcastFanOut(panels, isTerminalFleetEligible);
        eligibilityMisses += Math.abs(result.eligible - size);
        substitutionMisses += result.substitutionMisses;
        dispatchMisses += result.dispatchMisses;
        msBySize.set(size, result.fanoutMs);
        if (size === 48) eligibleAt48 = result.eligible;
      }
      const durationMs = performance.now() - start;

      const ms48 = msBySize.get(48) ?? 0;
      return {
        durationMs,
        metrics: {
          fanoutMs6: msBySize.get(6) ?? 0,
          fanoutMs48: ms48,
          msPerTargetAt48: eligibleAt48 > 0 ? ms48 / eligibleAt48 : 0,
          eligibleAt48,
          eligibilityMisses,
          substitutionMisses,
          dispatchMisses,
        },
        notes:
          eligibilityMisses > 0
            ? "a fleet size filtered to the wrong target count — the per-target slope is over the wrong denominator"
            : undefined,
      };
    },
  },
];
