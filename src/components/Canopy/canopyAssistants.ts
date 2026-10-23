import type {
  AgentDirectory,
  AgentDirectoryLiveEntry,
  AgentDirectorySubject,
} from "@shared/types/agentDirectory";
import { getAgentDisplayTitle } from "@shared/config/agentRegistry";

/** Which runs Canopy lists: its workers, the Daintree Assistants, or both. */
export type CanopyRoleFilter = "all" | "workers" | "assistants";

export const CANOPY_ROLE_FILTERS: readonly { id: CanopyRoleFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "workers", label: "Workers" },
  { id: "assistants", label: "Assistants" },
];

export function isCanopyRoleFilter(value: unknown): value is CanopyRoleFilter {
  return value === "all" || value === "workers" || value === "assistants";
}

/**
 * What an assistant's own run shows that asks for the person, as observed: a
 * question, an approval or an error it stopped on, or a handback not yet seen.
 * A wait at its ordinary prompt is no ask at all.
 */
export type CanopyAssistantAsk = "approval" | "question" | "error" | "handback";

export const ASSISTANT_ASK_LABEL: Record<CanopyAssistantAsk, string> = {
  approval: "Wants approval",
  question: "Asking you",
  error: "Stopped on an error",
  handback: "Handed back",
};

export interface CanopyAssistantItem {
  /** Unique across hosts, lanes and launches; never a worker's run id. */
  id: string;
  subject: AgentDirectorySubject;
  /** The agent it runs on (Claude, Codex…): never its role, which is always Daintree Assistant. */
  agentName: string | null;
  /** Where it runs: its project and session, or the global assistant. */
  scopeLabel: string;
  projectId: string | null;
  label: string | null;
  agentState: AgentDirectoryLiveEntry["agentState"];
  waitingReason: AgentDirectoryLiveEntry["waitingReason"];
  since: number | null;
  /** Shown in a window on this machine; false while it runs with no view. */
  attached: boolean;
  handbackAt: number | null;
  ask: CanopyAssistantAsk | null;
}

/** The handbacks the person has had in front of them, by assistant id. */
export type AssistantHandbacksSeen = Readonly<Record<string, number>>;

/** The exact run, as a tuple: no id part can run into the next. */
export function canopyAssistantId(subject: AgentDirectorySubject): string {
  return JSON.stringify([
    "assistant",
    subject.hostId,
    subject.scope.kind === "project" ? subject.scope.projectId : null,
    subject.lane ?? null,
    subject.terminalId,
    subject.incarnation,
  ]);
}

export function assistantSessionLabel(lane: number | undefined): string | null {
  return lane === undefined ? null : `Session ${lane + 1}`;
}

/**
 * The ask an assistant's own observations show, if any. A pending decision
 * (question, approval) or an error stands for as long as it is observed —
 * looking at it doesn't answer it. A handback stands until it has been seen.
 */
export function assistantAsk(
  entry: Pick<AgentDirectoryLiveEntry, "agentState" | "waitingReason" | "handback">,
  seenHandbackAt: number | undefined
): CanopyAssistantAsk | null {
  if (entry.agentState === "waiting") {
    const reason = entry.waitingReason;
    if (reason === "approval" || reason === "question" || reason === "error") return reason;
  }
  const handback = entry.handback?.observedAt;
  if (handback !== undefined && (seenHandbackAt === undefined || handback > seenHandbackAt)) {
    return "handback";
  }
  return null;
}

/**
 * The live assistants a directory names, as rows. Workers stay with the
 * fleet, and a resumable conversation has no run to view or open, so neither
 * is one; nothing here reads a screen.
 */
export function buildAssistantItems(
  directory: AgentDirectory | null,
  options: {
    projectName: (projectId: string) => string | null;
    seen: AssistantHandbacksSeen;
    /** Only this project's, when the panel shows one project. */
    projectId?: string | null;
  }
): CanopyAssistantItem[] {
  if (!directory) return [];
  const items: CanopyAssistantItem[] = [];
  for (const entry of directory.entries) {
    if (entry.state !== "live" || entry.role !== "assistant") continue;
    const { subject } = entry;
    const projectId = subject.scope.kind === "project" ? subject.scope.projectId : null;
    if (options.projectId != null && projectId !== options.projectId) continue;
    const id = canopyAssistantId(subject);
    const session = assistantSessionLabel(subject.lane);
    const scopeLabel =
      projectId === null
        ? "Global"
        : [options.projectName(projectId) ?? "Unknown project", session]
            .filter((part) => part !== null)
            .join(" · ");
    items.push({
      id,
      subject,
      agentName: entry.agentId ? getAgentDisplayTitle(entry.agentId) : null,
      scopeLabel,
      projectId,
      label: entry.label,
      agentState: entry.agentState,
      waitingReason: entry.waitingReason,
      since: entry.since,
      attached: entry.attached !== false,
      handbackAt: entry.handback?.observedAt ?? null,
      ask: assistantAsk(entry, options.seen[id]),
    });
  }
  // Asks first, then by where they run: the directory's own order within each.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => Number(b.item.ask !== null) - Number(a.item.ask !== null) || a.index - b.index)
    .map(({ item }) => item);
}

/** What the row says it is doing, from what was observed. */
export function assistantStatus(item: CanopyAssistantItem): string {
  if (item.ask) return ASSISTANT_ASK_LABEL[item.ask];
  switch (item.agentState) {
    case "working":
      return "Working";
    case "directing":
      return "You're directing it";
    case "waiting":
      return "At its prompt";
    case "completed":
      return "Finished";
    case "exited":
      return "Exited";
    case "idle":
      return "Idle";
    default:
      return "Running";
  }
}

export function assistantMatches(item: CanopyAssistantItem, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = [
    "assistant",
    item.scopeLabel,
    item.label ?? "",
    item.agentName ?? "",
    assistantStatus(item),
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term.toLowerCase()));
}
