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
 * A host's reading times in this machine's clock. Only differences taken on
 * one machine's clock are used: when this machine had the sample, less its
 * age on the host when posted, less how much earlier than the sample the host
 * took the reading. A host whose clock is off by an hour still reads its true age.
 */
export function onShellClock(
  summary: Pick<HostMetricsSummary, "sampledAt">,
  receipt: SummaryReceipt | null,
  readings: readonly AgentUsageReading[]
): AgentUsageReading[] {
  const sampledHere = receipt ? receipt.receivedAt - (receipt.hostAgeMs ?? 0) : summary.sampledAt;
  const here = (hostTime: number) => sampledHere - (summary.sampledAt - hostTime);
  return readings.map((reading) => ({
    ...reading,
    accountNames: reading.accountNames.map(displaySafeText),
    observedAt: here(reading.observedAt),
    resetsAt: reading.resetsAt === null ? null : here(reading.resetsAt),
  }));
}

/**
 * Linked hosts' usage readings (#17318), from the summaries they already
 * send: a host connected now, on its current link. Nothing here dials a host
 * or keeps one linked.
 */
export function createAgentUsageHostsSource(deps: AgentUsageHostsDeps): RemoteAgentUsageSource {
  // Placed once per change of what the host said, so a new frame every few
  // seconds doesn't move a reading's times by its own jitter.
  const placed = new Map<HostId, { said: string; readings: AgentUsageReading[] }>();
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
          if (metrics.cameOn(summary, deps.sessionFor(host.id)) !== true) continue;
          const said = JSON.stringify(summary.agentUsage);
          let entry = placed.get(host.id);
          if (entry?.said !== said) {
            entry = {
              said,
              readings: onShellClock(summary, metrics.receiptOf(summary), summary.agentUsage),
            };
            placed.set(host.id, entry);
          }
          listed.add(host.id);
          out.push({
            hostId: host.id,
            hostName: displaySafeText(host.name),
            readings: entry.readings,
          });
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
