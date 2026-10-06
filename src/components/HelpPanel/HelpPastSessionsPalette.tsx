import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { suppressPaletteFocusRestore } from "@/components/ui/paletteFocusRestore";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { getAgentConfig } from "@/config/agents";
import { actionService } from "@/services/ActionService";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { usePanelStore } from "@/store/panelStore";
import { usePaletteStore, type PaletteId } from "@/store/paletteStore";
import { logWarn } from "@/utils/logger";
import type { HelpPastSessionPickOutcome } from "@/services/actions/definitions/helpActions";
import type { HelpPastSession } from "@shared/types/ipc/help";
import { isPtyPanel } from "@shared/types/panel";
import { MAX_ASSISTANT_SLOTS } from "@shared/config/assistantSlots";
import type { HelpSessionTab } from "./HelpSessionTabs";

const PALETTE_ID: PaletteId = "assistant-sessions";

export type HelpPastSessionsPaletteItem =
  | {
      kind: "session";
      id: string;
      title: string;
      session: HelpPastSession;
      agentName: string;
      /** Set when a tab already shows this conversation — picking it switches there. */
      openInTab: string | null;
    }
  | { kind: "lane"; id: string; title: string; slot: number };

const FUSE_OPTIONS = { keys: ["title"], threshold: 0.4, ignoreLocation: true };

interface HelpPastSessionsPaletteProps {
  /** The workspace whose assistant history is listed. */
  workspace: { id: string } | null;
  /** The panel's open tabs, for "already open" and for choosing one to replace. */
  tabs: readonly HelpSessionTab[];
}

/**
 * "Resume a past session…" (#13206): the current project's assistant
 * conversations, read from the agents' own transcript stores, newest first.
 *
 * Picking one goes through `help.resumePastSession`, which focuses the tab
 * already showing it or resumes it into a free tab by exact id. With every tab
 * in use the list turns into a choice of which tab to replace — never a silent
 * displacement.
 */
export function HelpPastSessionsPalette({ workspace, tabs }: HelpPastSessionsPaletteProps) {
  const isOpen = usePaletteStore((s) => s.activePaletteId === PALETTE_ID);
  const workspaceId = workspace?.id ?? null;
  const [listing, setListing] = useState<{
    workspaceId: string;
    sessions: HelpPastSession[];
  } | null>(null);
  const [replacing, setReplacing] = useState<HelpPastSession | null>(null);

  useEffect(() => {
    if (!isOpen || !workspaceId) return;
    setReplacing(null);
    let cancelled = false;
    window.electron.help
      .listPastSessions(workspaceId)
      .then((sessions) => {
        if (!cancelled) setListing({ workspaceId, sessions });
      })
      .catch((err) => {
        logWarn("HelpPanel: failed to list past assistant sessions", err);
        if (!cancelled) setListing({ workspaceId, sessions: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, workspaceId]);

  const sessions = listing && listing.workspaceId === workspaceId ? listing.sessions : null;
  const laneTerminals = useHelpPanelStore((s) =>
    tabs.map((tab) => s.sessions[tab.slot]?.terminalId ?? null).join("\0")
  );
  const heldSessionIds = usePanelStore((s) =>
    laneTerminals
      .split("\0")
      .map((terminalId) => {
        const panel = terminalId ? s.panelsById[terminalId] : undefined;
        return panel && isPtyPanel(panel) ? (panel.agentSessionId ?? "") : "";
      })
      .join("\0")
  );

  const items = useMemo<HelpPastSessionsPaletteItem[]>(() => {
    if (replacing) {
      return tabs.map((tab) => ({
        kind: "lane",
        id: `lane:${tab.slot}`,
        title: tab.fullTitle ?? tab.label,
        slot: tab.slot,
      }));
    }
    const held = heldSessionIds.split("\0").map((id) => id.toLowerCase());
    return (sessions ?? []).map((session) => {
      const tabIndex = held.indexOf(session.sessionId.toLowerCase());
      return {
        kind: "session",
        id: `${session.agentId}:${session.sessionId}`,
        title: session.title,
        session,
        agentName: getAgentConfig(session.agentId)?.name ?? session.agentId,
        openInTab: tabIndex >= 0 ? (tabs[tabIndex]?.label ?? null) : null,
      };
    });
  }, [replacing, tabs, sessions, heldSessionIds]);

  const palette = useSearchablePalette<HelpPastSessionsPaletteItem>({
    items,
    fuseOptions: FUSE_OPTIONS,
    maxResults: 100,
    paletteId: PALETTE_ID,
    getItemId: (item) => item.id,
  });
  const { query, results, selectedIndex, setQuery, setSelectedIndex, close } = palette;

  useEffect(() => {
    if (isOpen) setQuery("");
  }, [isOpen, replacing, setQuery]);

  const pick = useCallback(
    async (item: HelpPastSessionsPaletteItem) => {
      const session = item.kind === "session" ? item.session : replacing;
      if (!session) return;
      const result = await actionService.dispatch<{ outcome: HelpPastSessionPickOutcome }>(
        "help.resumePastSession",
        {
          agentId: session.agentId,
          sessionId: session.sessionId,
          ...(item.kind === "lane" && { slot: item.slot }),
        },
        { source: "user" }
      );
      const outcome = result.ok ? result.result?.outcome : undefined;
      if (outcome === "lanes-full" && item.kind === "session") {
        setReplacing(session);
        return;
      }
      // The pick moved the keyboard to a tab; handing it back to whatever
      // opened the palette would undo that a beat later.
      if (outcome === "focused" || outcome === "resumed") suppressPaletteFocusRestore();
      close();
    },
    [replacing, close]
  );

  const handleConfirm = useCallback(() => {
    const item = results[selectedIndex];
    if (item) void pick(item);
  }, [results, selectedIndex, pick]);

  const handleClose = useCallback(() => {
    // Escape from the tab choice steps back to the list rather than out.
    if (replacing) {
      setReplacing(null);
      return;
    }
    close();
  }, [replacing, close]);

  const renderItem = useCallback(
    (
      item: HelpPastSessionsPaletteItem,
      index: number,
      isSelected: boolean,
      onHoverIndex: (index: number) => void
    ) => {
      const meta =
        item.kind === "session"
          ? [item.agentName, item.openInTab ? `Open in ${item.openInTab}` : null]
              .filter(Boolean)
              .join(" · ")
          : null;
      return (
        <button
          key={item.id}
          id={`help-past-session-${item.id}`}
          tabIndex={-1}
          role="option"
          aria-selected={isSelected}
          onPointerDown={(e) => e.preventDefault()}
          onPointerMove={() => onHoverIndex(index)}
          onClick={() => {
            setSelectedIndex(index);
            void pick(item);
          }}
          className={cn(
            PALETTE_ROW_CLASS,
            "w-full flex items-start gap-3 px-3 rounded-[var(--radius-md)] text-left text-text-secondary",
            meta ? "py-2" : "py-1.5"
          )}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-3">
              <div className="flex-1 min-w-0 text-sm font-medium text-text-primary truncate">
                {item.kind === "lane" ? `Replace ${item.title}` : item.title}
              </div>
              {item.kind === "session" && (
                <TimeAgo
                  timestamp={item.session.updatedAt}
                  className="shrink-0 text-xs text-text-secondary"
                />
              )}
            </div>
            {meta && <div className="text-xs text-text-secondary truncate">{meta}</div>}
          </div>
        </button>
      );
    },
    [pick, setSelectedIndex]
  );

  return (
    <SearchablePalette<HelpPastSessionsPaletteItem>
      tier="anchored"
      isOpen={isOpen}
      query={query}
      results={results}
      totalResults={palette.totalResults}
      selectedIndex={selectedIndex}
      onQueryChange={setQuery}
      onSelectPrevious={palette.selectPrevious}
      onSelectNext={palette.selectNext}
      onConfirm={handleConfirm}
      onClose={handleClose}
      onHoverIndex={setSelectedIndex}
      getItemId={(item) => item.id}
      renderItem={renderItem}
      label={
        replacing
          ? `All ${MAX_ASSISTANT_SLOTS} tabs are in use — choose one to replace`
          : "Resume a past session"
      }
      ariaLabel={replacing ? "Choose an assistant tab to replace" : "Resume a past session"}
      searchPlaceholder={replacing ? "Search tabs" : "Search past sessions"}
      itemIdPrefix="help-past-session"
      isLoading={!replacing && sessions === null}
      emptyMessage={sessions === null ? "Loading past sessions…" : "No past sessions yet"}
    />
  );
}
