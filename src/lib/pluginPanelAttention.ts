import type { PanelLocation } from "@shared/types/panel";
import type { PluginPanelActivityReport } from "@shared/types/plugin";
import {
  ATTENTION_FILTER_BANDS,
  FINISHED_FILTER_BANDS,
  FLEET_BANDS,
  UNREAD_FILTER_BANDS,
  type FleetBand,
} from "@/lib/fleetAttention";
import {
  describePluginPanelActivity,
  type PluginPanelActivityShown,
} from "@/lib/pluginPanelActivityPresentation";

/**
 * A plugin panel's own row in the attention views (#13821): Pilot, the dock's
 * Waiting and Unread pills and the sidebar's attention filters.
 *
 * Built only in the renderer, from what this view can see — its own panels, the
 * reports main replays to it, and the plugins the user switched on — and never
 * turned into a fleet run. That is what keeps plugin rows out of everything main
 * counts: the OS badge, the window title, Canopy's reader, and every agent's
 * state, park, snooze and read mark.
 */
export interface PluginAttentionRow {
  /** One reporter per panel — the plugin its kind belongs to — so the panel id is the row's identity. */
  panelId: string;
  /** Plugin instance id. */
  pluginId: string;
  pluginName: string;
  /** The panel's title, as its header shows it. */
  title: string;
  kind: string;
  worktreeId: string | null;
  band: FleetBand;
  shown: PluginPanelActivityShown;
  reason: string | null;
  /** "Reported by <Plugin>: <state>", with the plugin's reason when it gave one. */
  description: string;
  revision: number;
}

/** What a park or snooze holds against a plugin panel's report. Session-only. */
export type PluginAttentionShelf =
  | {
      kind: "parked";
      pluginId: string;
      /** The report parked: a new one from the plugin releases the park. */
      revision: number;
      at: number;
    }
  | { kind: "snoozed"; pluginId: string; until: number; at: number };

/** The fields of a panel record the join reads. */
export interface PluginAttentionPanel {
  id: string;
  title: string;
  kind: string;
  location: PanelLocation | undefined;
  worktreeId: string | null;
}

export interface PluginAttentionInputs {
  activityByPanelId: Readonly<Record<string, Readonly<Record<string, PluginPanelActivityReport>>>>;
  seenRevisionByPanelId: Readonly<Record<string, number>>;
  panels: ReadonlyMap<string, PluginAttentionPanel>;
  /** The plugin whose kind a panel is, when that kind declares `reportsActivity`. */
  reporterFor: (panelId: string) => string | null;
  grantedPluginIds: ReadonlySet<string>;
  pluginName: (pluginId: string) => string;
  shelfByPanelId: Readonly<Record<string, PluginAttentionShelf>>;
  /** Ids of this view's worktrees; empty while unknown, which orphans nothing. */
  worktreeIds: ReadonlySet<string>;
  nowMs: number;
}

const BAND_RANK = new Map<FleetBand, number>(FLEET_BANDS.map((band, i) => [band, i]));

/**
 * Where a plugin's report sits, in the agents' band vocabulary. A failure is
 * the blocked ring a stopped subagent wears; a finished report is unread until
 * its panel has been in front of the user. A shelf outranks the report, the
 * way an agent's park and snooze outrank its state.
 */
export function pluginAttentionBand(
  report: PluginPanelActivityReport,
  seen: boolean,
  shelf: PluginAttentionShelf | undefined,
  nowMs: number
): FleetBand {
  if (shelf?.kind === "parked" && shelf.revision === report.revision) return "parked";
  if (shelf?.kind === "snoozed" && shelf.until > nowMs) return "snoozed";
  switch (report.state) {
    case "waiting":
      return "needs-you";
    case "failed":
      return "blocked";
    case "working":
      return "running";
    case "finished":
      return seen ? "done" : "review";
  }
}

/**
 * A panel that can be opened from a row: one in the grid or the dock. A dialog
 * panel lives behind a modal that may already be gone, and a background, trash
 * or overlay one is not somewhere a row could take the user.
 */
function isReachable(panel: PluginAttentionPanel, worktreeIds: ReadonlySet<string>): boolean {
  if (panel.location !== undefined && panel.location !== "grid" && panel.location !== "dock") {
    return false;
  }
  if (panel.worktreeId !== null && worktreeIds.size > 0 && !worktreeIds.has(panel.worktreeId)) {
    return false;
  }
  return true;
}

/**
 * Every plugin panel row this view can show, worst band first.
 *
 * A row needs all three halves of the join: a report from the plugin whose kind
 * the panel is, a panel this view holds and can open, and the user's "Show in
 * attention views" switch for that plugin. Declaring `reportsActivity` alone
 * turns nothing on.
 */
export function derivePluginAttentionRows(inputs: PluginAttentionInputs): PluginAttentionRow[] {
  const rows: PluginAttentionRow[] = [];
  for (const [panelId, byPlugin] of Object.entries(inputs.activityByPanelId)) {
    const pluginId = inputs.reporterFor(panelId);
    if (pluginId === null || !inputs.grantedPluginIds.has(pluginId)) continue;
    const report = byPlugin[pluginId];
    if (report === undefined) continue;
    const panel = inputs.panels.get(panelId);
    if (panel === undefined || !isReachable(panel, inputs.worktreeIds)) continue;

    const seen = inputs.seenRevisionByPanelId[panelId] === report.revision;
    const pluginName = inputs.pluginName(pluginId);
    const presentation = describePluginPanelActivity(pluginId, report, seen, pluginName);
    const shelf = inputs.shelfByPanelId[panelId];
    rows.push({
      panelId,
      pluginId,
      pluginName,
      title: panel.title,
      kind: panel.kind,
      worktreeId: panel.worktreeId,
      band: pluginAttentionBand(
        report,
        seen,
        shelf?.pluginId === pluginId ? shelf : undefined,
        inputs.nowMs
      ),
      shown: presentation.shown,
      reason: report.reason ?? null,
      description: presentation.description,
      revision: report.revision,
    });
  }
  return rows.sort(comparePluginAttentionRows);
}

/**
 * Worst band first, then a stable identity. Reports carry a revision, not a
 * time, so there is no honest age to rank by.
 */
export function comparePluginAttentionRows(a: PluginAttentionRow, b: PluginAttentionRow): number {
  const byBand = (BAND_RANK.get(a.band) ?? 0) - (BAND_RANK.get(b.band) ?? 0);
  if (byBand !== 0) return byBand;
  const byTitle = a.title.localeCompare(b.title);
  if (byTitle !== 0) return byTitle;
  return a.panelId < b.panelId ? -1 : a.panelId > b.panelId ? 1 : 0;
}

/** Rows asking for something: the dock's Waiting pill and the sidebar's Attention bucket. */
export function isPluginAttentionWaiting(row: PluginAttentionRow): boolean {
  return ATTENTION_FILTER_BANDS.has(row.band);
}

/** Finished reports nobody has looked at: the dock's Unread pill. */
export function isPluginAttentionUnread(row: PluginAttentionRow): boolean {
  return UNREAD_FILTER_BANDS.has(row.band);
}

/** What one worktree's plugin rows add to its sidebar buckets. */
export interface PluginWorktreeAttention {
  working: boolean;
  attention: boolean;
  finished: boolean;
  unseen: boolean;
}

/**
 * Plugin facts per worktree, for the bucket derivation to fold in beside the
 * worktree's agents. A panel with no worktree has no card to admit, so it
 * reaches Pilot and the dock only.
 */
export function pluginAttentionByWorktree(
  rows: readonly PluginAttentionRow[]
): ReadonlyMap<string, PluginWorktreeAttention> {
  const out = new Map<string, PluginWorktreeAttention>();
  for (const row of rows) {
    if (row.worktreeId === null) continue;
    const working = row.band === "running";
    const attention = ATTENTION_FILTER_BANDS.has(row.band);
    const finished = FINISHED_FILTER_BANDS.has(row.band);
    if (!working && !attention && !finished) continue;
    const facts = out.get(row.worktreeId) ?? {
      working: false,
      attention: false,
      finished: false,
      unseen: false,
    };
    facts.working ||= working;
    facts.attention ||= attention;
    facts.finished ||= finished;
    facts.unseen ||= row.band === "review";
    out.set(row.worktreeId, facts);
  }
  return out;
}
