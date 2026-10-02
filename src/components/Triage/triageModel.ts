import type { FleetRunRow } from "@shared/types/ipc/fleet";
import {
  TRIAGE_ATTENTION_CATEGORIES,
  type TriageCard,
  type TriageCategory,
} from "@shared/types/ipc/triage";
import type { PilotProjectGroup, PilotRow } from "@/components/Pilot/pilotRows";

export interface TriageItem {
  runId: string;
  workspaceId: string;
  row: PilotRow;
  workspace: Pick<PilotProjectGroup, "name" | "emoji" | "color" | "kind" | "isCurrent">;
  /** What the card is drawn as. The classifier's reading once it has one. */
  kind: TriageCategory;
  /** The classifier's card, when it still describes the run's current state. */
  card: TriageCard | null;
  /** Words for the card are on their way: its first read, a describe, or a re-read. */
  pending: boolean;
  /**
   * The run's state moved after its card was read. Its words may still show,
   * but nothing that acts on a prompt is offered until it is read again.
   */
  stale: boolean;
}

export type TriageSectionId = "needs-you" | "working" | "quiet";

export interface TriageSection {
  id: TriageSectionId;
  items: TriageItem[];
}

/** Worst first: a menu blocks a turn outright, a finished run only waits. */
const KIND_RANK: Record<TriageCategory, number> = {
  approval: 0,
  question: 1,
  error: 2,
  finished: 3,
  working: 4,
  running: 5,
  idle: 6,
};

/**
 * The run's kind from Daintree's own state tracking, used until the classifier
 * has read the screen — so the panel lays out at once instead of waiting.
 */
export function observedKind(run: FleetRunRow): TriageCategory {
  switch (run.agentState) {
    case "waiting":
      if (run.waitingReason === "approval") return "approval";
      if (run.waitingReason === "error") return "error";
      return "question";
    case "working":
    case "directing":
      return "working";
    case "completed":
      return "finished";
    default:
      return "idle";
  }
}

/**
 * A card read from a screen older than the run's latest state change no longer
 * describes it. Its words are kept while the kinds still agree, but never its
 * prompt: an old question or menu beside a new one would invite answering the
 * wrong thing, so those wait for the fresh read.
 */
const STALE_GRACE_MS = 1_000;

function currentCard(
  run: FleetRunRow,
  card: TriageCard | undefined
): { card: TriageCard | null; stale: boolean } {
  if (!card) return { card: null, stale: false };
  // Read from a terminal that has since been respawned under the same id.
  if (card.spawnedAt !== run.spawnedAt) return { card: null, stale: false };
  if (run.since !== undefined && run.since > card.observedAt + STALE_GRACE_MS) {
    if (observedKind(run) !== card.category) return { card: null, stale: true };
    return { card: { ...card, question: null, options: [] }, stale: true };
  }
  return { card, stale: false };
}

/** Whether a missing card is still coming: never without keys, nor after a failed read. */
export interface TriageReadState {
  configured: boolean;
  failed: boolean;
}

const READING: TriageReadState = { configured: true, failed: false };

export function buildTriageSections(
  groups: readonly PilotProjectGroup[],
  cards: ReadonlyMap<string, TriageCard>,
  read: TriageReadState = READING
): TriageSection[] {
  const items: TriageItem[] = [];
  for (const group of groups) {
    for (const row of group.rows) {
      const { card, stale } = currentCard(row.run, cards.get(row.run.runId));
      items.push({
        runId: row.run.runId,
        workspaceId: row.run.workspaceId,
        row,
        workspace: {
          name: group.name,
          emoji: group.emoji,
          color: group.color,
          kind: group.kind,
          isCurrent: group.isCurrent,
        },
        kind: card?.category ?? observedKind(row.run),
        card,
        // A bone promises words. Without keys nothing will write them, and after
        // a failed read nothing is writing them now, so neither draws one.
        pending:
          read.configured &&
          (card === null ? !read.failed : card.describing || (stale && !read.failed)),
        stale,
      });
    }
  }

  items.sort((a, b) => {
    const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (byKind !== 0) return byKind;
    // Within a kind, whoever has been in that state longest leads.
    return (
      (a.row.run.since ?? Number.MAX_SAFE_INTEGER) - (b.row.run.since ?? Number.MAX_SAFE_INTEGER)
    );
  });

  const sections: TriageSection[] = [
    { id: "needs-you", items: [] },
    { id: "working", items: [] },
    { id: "quiet", items: [] },
  ];
  for (const item of items) {
    const section = TRIAGE_ATTENTION_CATEGORIES.has(item.kind)
      ? sections[0]!
      : item.kind === "working" || item.kind === "running"
        ? sections[1]!
        : sections[2]!;
    section.items.push(item);
  }
  return sections.filter((section) => section.items.length > 0);
}
