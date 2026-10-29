import { useCallback, useMemo } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";
import { usePanelStore, usePreferencesStore } from "@/store";
import { isPtyPanel, type PanelKind, type PtyPanelData } from "@shared/types/panel";
import { useSearchablePalette } from "./useSearchablePalette";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";
import { peek as peekTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { terminalClient } from "@/clients";
import { formatForTerminalPaste } from "@shared/utils/terminalInputProtocol";
import { usePaletteStore } from "@/store/paletteStore";
import { deriveTerminalChrome, type TerminalChromeDescriptor } from "@/utils/terminalChrome";
import { getBuiltInRuntimeAgentId } from "@/utils/terminalType";
import {
  draftAgentContext,
  paneHandoffHeading,
  reportDraftNotAdded,
  type AgentHandoffContent,
} from "@/services/agentHandoff/agentDraft";
import { AGENT_CONTEXT_MAX_TEXT_LENGTH } from "@shared/utils/agentContextDrag";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { requestPaneFocus } from "@/components/Terminal/paneFocusRequest";
import { suppressPaletteFocusRestore } from "@/components/ui/paletteFocusRestore";
import { useWorktreeStoreOptional } from "./useWorktreeStore";
import type { WorktreeSnapshot } from "@shared/types";

/**
 * How a row takes the text: an agent with a composer gets it drafted there,
 * anything else — a shell, an agent Daintree draws no composer for — gets it
 * pasted into its own input, which is the one the user sees.
 */
export type SendToAgentDelivery = "draft" | "paste";

export interface SendToAgentItem {
  id: string;
  title: string;
  subtitle?: string;
  terminalKind?: PanelKind;
  chrome: TerminalChromeDescriptor;
  isInputLocked?: boolean;
  delivery: SendToAgentDelivery;
  /**
   * Resolved whether or not the row draws it, because a worktree name has to
   * find its pane even in the single-worktree case where naming every row would
   * be noise. {@link SendToAgentItem.subtitle} carries the visible copy.
   */
  worktreeName?: string;
}

// Module-level state for the opener function (object to avoid react-compiler reassignment warning)
const pendingState = {
  sourceId: null as string | null,
  content: null as AgentHandoffContent | null,
};

type PanelRecord = ReturnType<typeof usePanelStore.getState>["panelsById"][string];

/**
 * A pane the palette lists: a live PTY that is on screen. The one predicate
 * behind the opener, the list and the send, so a pane that leaves the list
 * mid-pick can't still be written to.
 */
function isListedTarget(t: PanelRecord | undefined): t is Extract<PanelRecord, PtyPanelData> {
  return (
    !!t &&
    t.location !== "trash" &&
    t.location !== "background" &&
    t.location !== "overlay" &&
    isPtyPanel(t) &&
    t.hasPty !== false
  );
}

function hasSendTargets(sourceTerminalId: string | null): boolean {
  const { panelsById, panelIds } = usePanelStore.getState();
  return panelIds.some((id) => {
    const t = panelsById[id];
    return isListedTarget(t) && t.id !== sourceTerminalId;
  });
}

export function openSendToAgentPalette(sourceTerminalId: string): boolean {
  const selection = peekTerminalService()?.getCachedSelection(sourceTerminalId);
  if (!selection) return false;
  return openSendToAgentPaletteWithText(
    { text: selection, ...paneHandoffHeading(sourceTerminalId, "Selection") },
    sourceTerminalId
  );
}

/**
 * Opens the send-to-agent palette pre-populated with arbitrary text instead of
 * a cached terminal selection. Used by handoff surfaces (e.g. the agent
 * completion banner) that already have the text to relay, under the heading
 * an agent's draft will show it with. `sourceTerminalId`, when provided, is
 * excluded from the target list so an agent doesn't send its own output back
 * to itself.
 */
export function openSendToAgentPaletteWithText(
  content: AgentHandoffContent,
  sourceTerminalId?: string
): boolean {
  if (!content.text.trim()) return false;
  const sourceId = sourceTerminalId ?? null;
  if (!hasSendTargets(sourceId)) return false;

  pendingState.sourceId = sourceId;
  pendingState.content = content;
  usePaletteStore.getState().openPalette("send-to-agent");
  return true;
}

const FUSE_OPTIONS: IFuseOptions<SendToAgentItem> = {
  keys: [
    { name: "title", weight: 2 },
    { name: "subtitle", weight: 1 },
    // Branch-derived worktree names run long, and Fuse scores by position, so a
    // token past roughly the first 40 characters of one will not match. Turning
    // location scoring off repairs that but reranks the primary field, where an
    // incidental substring ("pre-fix-es") then beats the whole word — too high a
    // price. The filter below catches the tail with a plain substring pass
    // instead, appended after the ranked results.
    { name: "worktreeName", weight: 0.5 },
  ],
  threshold: 0.4,
  includeScore: true,
};

/** The reason a locked row draws in place of its agent, matching the plugin picker's. */
export const INPUT_LOCKED_REASON = "Input locked";

/**
 * The row's second line. The agent label only when the title doesn't already
 * open with it — "Claude: fix auth tests" over "Claude" spent a line on one
 * fact — and the worktree only when the targets span more than one. A locked
 * row says why in place of the agent, so the line that has to be read is the
 * one that explains why Enter skips it.
 */
function subtitleFor(
  title: string,
  chromeLabel: string,
  isInputLocked: boolean,
  worktreeName: string | undefined
): string | undefined {
  const t = title.trim().toLowerCase();
  const label = chromeLabel.trim();
  const l = label.toLowerCase();
  const echoed = !l || t === l || t.startsWith(`${l}:`) || t.startsWith(`${l} `);
  const lead = isInputLocked ? INPUT_LOCKED_REASON : echoed ? undefined : label;
  return [lead, worktreeName].filter(Boolean).join(" · ") || undefined;
}

function deliveryFor(panel: PtyPanelData): SendToAgentDelivery {
  return getBuiltInRuntimeAgentId(panel) !== undefined ? "draft" : "paste";
}

/**
 * How the pane would take the text right now, or `null` when it can't. Read at
 * send time, not from the row: a pane can lock, exit or close while the palette
 * sits open.
 */
function liveDelivery(targetId: string): SendToAgentDelivery | null {
  const t = usePanelStore.getState().panelsById[targetId];
  return isListedTarget(t) && !t.isInputLocked ? deliveryFor(t) : null;
}

function pasteToTarget(targetId: string, text: string): void {
  // Terminal selection text carries whatever the source pane printed, so it
  // goes through the paste boundary in either mode. Without a managed instance
  // there is no mode to read — wrapped is the safe reading — and nothing to
  // notify either, which is why that branch stays separate.
  const service = peekTerminalService();
  const managed = service?.get(targetId);
  if (managed) {
    terminalClient.write(
      targetId,
      formatForTerminalPaste(text, {
        bracketedPasteMode: managed.terminal.modes.bracketedPasteMode,
      })
    );
    service?.notifyUserInput(targetId);
  } else {
    terminalClient.write(targetId, formatForTerminalPaste(text, { bracketedPasteMode: true }));
  }
}

/**
 * Bring a pane forward with the keyboard in its composer, the walk the other
 * reveal paths take: its worktree, then its tab — a group renders its stored
 * tab over the focused one — then focus.
 */
function revealComposer(terminalId: string): void {
  const state = usePanelStore.getState();
  const worktreeId = state.panelsById[terminalId]?.worktreeId?.trim();
  const selection = useWorktreeSelectionStore.getState();
  if (worktreeId && worktreeId !== selection.activeWorktreeId) {
    selection.trackTerminalFocus(worktreeId, terminalId);
    selection.selectWorktree(worktreeId);
  }
  const group = state.getPanelGroup(terminalId);
  if (group) state.setActiveTab(group.id, terminalId);
  state.activateTerminal(terminalId);
  requestPaneFocus(terminalId, "hybridInput");
}

function clearPending(): void {
  pendingState.sourceId = null;
  pendingState.content = null;
}

const MAX_RESULTS = 20;

const EMPTY_PANEL_IDS: string[] = [];
const EMPTY_PANELS_BY_ID: ReturnType<typeof usePanelStore.getState>["panelsById"] = {};
const EMPTY_WORKTREES = new Map<string, WorktreeSnapshot>();

export function useSendToAgentPalette() {
  // Always mounted in App: subscribe to the panel map only while open — a
  // live selector here re-rendered the whole App on every agent-state flip
  // and status flush. The open() helpers above already read via getState().
  const isOpen = usePaletteStore((state) => state.activePaletteId === "send-to-agent");
  const panelIds = usePanelStore((state) => (isOpen ? state.panelIds : EMPTY_PANEL_IDS));
  const panelsById = usePanelStore((state) => (isOpen ? state.panelsById : EMPTY_PANELS_BY_ID));
  const showAgentTaskTitles = usePreferencesStore((s) => s.showAgentTaskTitles);
  // The raw map rather than useWorktrees(): its `enabled` flag gates only the
  // map, leaving five status selectors live, which is the always-on re-render
  // the gating above exists to avoid.
  const worktrees = useWorktreeStoreOptional(
    (state) => (isOpen ? state.worktrees : EMPTY_WORKTREES),
    EMPTY_WORKTREES
  );

  const items = useMemo<SendToAgentItem[]>(() => {
    const sourceId = isOpen ? pendingState.sourceId : null;
    const result: SendToAgentItem[] = [];
    const worktreeIds = new Set<string>();

    for (const id of panelIds) {
      const t = panelsById[id];
      if (!isListedTarget(t)) continue;
      if (sourceId && t.id === sourceId) continue;

      const chrome = deriveTerminalChrome(t);
      if (t.worktreeId) worktreeIds.add(t.worktreeId);
      // Full composed display title so rows read (and fuzzy-match) the same
      // as the live tab: "Claude: fix auth tests".
      const title = getTerminalDisplayTitle(t, "full", { showTask: showAgentTaskTitles });

      result.push({
        id: t.id,
        title,
        subtitle: subtitleFor(title, chrome.label, !!t.isInputLocked, undefined),
        terminalKind: t.kind,
        chrome,
        isInputLocked: t.isInputLocked,
        delivery: deliveryFor(t),
        worktreeName: t.worktreeId ? worktrees.get(t.worktreeId)?.name : undefined,
      });
    }

    // Counted over every eligible target, not the filtered results, so the
    // label cannot appear and vanish as a query narrows the list — and so a
    // second worktree still counts when it sits past the MAX_RESULTS cut.
    if (worktreeIds.size > 1) {
      for (const item of result) {
        if (!item.worktreeName) continue;
        item.subtitle = subtitleFor(
          item.title,
          item.chrome.label,
          !!item.isInputLocked,
          item.worktreeName
        );
      }
    }

    return result;
  }, [panelIds, panelsById, isOpen, showAgentTaskTitles, worktrees]);

  const fuse = useMemo(() => new Fuse(items, FUSE_OPTIONS), [items]);

  const filterFn = useCallback(
    (allItems: SendToAgentItem[], query: string): SendToAgentItem[] => {
      const q = query.trim().toLowerCase();
      if (!q) return allItems;
      const ranked = fuse.search(query).map((r) => r.item);
      // Fuse scores by position, so the tail of a long worktree name
      // ("…-exponential-backoff") never matches — see FUSE_OPTIONS. A plain
      // substring hit there is appended below the ranked results rather than
      // turning location scoring off, which would rerank the titles.
      const seen = new Set(ranked);
      const tails = allItems.filter(
        (item) => !seen.has(item) && item.worktreeName?.toLowerCase().includes(q)
      );
      return tails.length > 0 ? [...ranked, ...tails] : ranked;
    },
    [fuse]
  );

  const canNavigate = useCallback((item: SendToAgentItem) => !item.isInputLocked, []);

  const palette = useSearchablePalette<SendToAgentItem>({
    items,
    filterFn,
    maxResults: MAX_RESULTS,
    canNavigate,
    paletteId: "send-to-agent",
  });

  const selectItem = useCallback(
    (item: SendToAgentItem) => {
      const content = pendingState.content;
      if (!content || item.id === pendingState.sourceId) return;
      // Stay open on a refusal: the row redraws with its reason from the same
      // store change, and the text is still there to send elsewhere. That
      // includes a row whose delivery changed under it — an agent that quit
      // back to its shell would otherwise take a paste its row never offered.
      if (liveDelivery(item.id) !== item.delivery) return;
      if (item.delivery === "paste") {
        pasteToTarget(item.id, content.text);
        clearPending();
        palette.close();
        return;
      }
      // A draft holds a bounded block. A selection can run past it, and cutting
      // it short would hand the agent less than the user picked without saying.
      if (content.text.length > AGENT_CONTEXT_MAX_TEXT_LENGTH) {
        reportDraftNotAdded(
          `it's over ${AGENT_CONTEXT_MAX_TEXT_LENGTH.toLocaleString("en-US")} characters`
        );
        return;
      }
      // The draft gate reports its own refusal.
      if (draftAgentContext(item.id, content).status !== "drafted") return;
      clearPending();
      // The keyboard goes to the composer the text went into, so the user can
      // write the instruction that goes with it.
      suppressPaletteFocusRestore();
      palette.close();
      revealComposer(item.id);
    },
    [palette]
  );

  const confirmSelection = useCallback(() => {
    const { results, selectedIndex } = palette;
    if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
      selectItem(results[selectedIndex]!);
    }
  }, [palette, selectItem]);

  return {
    ...palette,
    selectItem,
    confirmSelection,
  };
}
