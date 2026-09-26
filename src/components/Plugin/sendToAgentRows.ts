import Fuse, { type IFuseOptions } from "fuse.js";
import type { PluginAgentPane, PluginSendToAgentRefusalReason } from "@shared/types/plugin";
import { pickPreselectedPane } from "@/services/agentHandoff/draftTarget";

/** The agent a "new agent" row would start. */
export interface HandoffAgentChoice {
  agentId: string;
  agentName: string;
}

export type SendToAgentRow =
  | { kind: "agent"; id: string; pane: PluginAgentPane }
  | {
      kind: "new-here";
      id: "new-here";
      agent: HandoffAgentChoice;
      worktreeId: string;
      worktreeName: string;
    }
  | { kind: "new-worktree"; id: "new-worktree"; agent: HandoffAgentChoice }
  | { kind: "create-branch"; id: "create-branch"; agent: HandoffAgentChoice };

export interface SendToAgentRowInputs {
  panes: readonly PluginAgentPane[];
  /** The worktree the plugin named — steers preselection and "New agent here". */
  requestedWorktreeId: string | undefined;
  /** The view's active worktree, where "here" falls back to. */
  activeWorktreeId: string | null;
  worktreeNames: ReadonlyMap<string, string>;
  /** The user's default agent, or `null` when none can launch (no creation rows). */
  agent: HandoffAgentChoice | null;
}

/**
 * The agent rows, grouped by worktree, with the preselected agent's group
 * first and the preselected agent at its head — so the palette's default
 * selection (the first navigable row) is the preselection, with no second
 * mechanism to keep in step with it. Other groups keep grid order.
 */
function orderAgentRows(
  panes: readonly PluginAgentPane[],
  preselected: PluginAgentPane | null
): SendToAgentRow[] {
  const groups = new Map<string, PluginAgentPane[]>();
  for (const pane of panes) {
    const key = pane.worktree?.id ?? "";
    const group = groups.get(key);
    if (group) group.push(pane);
    else groups.set(key, [pane]);
  }
  const ordered = [...groups.entries()];
  if (preselected) {
    const key = preselected.worktree?.id ?? "";
    ordered.sort(([a], [b]) => (a === key ? -1 : b === key ? 1 : 0));
  }
  const rows: SendToAgentRow[] = [];
  for (const [, group] of ordered) {
    const sorted = preselected
      ? [...group].sort((a, b) =>
          a.terminalId === preselected.terminalId
            ? -1
            : b.terminalId === preselected.terminalId
              ? 1
              : 0
        )
      : group;
    for (const pane of sorted) rows.push({ kind: "agent", id: pane.terminalId, pane });
  }
  return rows;
}

/**
 * The picker's rows: every agent pane (a pane that cannot take a draft stays,
 * disabled, so the user sees why their agent is missing), then the two ways to
 * start one — in the worktree this is about, or in a new worktree.
 */
export function buildSendToAgentRows(inputs: SendToAgentRowInputs): SendToAgentRow[] {
  const preselected = pickPreselectedPane(inputs.panes, inputs.requestedWorktreeId);
  const rows = orderAgentRows(inputs.panes, preselected);
  if (inputs.agent === null) return rows;

  // "Here" has to be one of this project's worktrees: the plugin's worktree id
  // is taken only if the project knows it, then the preselected agent's, then
  // the active one. With none of them real there is no "here" to offer.
  const hereId = [
    inputs.requestedWorktreeId,
    preselected?.worktree?.id,
    inputs.activeWorktreeId ?? undefined,
  ].find((id): id is string => id !== undefined && inputs.worktreeNames.has(id));
  if (hereId !== undefined) {
    rows.push({
      kind: "new-here",
      id: "new-here",
      agent: inputs.agent,
      worktreeId: hereId,
      worktreeName: inputs.worktreeNames.get(hereId)!,
    });
  }
  rows.push({ kind: "new-worktree", id: "new-worktree", agent: inputs.agent });
  return rows;
}

const FUSE_OPTIONS: IFuseOptions<SendToAgentRow> = {
  keys: [
    { name: "pane.title", weight: 2 },
    { name: "pane.agentId", weight: 1 },
    { name: "pane.worktree.name", weight: 1 },
    { name: "pane.worktree.branch", weight: 0.5 },
  ],
  threshold: 0.4,
  ignoreLocation: true,
};

/**
 * A query narrows the agents; the creation rows always stay, since "none of
 * these, start one" is exactly what a query that matches nothing is asking.
 */
export function filterSendToAgentRows(rows: SendToAgentRow[], query: string): SendToAgentRow[] {
  if (!query.trim()) return rows;
  const agents = rows.filter((row) => row.kind === "agent");
  const rest = rows.filter((row) => row.kind !== "agent");
  const matched = new Fuse(agents, FUSE_OPTIONS).search(query).map((result) => result.item);
  return [...matched, ...rest];
}

/** A disabled agent row's short reason, in place of its agent label. */
export const ROW_REFUSAL_LABEL = {
  "unknown-terminal": "Unavailable",
  "not-agent": "No input bar",
  exited: "Exited",
  "input-bar-off": "Input bar is off",
  "backend-unavailable": "Terminal service unavailable",
  "input-locked": "Input locked",
  restarting: "Restarting",
  "input-busy": "Sending dictation",
  "not-in-grid": "Not in the grid",
  "fleet-armed": "Armed in a fleet",
  "project-unavailable": "Unavailable",
  "launch-failed": "Unavailable",
  "prompt-open": "Unavailable",
  busy: "Unavailable",
} as const satisfies Record<PluginSendToAgentRefusalReason, string>;

/** Whether Enter may act on the row. A pane that would refuse the draft may not. */
export function canSelectSendToAgentRow(row: SendToAgentRow): boolean {
  return row.kind !== "agent" || row.pane.canDraft;
}

/**
 * The worktree heading to draw above an agent row, or `null` for none: only at
 * the start of each worktree's run, and only when the rows span more than one
 * worktree — a single group needs no label.
 */
export function groupHeadingFor(
  rows: readonly SendToAgentRow[],
  index: number,
  spansWorktrees: boolean
): string | null {
  const row = rows[index];
  if (!spansWorktrees || row?.kind !== "agent") return null;
  const previous = index > 0 ? rows[index - 1] : undefined;
  const worktreeId = row.pane.worktree?.id ?? null;
  if (previous?.kind === "agent" && (previous.pane.worktree?.id ?? null) === worktreeId) {
    return null;
  }
  return row.pane.worktree?.name ?? "No worktree";
}
