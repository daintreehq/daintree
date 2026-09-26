import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { Badge } from "@/components/ui/badge";
import { GitBranchPlus, Plus } from "@/components/icons";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PluginProvenance } from "./PluginProvenance";
import { usePluginAttribution } from "@/hooks/usePluginAttribution";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";
import { usePluginPromptStore } from "@/store/pluginPromptStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useAgentPreferencesStore } from "@/store/agentPreferencesStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { getDefaultAgentId } from "@/lib/resolveAgentId";
import { getAgentConfig } from "@shared/config/agentRegistry";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { draftAgentContext, readDraftTargetInputs } from "@/services/agentHandoff/agentDraft";
import { buildAgentPanes } from "@/services/agentHandoff/draftTarget";
import { usePreferencesStore } from "@/store/preferencesStore";
import {
  branchNameForHandoff,
  launchAgentForHandoff,
} from "@/services/agentHandoff/launchForHandoff";
import type { PanelInstance } from "@shared/types/panel";
import type { WorktreeSnapshot } from "@shared/types";
import type { AgentState } from "@shared/types/agent";
import {
  ROW_REFUSAL_LABEL,
  buildSendToAgentRows,
  canSelectSendToAgentRow,
  filterSendToAgentRows,
  groupHeadingFor,
  type HandoffAgentChoice,
  type SendToAgentRow,
} from "./sendToAgentRows";

const EMPTY_ROWS: SendToAgentRow[] = [];
const EMPTY_PANEL_IDS: string[] = [];
const EMPTY_PANELS_BY_ID: Record<string, PanelInstance> = {};
const EMPTY_WORKTREES = new Map<string, WorktreeSnapshot>();

type PickerMode = "pick" | "branch";

/**
 * What the last agent output looked like, in the Fleet picker's badge. An
 * observation off the terminal, not a guarantee — the picker still drafts into
 * a working agent, and the draft waits for the user either way.
 */
function ObservedStateBadge({ state }: { state: AgentState | undefined }) {
  if (state !== "waiting" && state !== "working") return null;
  const waiting = state === "waiting";
  return (
    <Badge
      size="xs"
      tone="outline"
      className={cn("shrink-0", waiting ? "text-state-waiting" : "text-text-secondary")}
      data-state={state}
    >
      {waiting ? "Waiting" : "Working"}
    </Badge>
  );
}

/**
 * The picker behind `host.sendToAgent` with no `terminalId` — Send to agent's
 * presentation, with its own eligibility: it lists this project's agents by
 * worktree, drafts rather than types, and can start an agent to hand the work
 * to. Mounted once in `ModalHostLayer`; renders the front prompt of
 * `pluginPromptStore` when it is a picker.
 *
 * Every choice is re-checked when it is made, not when the list was drawn: an
 * agent can lock or exit while the picker sits open, and the draft path refuses
 * it then with the reason rather than writing into a draft nobody can see.
 */
export function PluginSendToAgentDialog() {
  const current = usePluginPromptStore((state) => state.current);
  const resolveCurrent = usePluginPromptStore((state) => state.resolveCurrent);

  const picker =
    current &&
    current.params.kind === "sendToAgent" &&
    current.params.request.terminalId === undefined
      ? {
          promptId: current.promptId,
          pluginId: current.pluginId,
          request: current.params.request,
        }
      : null;
  const isOpen = picker !== null;
  const promptId = picker?.promptId ?? null;
  const request = picker?.request ?? null;
  const attribution = usePluginAttribution(picker?.pluginId ?? "");

  // Live only while open, like Send to agent: the dialog is always mounted, and
  // an unconditional selector would re-render it on every agent-state flip.
  const panelIds = usePanelStore((state) => (isOpen ? state.panelIds : EMPTY_PANEL_IDS));
  const panelsById = usePanelStore((state) => (isOpen ? state.panelsById : EMPTY_PANELS_BY_ID));
  const focusedId = usePanelStore((state) => (isOpen ? state.focusedId : null));
  const showAgentTaskTitles = usePreferencesStore((state) => state.showAgentTaskTitles);
  const worktrees = useWorktreeStoreOptional(
    (state) => (isOpen ? state.worktrees : EMPTY_WORKTREES),
    EMPTY_WORKTREES
  );
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const defaultAgent = useAgentPreferencesStore((state) => state.defaultAgent);
  const availability = useCliAvailabilityStore((state) => state.availability);
  const availabilityReady = useCliAvailabilityStore((state) => state.isInitialized);

  const agent = useMemo<HandoffAgentChoice | null>(() => {
    if (!availabilityReady) return null;
    const agentId = getDefaultAgentId(defaultAgent, undefined, availability);
    if (agentId === null) return null;
    return { agentId, agentName: getAgentConfig(agentId)?.name ?? agentId };
  }, [availabilityReady, defaultAgent, availability]);

  const [mode, setMode] = useState<PickerMode>("pick");

  const pickRows = useMemo<SendToAgentRow[]>(() => {
    if (!isOpen || request === null) return EMPTY_ROWS;
    const worktreeNames = new Map<string, string>();
    for (const [id, snapshot] of worktrees) worktreeNames.set(id, snapshot.name);
    // The panel map drives recomputation; the rest of the gate (the setting,
    // the backend, the fleet) is read at the same moment, and every choice is
    // re-checked when it is made anyway.
    const panes = buildAgentPanes({
      ...readDraftTargetInputs(),
      panelsById,
      panelIds,
      focusedId,
      worktrees,
      showAgentTaskTitles,
    });
    return buildSendToAgentRows({
      panes,
      requestedWorktreeId: request.worktreeId,
      activeWorktreeId,
      worktreeNames,
      agent,
    });
  }, [
    isOpen,
    request,
    panelIds,
    panelsById,
    focusedId,
    worktrees,
    showAgentTaskTitles,
    activeWorktreeId,
    agent,
  ]);

  const rows = useMemo<SendToAgentRow[]>(() => {
    if (mode === "branch" && agent !== null) {
      return [{ kind: "create-branch", id: "create-branch", agent }];
    }
    return pickRows;
  }, [mode, agent, pickRows]);

  const filterFn = useCallback(
    (items: SendToAgentRow[], query: string) =>
      mode === "branch" ? items : filterSendToAgentRows(items, query),
    [mode]
  );

  const { query, results, selectedIndex, setQuery, selectPrevious, selectNext, setSelectedIndex } =
    useSearchablePalette<SendToAgentRow>({
      items: rows,
      filterFn,
      canNavigate: canSelectSendToAgentRow,
      getItemId: (row) => row.id,
      // Enter can follow the last keystroke in the same tick — the branch name
      // especially — and must act on what was typed, not the frame before.
      deferFiltering: false,
    });

  useEffect(() => {
    setMode("pick");
    setQuery("");
  }, [promptId, setQuery]);

  const spansWorktrees = useMemo(() => {
    const ids = new Set<string>();
    for (const row of results) if (row.kind === "agent") ids.add(row.pane.worktree?.id ?? "");
    return ids.size > 1;
  }, [results]);

  // resolveCurrent advances synchronously; gate so each prompt answers once.
  const handledPromptIdRef = useRef<string | null>(null);
  const answer = useCallback(
    (value: Parameters<typeof resolveCurrent>[0]) => {
      if (!promptId || handledPromptIdRef.current === promptId) return;
      handledPromptIdRef.current = promptId;
      resolveCurrent(value);
    },
    [promptId, resolveCurrent]
  );

  const choose = useCallback(
    (row: SendToAgentRow) => {
      if (request === null || !canSelectSendToAgentRow(row)) return;
      switch (row.kind) {
        case "agent":
          answer(draftAgentContext(row.pane.terminalId, request));
          return;
        case "new-here":
          // Closes now and answers once the agent is up and drafted.
          answer(
            launchAgentForHandoff(
              row.agent.agentId,
              { kind: "existing-worktree", worktreeId: row.worktreeId },
              request
            )
          );
          return;
        case "new-worktree":
          setMode("branch");
          setQuery(branchNameForHandoff(request.title));
          return;
        case "create-branch": {
          const branchName = query.trim();
          if (!branchName) return;
          answer(
            launchAgentForHandoff(row.agent.agentId, { kind: "new-worktree", branchName }, request)
          );
          return;
        }
      }
    },
    [request, answer, setQuery, query]
  );

  const handleConfirm = useCallback(() => {
    const row = results[selectedIndex];
    if (row) choose(row);
  }, [results, selectedIndex, choose]);

  const handleClose = useCallback(() => {
    answer({ status: "cancelled" });
  }, [answer]);

  // Escape in the branch step steps back to the list rather than dismissing the
  // whole handoff — the user asked for a different row, not to give up.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (mode === "branch" && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMode("pick");
        setQuery("");
      }
    },
    [mode, setQuery]
  );

  const renderItem = useCallback(
    (
      row: SendToAgentRow,
      index: number,
      isSelected: boolean,
      onHoverIndex: (index: number) => void
    ) => {
      const heading = groupHeadingFor(results, index, spansWorktrees);
      const firstCreationRow =
        row.kind !== "agent" &&
        row.kind !== "create-branch" &&
        index > 0 &&
        results[index - 1]?.kind === "agent";
      const enabled = canSelectSendToAgentRow(row);

      let icon: React.ReactNode;
      let label: string;
      let detail: string | undefined;
      let badge: React.ReactNode = null;
      switch (row.kind) {
        case "agent": {
          const panel = panelsById[row.pane.terminalId];
          icon = panel ? (
            <TerminalIcon kind={panel.kind} chrome={deriveTerminalChrome(panel)} />
          ) : null;
          label = row.pane.title;
          detail = row.pane.canDraft
            ? (getAgentConfig(row.pane.agentId)?.name ?? row.pane.agentId)
            : ROW_REFUSAL_LABEL[row.pane.draftRefusal ?? "not-agent"];
          badge = row.pane.canDraft ? <ObservedStateBadge state={row.pane.observedState} /> : null;
          break;
        }
        case "new-here":
          icon = <Plus className="size-4" aria-hidden="true" />;
          label = "New agent here";
          detail = [row.agent.agentName, row.worktreeName].filter(Boolean).join(" · ");
          break;
        case "new-worktree":
          icon = <GitBranchPlus className="size-4" aria-hidden="true" />;
          label = "New agent in new worktree";
          detail = `${row.agent.agentName} · on a new branch`;
          break;
        case "create-branch":
          icon = <GitBranchPlus className="size-4" aria-hidden="true" />;
          label = query.trim() ? `Create ${query.trim()}` : "Type a branch name";
          detail = `New worktree, then start ${row.agent.agentName}`;
          break;
      }

      return (
        <div key={row.id}>
          {heading !== null && (
            <div
              aria-hidden="true"
              className="px-3 pb-1 pt-2 text-xs font-medium text-text-secondary"
            >
              {heading}
            </div>
          )}
          {firstCreationRow && (
            <div aria-hidden="true" className="mx-3 my-1 border-t border-border-subtle" />
          )}
          <button
            id={`plugin-send-to-agent-${row.id}`}
            type="button"
            tabIndex={-1}
            role="option"
            aria-selected={isSelected}
            aria-disabled={!enabled}
            aria-label={[heading ?? undefined, label, detail].filter(Boolean).join(", ")}
            onPointerDown={(e) => e.preventDefault()}
            onPointerMove={() => onHoverIndex(index)}
            onClick={() => {
              if (!enabled) return;
              setSelectedIndex(index);
              choose(row);
            }}
            className={cn(
              "group relative flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-left",
              enabled
                ? [
                    PALETTE_ROW_CLASS,
                    "text-text-secondary hover:bg-overlay-subtle hover:text-text-primary",
                  ]
                : "cursor-not-allowed border border-transparent opacity-50"
            )}
          >
            <span className="shrink-0 text-text-secondary" aria-hidden="true">
              {icon}
            </span>
            <div className="min-w-0 flex-1 overflow-hidden">
              <span className="block truncate text-sm font-medium text-text-primary">{label}</span>
              {detail && (
                <span className="block truncate text-xs text-text-secondary">{detail}</span>
              )}
            </div>
            {badge}
          </button>
        </div>
      );
    },
    [results, spansWorktrees, panelsById, query, choose, setSelectedIndex]
  );

  const title = request?.title;
  const label =
    mode === "branch" ? "Name the new branch" : title ? `Send "${title}" to` : "Send to agent";

  return (
    <ErrorBoundary
      variant="component"
      componentName="PluginSendToAgentDialog"
      resetKeys={[promptId ?? "null"]}
    >
      <SearchablePalette<SendToAgentRow>
        tier="command"
        isOpen={isOpen}
        query={query}
        results={results}
        selectedIndex={selectedIndex}
        onQueryChange={setQuery}
        onSelectPrevious={selectPrevious}
        onSelectNext={selectNext}
        onConfirm={handleConfirm}
        onClose={handleClose}
        onHoverIndex={setSelectedIndex}
        onKeyDown={handleKeyDown}
        getItemId={(row) => row.id}
        renderItem={renderItem}
        label={label}
        ariaLabel={`${label}. ${attribution.text}`}
        searchPlaceholder={mode === "branch" ? "Branch name" : "Search agents and worktrees"}
        searchAriaLabel={mode === "branch" ? "Branch name" : "Search agents and worktrees"}
        itemIdPrefix="plugin-send-to-agent"
        emptyMessage="No agents in this project"
        footer={<PluginProvenance attribution={attribution} className="flex-1" />}
      />
    </ErrorBoundary>
  );
}
