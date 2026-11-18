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
 * How far a host's clock sits from this machine's, as one frame shows it.
 * Only differences taken on one machine's clock are used: when this machine
 * had the sample, less the most it can have aged on the way (its age on the
 * host plus the trip, when the frame bounds it), against when the host took it.
 */
export function shellClockOffset(
  summary: Pick<HostMetricsSummary, "sampledAt">,
  receipt: SummaryReceipt | null
): number {
  if (!receipt) return 0;
  return receipt.receivedAt - (receipt.maxAgeMs ?? receipt.hostAgeMs ?? 0) - summary.sampledAt;
}

/**
 * A host's reading on this machine's clock: its age, so a host whose clock is
 * off by an hour still reads its true age. Resets are left as sent: Codex's
 * come from its server and Claude Code's from the time the message named,
 * neither from the host's clock.
 */
export function onShellClock(reading: AgentUsageReading, offset: number): AgentUsageReading {
  return {
    ...reading,
    accountNames: reading.accountNames.map(displaySafeText),
    observedAt: reading.observedAt + offset,
  };
}

/**
 * Linked hosts' usage readings (#17318), from the summaries they already
 * send: a host connected now, on its current link. Nothing here dials a host
 * or keeps one linked.
 */
export function createAgentUsageHostsSource(deps: AgentUsageHostsDeps): RemoteAgentUsageSource {
  // One offset per link, so frames every few seconds don't move a reading's
  // age by their own jitter, and a host's readings keep the order its clock
  // gave them. Taken again once a frame first bounds its trip.
  const links = new Map<
    HostId,
    { session: LinkSession | null; offset: number; bounded: boolean }
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
          const receipt = metrics.receiptOf(summary);
          const bounded = receipt?.maxAgeMs != null;
          let link = links.get(host.id);
          if (!link || link.session !== session || (bounded && !link.bounded)) {
            link = { session, offset: shellClockOffset(summary, receipt), bounded };
            links.set(host.id, link);
          }
          const { offset } = link;
          listed.add(host.id);
          out.push({
            hostId: host.id,
            hostName: displaySafeText(host.name),
            readings: summary.agentUsage.map((reading) => onShellClock(reading, offset)),
          });
        }
      }
      for (const hostId of [...links.keys()]) {
        if (!listed.has(hostId)) links.delete(hostId);
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
