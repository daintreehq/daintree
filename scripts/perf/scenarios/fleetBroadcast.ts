import { performance } from "node:perf_hooks";
import type { PerfScenario } from "../types";
import { createRng } from "../lib/workloads";
import { RequestResponseBroker } from "../../../electron/services/rpc/RequestResponseBroker";
import { isGridPanelLocation, type PanelLocation } from "../../../shared/types/panel";

// Fleet broadcast fan-out — the headline multi-agent path: one payload dispatched
// to every armed terminal at once. This models the RENDERER-SIDE fan-out only —
// it does NOT measure the full IPC + PTY write round-trip (unmeasurable under
// tsx). What it does measure is the two parts that scale with fleet size and run
// in our code on the broadcast path: (1) filtering the armed set to live targets,
// via the REAL shared isGridPanelLocation predicate, and (2) the awaited per-
// target dispatch orchestration (per-target payload substitution + concurrent
// correlated acks), modeled with the REAL RequestResponseBroker — the same
// correlation layer the IPC scenarios exercise. The gate watches the per-target
// amortized cost so fan-out that degrades super-linearly with fleet size (the
// failure a large fleet feels most) is caught.
//
// `eligibilityMisses` is the paired reading both scenarios report: a filter
// that keeps nothing dispatches nothing and posts the fastest fan-out the
// harness can record, and one that keeps everything posts a plausible-looking
// number over the wrong denominator. It used to be a throw, which aborted the
// whole run instead of reporting a number — the harness measures and never
// gates, so a wrong target count belongs in the results file.

interface FleetPanel {
  id: string;
  worktreeId: string;
  kind: "terminal" | "browser";
  location: PanelLocation | undefined;
  hasPty: boolean;
  runtimeStatus: "running" | "exited" | "error";
}

// Mirrors isTerminalFleetEligible (src/store/fleetEligibility.ts). That module
// can't be imported under tsx — it pulls in the Vite-only renderer store graph
// (import.meta.glob) — so the gate is reproduced here against the REAL shared
// grid-location predicate, and the field checks are kept in lockstep with the
// source. If the eligibility rules change, update this mirror too.
function isFleetBroadcastTarget(p: FleetPanel): boolean {
  if (p.kind !== "terminal") return false; // isPtyPanel: kind must be "terminal"
  if (!isGridPanelLocation(p.location)) return false; // dock/overlay/trash/background excluded
  if (p.hasPty === false) return false;
  if (p.runtimeStatus === "exited" || p.runtimeStatus === "error") return false;
  return true;
}

// Build an armed set of `eligible` live grid terminals plus `noise` ineligible
// panels (dock terminals, exited/errored sessions, a browser pane, PTY-less
// panels) — the armed set drifts, so a faithful broadcast filters real chaff.
function buildFleet(eligible: number, noise: number, seed: number): FleetPanel[] {
  const rng = createRng(seed);
  const panels: FleetPanel[] = [];
  for (let i = 0; i < eligible; i += 1) {
    panels.push({
      id: `term-${i}`,
      worktreeId: `wt-${i % 8}`,
      kind: "terminal",
      // Mix of explicit "grid" and legacy undefined — both are grid members.
      location: rng() > 0.5 ? "grid" : undefined,
      hasPty: true,
      runtimeStatus: "running",
    });
  }
  const noiseKinds: Array<() => FleetPanel> = [
    () => ({
      id: `dock-${rng()}`,
      worktreeId: "wt-x",
      kind: "terminal",
      location: "dock",
      hasPty: true,
      runtimeStatus: "running",
    }),
    () => ({
      id: `exited-${rng()}`,
      worktreeId: "wt-x",
      kind: "terminal",
      location: "grid",
      hasPty: true,
      runtimeStatus: "exited",
    }),
    () => ({
      id: `nopty-${rng()}`,
      worktreeId: "wt-x",
      kind: "terminal",
      location: "grid",
      hasPty: false,
      runtimeStatus: "running",
    }),
    () => ({
      id: `browser-${rng()}`,
      worktreeId: "wt-x",
      kind: "browser",
      location: "grid",
      hasPty: true,
      runtimeStatus: "running",
    }),
  ];
  for (let i = 0; i < noise; i += 1) {
    panels.push(noiseKinds[i % noiseKinds.length]!());
  }
  // Interleave so the filter can't short-circuit a contiguous eligible block.
  for (let i = panels.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [panels[i], panels[j]] = [panels[j]!, panels[i]!];
  }
  return panels;
}

const DRAFT = "cd {{worktree}} && npm run check -- --scope {{id}}\r";

// Filter the armed set, then fan the payload out to every target as an awaited
// per-target round-trip through the real broker — the shape of the managed
// broadcast that waits on each pane's submission result. Returns wall time of
// the whole fan-out and the eligible-target count.
async function broadcastFanOut(
  panels: FleetPanel[]
): Promise<{ fanoutMs: number; eligible: number; ackBytes: number }> {
  const broker = new RequestResponseBroker({ defaultTimeoutMs: 8000, idPrefix: "perf-fleet" });
  try {
    const start = performance.now();
    const targets = panels.filter(isFleetBroadcastTarget);

    let ackBytes = 0;
    const sends = targets.map((t, index) => {
      // Recipe-variable substitution runs per target on the broadcast path.
      const payload = DRAFT.replaceAll("{{worktree}}", t.worktreeId).replaceAll("{{id}}", t.id);
      ackBytes += payload.length;
      const id = broker.generateId(t.id);
      const pending = broker.register<{ ok: true }>(id);
      // Mix sync and microtask acks so the fan-out exercises real correlation
      // scheduling under concurrency rather than a tight resolve-in-order loop.
      if (index % 3 === 0) {
        queueMicrotask(() => broker.resolve(id, { ok: true }));
      } else {
        broker.resolve(id, { ok: true });
      }
      return pending;
    });

    await Promise.all(sends);
    const fanoutMs = performance.now() - start;
    return { fanoutMs, eligible: targets.length, ackBytes };
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
      "terminals mixed with ineligible chaff (dock, exited, PTY-less, browser panes). Filters via " +
      "the real shared grid-location predicate and fans out awaited per-target dispatches through " +
      "the real RequestResponseBroker. durationMs is the fan-out wall time; eligibilityMisses is " +
      "non-zero whenever the filter does not keep exactly 24 targets.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 18, nightly: 24 },
    warmups: 2,
    correctness: ["eligibilityMisses"],
    async run() {
      const EXPECTED = 24;
      const panels = buildFleet(EXPECTED, 12, 150);
      const { fanoutMs, eligible, ackBytes } = await broadcastFanOut(panels);
      const eligibilityMisses = Math.abs(eligible - EXPECTED);
      return {
        durationMs: fanoutMs,
        metrics: {
          eligibleTargets: eligible,
          totalPanels: panels.length,
          ackBytes,
          eligibilityMisses,
        },
        notes:
          eligibilityMisses > 0
            ? `eligibility filter kept ${eligible} targets, expected ${EXPECTED} — the fan-out timing is over the wrong denominator`
            : undefined,
      };
    },
  },
  {
    id: "PERF-151",
    name: "Fleet Broadcast - Fan-Out Scaling",
    description:
      "Renderer-side fan-out latency across growing fleets (6/12/24/48 armed terminals). Budgets " +
      "msPerTargetAt48 (amortized per-target dispatch at the largest fleet) so a broadcast whose " +
      "cost grows super-linearly with fleet size — the failure the multi-agent workflow feels most " +
      "— trips the gate even when small fleets still look instant. eligibilityMisses is non-zero " +
      "whenever a fleet size filters to the wrong target count.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 14, nightly: 20 },
    warmups: 1,
    correctness: ["eligibilityMisses"],
    async run() {
      const sizes = [6, 12, 24, 48];
      const msBySize = new Map<number, number>();
      let eligibleAt48 = 0;
      let eligibilityMisses = 0;

      const start = performance.now();
      for (const size of sizes) {
        const panels = buildFleet(size, Math.ceil(size / 2), 1510 + size);
        const { fanoutMs, eligible } = await broadcastFanOut(panels);
        eligibilityMisses += Math.abs(eligible - size);
        msBySize.set(size, fanoutMs);
        if (size === 48) eligibleAt48 = eligible;
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
        },
        notes:
          eligibilityMisses > 0
            ? "a fleet size filtered to the wrong target count — the per-target slope is over the wrong denominator"
            : undefined,
      };
    },
  },
];
