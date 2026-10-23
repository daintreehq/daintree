import type { AgentDirectorySubject } from "@shared/types/agentDirectory";
import {
  isFullAssistantWork,
  type AssistantWorkReading,
  type AssistantWorkRef,
  type AssistantWorkWorker,
} from "@shared/types/assistantWork";
import type { HostId } from "@shared/types/remoteHosts";
import { canopyAssistantId } from "./canopyAssistants";
import type { CanopyItem } from "./canopyModel";

/** Each host's reading of which workers its assistants made or hold. */
export type AssistantWorkReadings = ReadonlyMap<HostId, AssistantWorkReading>;

/**
 * Every linked worker, by the run id its Canopy row carries: the terminal id
 * on one host, its All hosts key across several. The same terminal id on two
 * hosts is two workers.
 */
export function workLinksByRun(
  readings: AssistantWorkReadings,
  runKey: (hostId: HostId, terminalId: string) => string
): ReadonlyMap<string, AssistantWorkWorker> {
  const links = new Map<string, AssistantWorkWorker>();
  for (const [hostId, reading] of readings) {
    for (const worker of reading.workers) links.set(runKey(hostId, worker.terminalId), worker);
  }
  return links;
}

/**
 * The link of exactly this row's run, or null. A reused terminal id is a new
 * run with a new spawn time, and never borrows the earlier run's link.
 */
export function workLinkOf(
  item: CanopyItem,
  links: ReadonlyMap<string, AssistantWorkWorker>
): AssistantWorkWorker | null {
  const link = links.get(item.runId);
  return link !== undefined && link.spawnedAt === item.row.run.spawnedAt ? link : null;
}

function refIs(ref: AssistantWorkRef | null, assistantId: string): boolean {
  return ref?.kind === "assistant" && canopyAssistantId(ref.subject) === assistantId;
}

/** The assistant's work: what it created, and what it holds now by a hand-over or its creation. */
export function isWorkOf(link: AssistantWorkWorker | null, assistantId: string): boolean {
  return (
    link !== null && (refIs(link.createdBy, assistantId) || refIs(link.controlledBy, assistantId))
  );
}

function sameAssistant(a: AssistantWorkRef | null, b: AssistantWorkRef | null): boolean {
  return (
    a?.kind === "assistant" &&
    b?.kind === "assistant" &&
    canopyAssistantId(a.subject) === canopyAssistantId(b.subject)
  );
}

function refLabel(
  ref: AssistantWorkRef,
  nameOf: (subject: AgentDirectorySubject) => string | null
): string {
  switch (ref.kind) {
    case "assistant":
      return nameOf(ref.subject) ?? "a Daintree Assistant";
    case "ended":
      return "an assistant that has ended";
    case "other-installation":
      return "another installation's assistant";
  }
}

/**
 * What a worker's row says of its assistants, as observed: who started it,
 * and who holds it now when that isn't its creator. Nothing is said for a
 * worker no assistant's record names.
 */
export function workLinkLabel(
  link: AssistantWorkWorker | null,
  nameOf: (subject: AgentDirectorySubject) => string | null
): string | null {
  if (link === null) return null;
  const parts: string[] = [];
  if (link.createdBy !== null) parts.push(`Started by ${refLabel(link.createdBy, nameOf)}`);
  if (link.controlledBy !== null && !sameAssistant(link.createdBy, link.controlledBy)) {
    parts.push(
      `${link.control === "handover" ? "Handed to" : "Held by"} ${refLabel(link.controlledBy, nameOf)}`
    );
  } else if (link.controlledBy === null && link.createdBy?.kind === "assistant") {
    parts.push("No longer under its control");
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

/** The hosts whose reading can't say every worker an assistant made: none is read as "no work". */
export function hostsWithPartialWork(
  readings: AssistantWorkReadings,
  hostIds: readonly HostId[]
): HostId[] {
  return hostIds.filter((hostId) => {
    const reading = readings.get(hostId);
    return reading === undefined || !isFullAssistantWork(reading);
  });
}
