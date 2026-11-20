import { useEffect, useId, useRef, useState } from "react";
import type { WorktreeSnapshot } from "@shared/types";
import { GitBranch } from "@/components/icons";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { Textarea } from "@/components/ui/textarea";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";
import { useShallow } from "zustand/react/shallow";
import { getAgentConfig } from "@/config/agents";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { DEFAULT_CONTINUE_NOTE, sendWakeContinueNotes } from "@/services/wakeContinue/wakeContinue";
import { useProjectStore } from "@/store/projectStore";
import {
  useWakeContinueStore,
  type WakeContinueEntry,
  type WakeContinueOffer,
} from "@/store/wakeContinueStore";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { logWarn } from "@/utils/logger";
import {
  useLiveWakeOutcomes,
  wakeDeliverySummary,
  wakeEntryStatus,
  wakeOfferCounts,
  type WakeRowOutcome,
  type WakeRowTone,
} from "./wakeContinueStatus";

const TONE_CLASS: Record<WakeRowTone, string> = {
  muted: "text-text-secondary",
  ok: "text-text-primary",
  warn: "text-status-warning-text",
};

const DESCRIPTION: Record<WakeContinueOffer["phase"], string> = {
  offered: "Included agents get the note as each reaches its prompt, a few at a time.",
  sending: "Notes go in a few at a time, as each agent reaches its prompt.",
  done: "Each row shows where its note got to.",
};

const NO_WORKTREES = new Map<string, WorktreeSnapshot>();

/**
 * Review and send the continue note (#17883): the note, editable until it is
 * sent, and every agent the restore started again with what each gets.
 * Mounted once at the layout rather than with the grid strip, so the grid's
 * keys never reach the note and a layout change never resets it.
 */
export function WakeContinueDialog() {
  const offer = useWakeContinueStore((s) => s.offer);
  const isOpen = useWakeContinueStore((s) => s.dialogOpen);
  const setDialogOpen = useWakeContinueStore((s) => s.setDialogOpen);
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const outcomes = useLiveWakeOutcomes(offer);
  if (!offer || offer.projectId !== projectId) return null;
  return (
    <WakeContinueDialogBody
      // A newer wake starts from the default note again.
      key={offer.id}
      offer={offer}
      outcomes={outcomes}
      isOpen={isOpen}
      onClose={() => setDialogOpen(false)}
    />
  );
}

interface Row {
  entry: WakeContinueEntry;
  label: string;
  tone: WakeRowTone;
  title: string;
  /** Gets, or got, the note: listed first in its worktree and drawn at full weight. */
  included: boolean;
  /**
   * Worth a way to the panel: one that shares its title with another in its
   * worktree, or one whose note needs the user at the panel itself or failed.
   */
  findable: boolean;
  /** "1 of 2" among same-titled rows in its worktree, so each Show has its own name. */
  twinLabel?: string;
  /** For a twin in the dock: the one place the grid itself shows it apart. */
  docked?: boolean;
}

interface Group {
  key: string;
  title: string;
  rows: Row[];
}

/**
 * Rows grouped by worktree in the order each first appears, the ones the note
 * goes to first within each, so two panes with the same title are told apart by
 * where they run, as the destructive confirms list them.
 */
function groupRows(
  offer: WakeContinueOffer,
  outcomes: readonly WakeRowOutcome[],
  liveTitles: readonly (string | undefined)[],
  docked: readonly boolean[],
  worktreeTitle: (worktreeId: string | null) => string,
  includedLabel: string
): Group[] {
  const groups = new Map<string, Group>();
  offer.entries.forEach((entry, index) => {
    const outcome = outcomes[index] ?? "closed";
    const status = wakeEntryStatus(entry, outcome, offer.phase, includedLabel);
    const included = offer.phase === "offered" ? outcome === "resumed" : !!entry.delivery;
    // The grid's current title while the panel lives; a closed one keeps the restore's.
    const title = (liveTitles[index] ?? entry.title).trim() || "Untitled panel";
    const deliveryStatus = entry.delivery?.status;
    const needsALook =
      deliveryStatus === "needs-you" ||
      deliveryStatus === "unconfirmed" ||
      deliveryStatus === "failed";
    const key = entry.worktreeId ?? "";
    let group = groups.get(key);
    if (!group) {
      group = { key, title: worktreeTitle(entry.worktreeId), rows: [] };
      groups.set(key, group);
    }
    group.rows.push({
      entry,
      ...status,
      title,
      included,
      findable: liveTitles[index] !== undefined && needsALook,
    });
  });
  for (const group of groups.values()) {
    group.rows.sort((a, b) => Number(b.included) - Number(a.included));
    for (const row of group.rows) {
      const twins = group.rows.filter((other) => other.title === row.title);
      if (twins.length < 2) continue;
      row.twinLabel = `${twins.indexOf(row) + 1} of ${twins.length}`;
      row.docked = docked[offer.entries.indexOf(row.entry)];
      if (liveTitles[offer.entries.indexOf(row.entry)] !== undefined) row.findable = true;
    }
  }
  return [...groups.values()];
}

function WakeContinueDialogBody({
  offer,
  outcomes,
  isOpen,
  onClose,
}: {
  offer: WakeContinueOffer;
  outcomes: readonly WakeRowOutcome[];
  isOpen: boolean;
  onClose: () => void;
}) {
  const [note, setNote] = useState(DEFAULT_CONTINUE_NOTE);
  // The panel a Show is taking the user to: the close leaves focus for it, not the banner.
  const [showing, setShowing] = useState<string | null>(null);
  const noteId = useId();
  const noteLabelId = useId();
  const agentsLabelId = useId();
  const worktrees = useWorktreeStoreOptional((s) => s.worktrees, NO_WORKTREES);
  const liveTitles = usePanelStore(
    useShallow((state) =>
      offer.entries.map((entry) => {
        const panel = state.panelsById[entry.terminalId];
        return panel && panel.location !== "trash" ? panel.title : undefined;
      })
    )
  );
  const docked = usePanelStore(
    useShallow((state) =>
      offer.entries.map((entry) => state.panelsById[entry.terminalId]?.location === "dock")
    )
  );
  const listRef = useRef<HTMLDivElement>(null);
  // The Show last focused and where it sat: a live update can take it away under the user.
  const focusedShowRef = useRef<{ terminalId: string; index: number } | null>(null);
  const counts = wakeOfferCounts(offer, outcomes);
  const editable = offer.phase === "offered";
  const blank = note.trim() === "";
  const skipped = offer.entries.length - counts.resumed;

  const worktreeTitle = (worktreeId: string | null) => {
    const worktree = worktreeId ? worktrees.get(worktreeId) : undefined;
    return worktree ? (worktree.branch ?? worktree.name) : "Other panels";
  };
  // Only a mixed list needs the included rows to say so; the summary carries an all-in one.
  const includedLabel = skipped > 0 && counts.resumed > 0 ? "Included" : "";
  const groups = groupRows(offer, outcomes, liveTitles, docked, worktreeTitle, includedLabel);

  const showPanel = (panelId: string) => {
    setShowing(panelId);
    onClose();
  };

  const handleCloseComplete = (restoreSkippedFocus?: () => void) => {
    const panelId = showing;
    setShowing(null);
    if (!panelId) return;
    void actionService
      .dispatch("panel.focus", { panelId }, { source: "user" })
      .then((result) => {
        if (!result.ok) restoreSkippedFocus?.();
      })
      .catch((error: unknown) => {
        logWarn("[WakeContinue] Showing a panel failed", { error });
        restoreSkippedFocus?.();
      });
  };

  const send = () => {
    onClose();
    void sendWakeContinueNotes(note).catch((error: unknown) =>
      logWarn("[WakeContinue] Sending continue notes failed", { error })
    );
  };

  // Shown only for a mixed list: the footer says it when nobody qualifies, and the
  // button when everyone does. The status line still speaks at both extremes.
  const mixed = skipped > 0 && counts.resumed > 0;
  const summary = editable
    ? mixed
      ? `${counts.resumed} included · ${skipped} skipped`
      : ""
    : wakeDeliverySummary(offer.phase, counts);
  const spokenSummary =
    editable && !mixed
      ? counts.resumed === 0
        ? "No agents included"
        : counts.resumed === 1
          ? "1 agent included"
          : `All ${counts.resumed} agents included`
      : "";

  // A Show that vanished while focused leaves focus on the body; hand it to the
  // next Show, or to the footer's Close/Cancel when none is left.
  useEffect(() => {
    const focused = focusedShowRef.current;
    const list = listRef.current;
    if (!isOpen || !focused || !list) return;
    const shows = list.querySelectorAll<HTMLElement>('[data-testid="wake-continue-show"]');
    const still = Array.prototype.findIndex.call(
      shows,
      (el: HTMLElement) => el.dataset.panelId === focused.terminalId
    );
    if (still !== -1) {
      // Still there: keep its position current, so a later removal lands next to it.
      focused.index = still;
      return;
    }
    if (document.activeElement !== document.body) return;
    const index = focused.index;
    const target =
      shows.length > 0
        ? shows[Math.min(index, shows.length - 1)]
        : list
            .closest('[role="dialog"]')
            ?.querySelector<HTMLElement>('[data-confirm-role="cancel"]');
    focusedShowRef.current = null;
    target?.focus();
  });

  const hint = !editable
    ? undefined
    : blank
      ? "Write a note to send"
      : counts.resumed === 0
        ? outcomes.every((outcome) => outcome === "held")
          ? "No agent has resumed its session yet"
          : "No agent can take the note right now"
        : undefined;

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      // The report opens on Close rather than on the first row's Show.
      initialFocus={editable ? "first" : "cancel"}
      restoreFocusOnClose={showing === null}
      onCloseComplete={handleCloseComplete}
      data-testid="wake-continue-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>Continue resumed agents</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body className="space-y-4">
        <AppDialog.Description>{DESCRIPTION[offer.phase]}</AppDialog.Description>
        <div className="space-y-1.5">
          {editable ? (
            <>
              <label htmlFor={noteId} className={SECTION_LABEL_CLASS}>
                Note
              </label>
              <Textarea
                id={noteId}
                className="h-24"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                data-testid="wake-continue-note"
              />
            </>
          ) : (
            <>
              <div id={noteLabelId} className={SECTION_LABEL_CLASS}>
                Note
              </div>
              {/* What went out, as a record rather than a dimmed field that reads as a placeholder. */}
              <p
                aria-labelledby={noteLabelId}
                className="whitespace-pre-wrap rounded-[var(--radius-md)] border border-divider bg-surface-canvas/40 px-3 py-2 text-sm text-text-primary [overflow-wrap:anywhere] select-text"
                data-testid="wake-continue-note"
              >
                {note.trim()}
              </p>
            </>
          )}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <div id={agentsLabelId} className={SECTION_LABEL_CLASS}>
              Agents
            </div>
            {/* Always mounted, so the phase and every exception are announced as they change. */}
            <p
              className="min-w-0 text-right text-xs text-text-secondary"
              role="status"
              aria-live="polite"
              data-testid="wake-continue-summary"
            >
              {summary}
              {spokenSummary && <span className="sr-only">{spokenSummary}</span>}
            </p>
          </div>
          <div
            ref={listRef}
            aria-labelledby={agentsLabelId}
            role="group"
            className="divide-y divide-divider rounded-[var(--radius-md)] border border-divider bg-surface-canvas/40"
            data-testid="wake-continue-entries"
          >
            {groups.map((group) => (
              <div key={group.key} className="px-3 py-2">
                <div className="mb-1.5 flex min-w-0 items-start gap-1.5 text-xs text-text-secondary">
                  <GitBranch className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 font-mono [overflow-wrap:anywhere]">{group.title}</span>
                </div>
                <ul className="space-y-1" aria-label={group.title}>
                  {group.rows.map(
                    ({ entry, label, tone, title, included, findable, twinLabel, docked }) => {
                      const agentName = getAgentConfig(entry.agentId)?.name;
                      return (
                        <li
                          key={entry.terminalId}
                          data-terminal-id={entry.terminalId}
                          className="flex min-w-0 items-start gap-2 text-sm"
                        >
                          <TerminalIcon
                            chrome={deriveTerminalChrome({ launchAgentId: entry.agentId })}
                            className="mt-0.5 h-3.5 w-3.5 shrink-0"
                          />
                          <span
                            className={cn(
                              "min-w-0 flex-1 [overflow-wrap:anywhere]",
                              included ? "text-text-primary" : "text-text-secondary"
                            )}
                          >
                            {title}
                            {/* A panel title can name another agent, or none: say whose session it is. */}
                            {agentName && !title.includes(agentName) && (
                              <span className="text-text-secondary">
                                {" "}
                                <FactSeparator /> {agentName}
                              </span>
                            )}
                            {docked && (
                              <span className="text-text-secondary">
                                {" "}
                                <FactSeparator /> in dock
                              </span>
                            )}
                          </span>
                          {label && (
                            <span
                              className={cn(
                                "max-w-[55%] shrink-0 pt-0.5 text-right text-xs",
                                TONE_CLASS[tone]
                              )}
                            >
                              {label}
                            </span>
                          )}
                          {findable && (
                            <Button
                              variant="ghost"
                              size="xs"
                              className="-my-0.5 shrink-0"
                              onClick={() => showPanel(entry.terminalId)}
                              data-panel-id={entry.terminalId}
                              onFocus={(event) => {
                                const shows = listRef.current?.querySelectorAll(
                                  '[data-testid="wake-continue-show"]'
                                );
                                focusedShowRef.current = {
                                  terminalId: entry.terminalId,
                                  index: shows
                                    ? Array.prototype.indexOf.call(shows, event.currentTarget)
                                    : 0,
                                };
                              }}
                              onBlur={(event) => {
                                // Focus moved on to something real; a removal leaves it on the body.
                                if (event.relatedTarget) focusedShowRef.current = null;
                              }}
                              aria-label={
                                twinLabel
                                  ? `Show ${title}${docked ? " in dock" : ""}, ${twinLabel}`
                                  : `Show ${title}`
                              }
                              data-testid="wake-continue-show"
                            >
                              Show
                            </Button>
                          )}
                        </li>
                      );
                    }
                  )}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </AppDialog.Body>
      <AppDialog.Footer
        hint={hint}
        secondaryAction={{ label: editable ? "Cancel" : "Close", onClick: onClose }}
        primaryAction={
          editable
            ? {
                label: `Send to ${pluralize(counts.resumed, "agent")}`,
                onClick: send,
                disabled: blank || counts.resumed === 0,
              }
            : undefined
        }
      />
    </AppDialog>
  );
}
