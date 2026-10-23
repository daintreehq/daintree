import { useEffect, useMemo } from "react";
import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";
import type { PanelLocation } from "@shared/types/panel";
import {
  derivePluginAttentionRows,
  isPluginAttentionUnread,
  isPluginAttentionWaiting,
  pluginAttentionByWorktree,
  type PluginAttentionInputs,
  type PluginAttentionPanel,
  type PluginAttentionRow,
  type PluginWorktreeAttention,
} from "@/lib/pluginPanelAttention";
import { activityReporterForPanel } from "@/lib/pluginPanelActivityPresentation";
import { usePanelStore } from "@/store/panelStore";
import { usePluginPanelActivityStore } from "@/store/pluginPanelActivityStore";
import { usePluginPanelAttentionStore } from "@/store/pluginPanelAttentionStore";
import { usePluginRuntimeStore, type PluginRuntimeMeta } from "@/store/pluginRuntimeStore";

const EMPTY_ROWS: readonly PluginAttentionRow[] = [];
const EMPTY_WORKTREE_ATTENTION: ReadonlyMap<string, PluginWorktreeAttention> = new Map();
const NO_WORKTREE_IDS: ReadonlySet<string> = new Set();

const PANEL_LOCATIONS: ReadonlySet<string> = new Set<PanelLocation>([
  "grid",
  "dock",
  "overlay",
  "trash",
  "background",
  "dialog",
]);

function isPanelLocation(value: string): value is PanelLocation {
  return PANEL_LOCATIONS.has(value);
}

// Separators no title, kind or id carries, so the key splits back exactly.
const FIELD = "\u0000";
const RECORD = "\u0001";

interface PanelRecord {
  id: string;
  title?: string;
  kind?: string;
  pluginPanelKindId?: string;
  location?: PanelLocation;
  worktreeId?: string;
}

interface ReportedPanel extends PluginAttentionPanel {
  /** The panel's plugin kind, kept apart from `kind` on a PTY-backed plugin panel (#13213). */
  pluginPanelKindId: string | undefined;
}

/**
 * The fields of the panels that hold a report, as one string. A primitive, so a
 * streaming agent's buffer flush — which replaces `panelsById` up to 60 times a
 * second — re-renders nothing here unless a reported panel itself changed.
 */
function reportedPanelKey(
  panelsById: Readonly<Record<string, PanelRecord | undefined>>,
  activityByPanelId: Readonly<Record<string, unknown>>
): string {
  let key = "";
  for (const panelId of Object.keys(activityByPanelId)) {
    const panel = panelsById[panelId];
    if (!panel) continue;
    key +=
      [
        panel.id,
        panel.title ?? "",
        panel.kind ?? "",
        panel.pluginPanelKindId ?? "",
        panel.location ?? "",
        panel.worktreeId?.trim() ?? "",
      ].join(FIELD) + RECORD;
  }
  return key;
}

function parseReportedPanels(key: string): Map<string, ReportedPanel> {
  const panels = new Map<string, ReportedPanel>();
  for (const record of key.split(RECORD)) {
    if (record === "") continue;
    const [id = "", title = "", kind = "", pluginPanelKindId = "", location = "", worktreeId = ""] =
      record.split(FIELD);
    panels.set(id, {
      id,
      title,
      kind: pluginPanelKindId || kind,
      pluginPanelKindId: pluginPanelKindId || undefined,
      location: isPanelLocation(location) ? location : undefined,
      worktreeId: worktreeId === "" ? null : worktreeId,
    });
  }
  return panels;
}

interface AttentionSources {
  panelKey: string;
  activityByPanelId: PluginAttentionInputs["activityByPanelId"];
  seenRevisionByPanelId: PluginAttentionInputs["seenRevisionByPanelId"];
  grantedPluginIds: ReadonlySet<string>;
  shelfByPanelId: PluginAttentionInputs["shelfByPanelId"];
  pluginMetaById: ReadonlyMap<string, PluginRuntimeMeta>;
}

function buildRows(sources: AttentionSources): readonly PluginAttentionRow[] {
  const { panelKey, grantedPluginIds, pluginMetaById } = sources;
  if (grantedPluginIds.size === 0 || panelKey === "") return EMPTY_ROWS;
  const panels = parseReportedPanels(panelKey);
  const rows = derivePluginAttentionRows({
    activityByPanelId: sources.activityByPanelId,
    seenRevisionByPanelId: sources.seenRevisionByPanelId,
    panels,
    reporterFor: (panelId) => activityReporterForPanel(panels.get(panelId)),
    grantedPluginIds,
    // The manifest id when there is no display name, never the raw instance
    // key: a machine-local project id is not a name.
    pluginName: (pluginId) =>
      pluginMetaById.get(pluginId)?.displayName ?? pluginManifestIdFromInstanceKey(pluginId),
    shelfByPanelId: sources.shelfByPanelId,
    // Orphaned worktrees are the surface's to drop: only it knows which
    // worktrees exist, and an unknown set orphans nothing.
    worktreeIds: NO_WORKTREE_IDS,
    nowMs: Date.now(),
  });
  return rows.length === 0 ? EMPTY_ROWS : rows;
}

/**
 * Every plugin panel row this view can show in the attention views (#13821),
 * worst band first. Empty unless the user switched a reporting plugin on.
 */
export function usePluginPanelAttentionRows(): readonly PluginAttentionRow[] {
  const initActivity = usePluginPanelActivityStore((s) => s.init);
  const initAttention = usePluginPanelAttentionStore((s) => s.init);
  const initRuntime = usePluginRuntimeStore((s) => s.init);
  useEffect(() => {
    initActivity();
    initAttention();
    initRuntime();
  }, [initActivity, initAttention, initRuntime]);

  const activityByPanelId = usePluginPanelActivityStore((s) => s.activityByPanelId);
  const seenRevisionByPanelId = usePluginPanelActivityStore((s) => s.seenRevisionByPanelId);
  const grantedPluginIds = usePluginPanelAttentionStore((s) => s.grantedPluginIds);
  const shelfByPanelId = usePluginPanelAttentionStore((s) => s.shelfByPanelId);
  const pluginMetaById = usePluginRuntimeStore((s) => s.pluginMetaById);
  const panelKey = usePanelStore((state) =>
    grantedPluginIds.size === 0 ? "" : reportedPanelKey(state.panelsById, activityByPanelId)
  );

  return useMemo(
    () =>
      buildRows({
        panelKey,
        activityByPanelId,
        seenRevisionByPanelId,
        grantedPluginIds,
        shelfByPanelId,
        pluginMetaById,
      }),
    [
      panelKey,
      activityByPanelId,
      seenRevisionByPanelId,
      grantedPluginIds,
      shelfByPanelId,
      pluginMetaById,
    ]
  );
}

/** Plugin rows asking for something: the dock's Waiting pill. */
export function usePluginAttentionWaitingRows(): readonly PluginAttentionRow[] {
  const rows = usePluginPanelAttentionRows();
  return useMemo(() => filterRows(rows, isPluginAttentionWaiting), [rows]);
}

/** Finished plugin reports nobody has looked at: the dock's Unread pill. */
export function usePluginAttentionUnreadRows(): readonly PluginAttentionRow[] {
  const rows = usePluginPanelAttentionRows();
  return useMemo(() => filterRows(rows, isPluginAttentionUnread), [rows]);
}

/** What each worktree's plugin rows add to its sidebar buckets. */
export function usePluginWorktreeAttention(): ReadonlyMap<string, PluginWorktreeAttention> {
  const rows = usePluginPanelAttentionRows();
  return useMemo(
    () => (rows.length === 0 ? EMPTY_WORKTREE_ATTENTION : pluginAttentionByWorktree(rows)),
    [rows]
  );
}

/** The same facts, read once, for paths outside React (keyboard cycling). */
export function readPluginWorktreeAttention(): ReadonlyMap<string, PluginWorktreeAttention> {
  const { activityByPanelId, seenRevisionByPanelId } = usePluginPanelActivityStore.getState();
  const { grantedPluginIds, shelfByPanelId } = usePluginPanelAttentionStore.getState();
  const rows = buildRows({
    panelKey:
      grantedPluginIds.size === 0
        ? ""
        : reportedPanelKey(usePanelStore.getState().panelsById, activityByPanelId),
    activityByPanelId,
    seenRevisionByPanelId,
    grantedPluginIds,
    shelfByPanelId,
    pluginMetaById: usePluginRuntimeStore.getState().pluginMetaById,
  });
  return rows.length === 0 ? EMPTY_WORKTREE_ATTENTION : pluginAttentionByWorktree(rows);
}

function filterRows(
  rows: readonly PluginAttentionRow[],
  keep: (row: PluginAttentionRow) => boolean
): readonly PluginAttentionRow[] {
  if (rows.length === 0) return EMPTY_ROWS;
  const kept = rows.filter(keep);
  return kept.length === 0 ? EMPTY_ROWS : kept;
}
