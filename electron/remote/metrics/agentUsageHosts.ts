import {
  isLocalHostId,
  type HostId,
  type HostMetricsSummary,
} from "../../../shared/types/remoteHosts.js";
import type { AgentUsageReading } from "../../../shared/types/ipc/agentUsage.js";
import { displaySafeText } from "../../../shared/utils/displaySafeText.js";
import type {
  RemoteAgentUsage,
  RemoteAgentUsageSource,
} from "../../services/agentUsage/AgentUsageReadouts.js";
import type { HostRegistry } from "../client/HostRegistry.js";
import type { RemoteHostManager } from "../client/RemoteHostManager.js";
import type { LinkSession } from "../link/session.js";
import type { HostMetricsClient } from "./client.js";
import type { SummaryReceipt } from "./summaryReceipt.js";

export interface AgentUsageHostsDeps {
  registry: Pick<HostRegistry, "list" | "onChange">;
  manager: Pick<RemoteHostManager, "connectionState" | "onStateChange">;
  sessionFor(hostId: HostId): LinkSession | null;
  /** Looked up on each use: Remote Hosts' metrics may start after this does, or not at all. */
  metrics(): Pick<HostMetricsClient, "latest" | "receiptOf" | "cameOn" | "onSummary"> | undefined;
}

/**
 * A host's reading on this machine's clock. Only differences taken on one
 * machine's clock are used: when this machine had the sample, less the most
 * it can have aged on the way (its age on the host plus the trip, when the
 * frame bounds it), less how much earlier than the sample the host took the
 * reading. A host whose clock is off by an hour still reads its true age.
 * Resets are left as sent: Codex's come from its server and Claude Code's
 * from the time the message named, neither from the host's clock.
 */
export function onShellClock(
  summary: Pick<HostMetricsSummary, "sampledAt">,
  receipt: SummaryReceipt | null,
  reading: AgentUsageReading
): AgentUsageReading {
  const sampledHere = receipt
    ? receipt.receivedAt - (receipt.maxAgeMs ?? receipt.hostAgeMs ?? 0)
    : summary.sampledAt;
  return {
    ...reading,
    accountNames: reading.accountNames.map(displaySafeText),
    observedAt: sampledHere - (summary.sampledAt - reading.observedAt),
  };
}

/**
 * Linked hosts' usage readings (#17318), from the summaries they already
 * send: a host connected now, on its current link. Nothing here dials a host
 * or keeps one linked.
 */
export function createAgentUsageHostsSource(deps: AgentUsageHostsDeps): RemoteAgentUsageSource {
  // Each reading is placed once per link, when the host first sends it, so a
  // new frame every few seconds, or another reading changing beside it,
  // doesn't move its age by the frames' own jitter.
  const placed = new Map<
    HostId,
    { session: LinkSession | null; byReading: Map<string, AgentUsageReading> }
  >();
  return {
    list() {
      const metrics = deps.metrics();
      const out: RemoteAgentUsage[] = [];
      const listed = new Set<HostId>();
      if (metrics) {
        for (const host of deps.registry.list()) {
          if (isLocalHostId(host.id)) continue;
          if (deps.manager.connectionState(host.id).status !== "connected") continue;
          const summary = metrics.latest(host.id);
          if (!summary?.agentUsage?.length) continue;
          const session = deps.sessionFor(host.id);
          if (metrics.cameOn(summary, session) !== true) continue;
          let entry = placed.get(host.id);
          if (entry?.session !== session) {
            entry = { session, byReading: new Map() };
            placed.set(host.id, entry);
          }
          const known = entry.byReading;
          const receipt = metrics.receiptOf(summary);
          const byReading = new Map<string, AgentUsageReading>();
          const readings = summary.agentUsage.map((reading) => {
            const said = JSON.stringify(reading);
            const here = known.get(said) ?? onShellClock(summary, receipt, reading);
            byReading.set(said, here);
            return here;
          });
          entry.byReading = byReading;
          listed.add(host.id);
          out.push({ hostId: host.id, hostName: displaySafeText(host.name), readings });
        }
      }
      for (const hostId of [...placed.keys()]) {
        if (!listed.has(hostId)) placed.delete(hostId);
      }
      return out;
    },
    watch(listener) {
      let offSummaries: (() => void) | null = null;
      // Metrics start with Remote Hosts' first use, before any host can connect.
      const hearSummaries = () => {
        if (offSummaries === null)
          offSummaries = deps.metrics()?.onSummary(() => listener()) ?? null;
      };
      const changed = () => {
        hearSummaries();
        listener();
      };
      hearSummaries();
      const offs = [deps.registry.onChange(changed), deps.manager.onStateChange(changed)];
      return () => {
        for (const off of offs) off();
        offSummaries?.();
      };
    },
  };
}
