import type {
  AgentDirectory,
  AgentDirectoryConfirmation,
  AgentDirectoryCoverage,
  AgentDirectoryLiveEntry,
  AgentDirectoryNotices,
  AgentDirectorySubject,
} from "@shared/types/agentDirectory";
import { getAgentDisplayTitle } from "@shared/config/agentRegistry";
import { pluralize } from "@/lib/pluralize";
import { agoPhrase } from "@/lib/projectRowStatus";

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
 * Daintree confirmation one of its calls waits on, a question, an approval or
 * an error its terminal stopped on, or a handback not yet seen. A wait at its
 * ordinary prompt is no ask at all.
 */
export type CanopyAssistantAsk = "confirm" | "approval" | "question" | "error" | "handback";

export const ASSISTANT_ASK_LABEL: Record<CanopyAssistantAsk, string> = {
  confirm: "Waiting on your confirmation",
  approval: "Wants approval",
  question: "Asking you",
  error: "Stopped on an error",
  handback: "Handed back",
};

export interface CanopyAssistantItem {
  /** Unique across hosts, lanes and launches; never a worker's run id. */
  id: string;
  subject: AgentDirectorySubject;
  /** The agent implementation it runs on, as the directory names it. */
  agentId: string | null;
  /** The agent it runs on (Claude, Codex…): never its role, which is always Daintree Assistant. */
  agentName: string | null;
  /** Where it runs: its project, host and session, or the global assistant. */
  scopeLabel: string;
  projectId: string | null;
  /** Its project's name; null for the global assistant. */
  projectName: string | null;
  /** The emoji its project wears, as a worker's place line leads with it. */
  projectEmoji: string | null;
  /** The machine it runs on, named only when the list spans hosts. */
  hostName: string | null;
  /** Which of its project's sessions it is; null when it isn't one of several. */
  session: string | null;
  label: string | null;
  agentState: AgentDirectoryLiveEntry["agentState"];
  waitingReason: AgentDirectoryLiveEntry["waitingReason"];
  since: number | null;
  /** Shown in a window on this machine; false while it runs with no view. */
  attached: boolean;
  handbackAt: number | null;
  ask: CanopyAssistantAsk | null;
  /** The oldest Daintree confirmation its calls wait on, unexpired; null when none. */
  confirmation: AgentDirectoryConfirmation | null;
  /** How many wait in all, the one above included. */
  confirmationCount: number;
  /** Its terminal notices as main holds them; null when none, or not reported. */
  notices: AgentDirectoryNotices | null;
  /** The read it came from, when that wasn't a current one; null when it was. */
  coverage: Exclude<AgentDirectoryCoverage, "ok"> | null;
  /** When that read observed it. */
  observedAt: number | null;
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
  seenHandbackAt: number | undefined,
  confirming = false
): CanopyAssistantAsk | null {
  // Its call is held on the dialog, whatever its terminal shows meanwhile.
  if (confirming) return "confirm";
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
    projectEmoji?: (projectId: string) => string | null;
    /** This machine's name, when the list spans hosts; nothing otherwise. */
    hostName?: string | null;
    seen: AssistantHandbacksSeen;
    /** Only this project's, when the panel shows one project. */
    projectId?: string | null;
    /** Epoch ms to hold confirmations against; the read's own time when not given. */
    now?: number;
  }
): CanopyAssistantItem[] {
  if (!directory) return [];
  const coverage = directory.coverage === "ok" ? null : directory.coverage;
  // A confirmation lives for seconds: one from a read that wasn't current, or
  // past its deadline, may already be answered or gone, and isn't offered.
  const now = options.now ?? directory.observedAt ?? Number.POSITIVE_INFINITY;
  const items: CanopyAssistantItem[] = [];
  for (const entry of directory.entries) {
    if (entry.state !== "live" || entry.role !== "assistant") continue;
    const { subject } = entry;
    const projectId = subject.scope.kind === "project" ? subject.scope.projectId : null;
    if (options.projectId != null && projectId !== options.projectId) continue;
    const id = canopyAssistantId(subject);
    const session = assistantSessionLabel(subject.lane);
    const projectName =
      projectId === null ? null : (options.projectName(projectId) ?? "Unknown project");
    const hostName = options.hostName ?? null;
    const scopeLabel =
      projectName === null
        ? "Global"
        : [projectName, hostName, session].filter((part) => part !== null).join(" · ");
    const confirmations =
      coverage === null
        ? (entry.confirmations?.waiting ?? []).filter(
            (confirmation) => confirmation.expiresAt > now
          )
        : [];
    items.push({
      id,
      subject,
      agentId: entry.agentId,
      agentName: entry.agentId ? getAgentDisplayTitle(entry.agentId) : null,
      scopeLabel,
      projectId,
      projectName,
      projectEmoji: projectId === null ? null : (options.projectEmoji?.(projectId) ?? null),
      hostName,
      session,
      label: entry.label,
      agentState: entry.agentState,
      waitingReason: entry.waitingReason,
      since: entry.since,
      attached: entry.attached !== false,
      handbackAt: entry.handback?.observedAt ?? null,
      ask: assistantAsk(entry, options.seen[id], confirmations.length > 0),
      confirmation: confirmations[0] ?? null,
      confirmationCount:
        confirmations.length + (confirmations.length > 0 ? (entry.confirmations?.omitted ?? 0) : 0),
      notices: entry.notices ?? null,
      coverage,
      observedAt: directory.observedAt,
    });
  }
  // Asks first, then by where they run: the directory's own order within each.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => Number(b.item.ask !== null) - Number(a.item.ask !== null) || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * The notices it asked for, as held for it: how many terminals it watches and
 * what waits to reach its prompt. Nothing when it watches nothing — that is
 * no claim it stopped working.
 */
export function assistantNoticeSummary(notices: AgentDirectoryNotices | null): string | null {
  const parts = [watchingNote(notices), undeliveredNote(notices)].filter(
    (part): part is string => part !== null
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

function watchingNote(notices: AgentDirectoryNotices | null): string | null {
  return notices && notices.pending > 0
    ? `Watching ${pluralize(notices.pending, "terminal")}`
    : null;
}

function undeliveredNote(notices: AgentDirectoryNotices | null): string | null {
  if (!notices || notices.ready === 0) return null;
  const waiting = `${pluralize(notices.ready, "notice")} not delivered`;
  const why = NOTICE_DELIVERY_NOTE[notices.delivery];
  return why ? `${waiting} (${why})` : waiting;
}

/** Where delivery stands, by its mechanics alone: the reason isn't in the directory. */
const NOTICE_DELIVERY_NOTE: Partial<Record<AgentDirectoryNotices["delivery"], string>> = {
  scheduled: "due shortly",
  held: "held for now",
  blocked: "held until it's back at its prompt",
  outstanding: "the last one's turn hasn't ended",
  failed: "last delivery unconfirmed",
};

/** A read that wasn't current, in words; null for a current one. */
export function assistantCoverageNote(item: CanopyAssistantItem): string | null {
  switch (item.coverage) {
    case "stale":
      return "Last known; the latest read failed";
    case "unreachable":
      return "This host can't be reached";
    case "unsupported":
      return "This host doesn't report its assistants";
    default:
      return null;
  }
}

/**
 * Everything said of how it supervises and how it was read, in full: the
 * pane and the row's description carry all of it, the row one note.
 */
export function assistantSupervision(item: CanopyAssistantItem): string[] {
  return [
    assistantCoverageNote(item),
    assistantNoticeSummary(item.notices),
    item.attached ? null : "No window here",
  ].filter((part): part is string => part !== null);
}

/**
 * The one note the row has room for, the most pressing first: a read that
 * may be out of date outranks a count that reassures, and notices stuck on
 * their way outrank how many terminals it watches.
 */
export function assistantRowNote(item: CanopyAssistantItem): string | null {
  return (
    assistantCoverageNote(item) ??
    undeliveredNote(item.notices) ??
    (item.attached ? null : "No window here") ??
    watchingNote(item.notices)
  );
}

/**
 * When what the row says began. An ask is as old as the thing it asks
 * about — the call held on a dialog, the handback marker — and the rest is
 * as old as the last observed change of state.
 */
export function assistantStateSince(item: CanopyAssistantItem): number | null {
  if (item.ask === "confirm") return item.confirmation?.since ?? item.since;
  if (item.ask === "handback") return item.handbackAt ?? item.since;
  return item.since;
}

/** The row's clock, read aloud with the verb that says what it measures. */
export function assistantAgePhrase(item: CanopyAssistantItem, age: string): string {
  switch (item.ask) {
    case "confirm":
    case "approval":
    case "question":
      return `waiting for ${age}`;
    case "error":
      return `blocked for ${age}`;
    case "handback":
      return `handed back ${agoPhrase(age)}`;
    default:
      break;
  }
  switch (item.agentState) {
    case "working":
      return `working for ${age}`;
    case "waiting":
      return `at its prompt for ${age}`;
    case "completed":
      return `finished ${agoPhrase(age)}`;
    case "exited":
      return `exited ${agoPhrase(age)}`;
    default:
      return `for ${age}`;
  }
}

/** What the row says it is doing, from what was observed. */
export function assistantStatus(item: CanopyAssistantItem): string {
  if (item.ask === "confirm" && item.confirmation) {
    const more = item.confirmationCount > 1 ? ` and ${item.confirmationCount - 1} more` : "";
    return `${ASSISTANT_ASK_LABEL.confirm}: ${item.confirmation.actionId}${more}`;
  }
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
    assistantNoticeSummary(item.notices) ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term.toLowerCase()));
}
