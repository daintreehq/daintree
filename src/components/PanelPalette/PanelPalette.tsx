import { useEffect, useRef, useCallback } from "react";
import { isPointerClaimed } from "@/lib/pointerClaim";
import { cn } from "@/lib/utils";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { AppPaletteDialog, PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { PaletteOverflowNotice } from "@/components/ui/PaletteOverflowNotice";
import { HighlightedText, findMatchIndices } from "@/components/ui/HighlightedText";
import { MORE_AGENTS_PANEL_ID, type PanelKindOption } from "@/hooks/usePanelPalette";
import { PANEL_KIND_ORIGIN_LABELS } from "@/utils/panelKindOriginCopy";
import type { FuseResultMatch } from "@/hooks/useSearchablePalette";
import { PanelKindIcon } from "./PanelKindIcon";
import { TailKeepingText, sliceRanges } from "@/components/ui/TailKeepingText";
import { usePanelStore } from "@/store/panelStore";
import { usePanelLimitStore } from "@/store/panelLimitStore";
import { countPanelsTowardLimit } from "@/store/slices/panelRegistry/panelCount";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { KbdChord } from "@/components/ui/Kbd";
import { keyBelongsToField } from "@/hooks/useListboxCursor";
import { useRemoteHostName } from "@/hooks/useSettingsOwner";

interface PanelPaletteProps {
  isOpen: boolean;
  query: string;
  results: PanelKindOption[];
  totalResults?: number;
  selectedIndex: number;
  matchesById: Map<string, readonly FuseResultMatch[]>;
  onQueryChange: (q: string) => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onSelect: (kind: PanelKindOption) => void;
  /** Moves the cursor to the row under the pointer, so pointer and keys share one highlight. */
  onHoverIndex?: (index: number) => void;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * What Enter does on the highlighted row, said the way the launcher says it.
 * Names stay as written — "to create codex" read as a typo — and the verb
 * follows what the row actually does: a resume row picks a session back up, and
 * a row that isn't installed (or "More agents…") opens setup, not a panel.
 * Null where Enter does nothing, so the footer never promises an action.
 */
export function getPanelPaletteEnterLabel(kind: PanelKindOption | null): string | null {
  if (!kind) return null;
  if (kind.isStale) return null;
  if (kind.id === MORE_AGENTS_PANEL_ID) return "to set up agents";
  if (kind.installed === false) return `to set up ${kind.name}`;
  if (kind.category === "resume") return "to resume session";
  if (kind.category === "agent") return `to launch ${kind.name}`;
  return `to open ${kind.name}`;
}

const SECTION_LABELS: Record<"agent" | "tool" | "resume", string> = {
  agent: "AI Agents",
  resume: "Resume Sessions",
  tool: "Tools",
};

export function PanelPalette({
  isOpen,
  query,
  results,
  totalResults,
  selectedIndex,
  matchesById,
  onQueryChange,
  onSelectPrevious,
  onSelectNext,
  onSelect,
  onHoverIndex,
  onConfirm,
  onClose,
}: PanelPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  useEffect(() => {
    if (selectedIndex >= 0 && results[selectedIndex]) {
      const node = itemsRef.current.get(results[selectedIndex].id);
      // A row under the pointer was just claimed by it; revealing it would
      // scroll a half-visible row out from under the pointer.
      if (isPointerClaimed(node)) return;
      node?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, results]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // While an IME composes, its candidate keys belong to the composition.
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          onSelectPrevious();
          break;
        case "ArrowDown":
          e.preventDefault();
          onSelectNext();
          break;
        // First and last, as in every other palette. Shift+Home selects the
        // query instead, and an empty list leaves the keys to the caret.
        case "Home":
        case "End": {
          if (keyBelongsToField(e) || !onHoverIndex) break;
          // A stale row is never selectable; the ends are the live rows.
          const live = results.flatMap((item, index) => (item.isStale ? [] : [index]));
          const target = (e.key === "Home" ? live[0] : live[live.length - 1]) ?? -1;
          if (target < 0) break;
          e.preventDefault();
          onHoverIndex(target);
          break;
        }
        case "Enter":
          e.preventDefault();
          onConfirm();
          break;
        case "Escape":
          e.preventDefault();
          // A query clears before the palette closes, as in every SearchablePalette.
          // Stopped so the dialog's document-level Escape backstop cannot close it.
          if (query !== "") {
            e.stopPropagation();
            onQueryChange("");
          } else {
            onClose();
          }
          break;
        case "Tab":
          // Stopped as well as prevented, as in SearchablePalette: the dialog's
          // window-level focus wrap otherwise sees Shift+Tab on the field (its
          // first tabbable) and moves focus to the last control.
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) {
            onSelectPrevious();
          } else {
            onSelectNext();
          }
          break;
      }
    },
    [
      onSelectPrevious,
      onSelectNext,
      onConfirm,
      onClose,
      query,
      onQueryChange,
      onHoverIndex,
      results,
    ]
  );

  const panelCount = usePanelStore((state) =>
    countPanelsTowardLimit(state.panelsById, state.panelIds)
  );
  const hardLimit = usePanelLimitStore((state) => state.hardLimit);
  const panelPaletteShortcut = useEffectiveCombo("panel.palette");
  // Installed means installed where the panel would run: the host, in a remote window.
  const remoteHostName = useRemoteHostName();
  const showCounter = hardLimit > 0 && panelCount / hardLimit >= 0.75;

  const isSearching = query.trim().length > 0;
  const selectedKind =
    selectedIndex >= 0 && selectedIndex < results.length ? results[selectedIndex] : null;
  const enterLabel = getPanelPaletteEnterLabel(selectedKind ?? null);

  const renderOption = (kind: PanelKindOption, index: number) => {
    const isStale = kind.isStale === true;
    const isUnavailable = kind.installed === false || isStale;
    const badgeLabel = isStale
      ? "Worktree removed"
      : kind.installed === false
        ? remoteHostName === null
          ? "Not installed"
          : `Not installed on ${remoteHostName}`
        : null;
    // The palette already has a second line, so provenance goes there rather
    // than into the trailing badge, which is reserved for state ("Not
    // installed", "Worktree removed") — what a row IS never outranks whether it
    // can be launched. Origin leads the line so it is the half that survives
    // truncation; the shortcut stays in `description` alone, out of the Fuse
    // index, so typing "plugin" doesn't start matching rows on their tier.
    const secondaryText =
      [kind.origin ? PANEL_KIND_ORIGIN_LABELS[kind.origin] : undefined, kind.description]
        .filter(Boolean)
        .join(" · ") || null;
    const descriptionIndices = kind.origin
      ? undefined
      : findMatchIndices(matchesById.get(kind.id), "description");
    // The description leads with the session's worktree or branch
    // (`resumeSessionItems`), so that prefix can be laid out on its own.
    const location = kind.worktreeName ?? kind.branchName;
    const resumeLocation =
      kind.category === "resume" &&
      location &&
      secondaryText?.startsWith(location) &&
      secondaryText.length > location.length
        ? location
        : null;
    return (
      <button
        key={kind.id}
        id={`panel-option-${kind.id}`}
        tabIndex={-1}
        onPointerDown={(e) => e.preventDefault()}
        onPointerMove={
          onHoverIndex && index !== selectedIndex ? () => onHoverIndex(index) : undefined
        }
        role="option"
        aria-selected={index === selectedIndex}
        ref={(el) => {
          if (el) itemsRef.current.set(kind.id, el);
          else itemsRef.current.delete(kind.id);
        }}
        className={cn(
          PALETTE_ROW_CLASS,
          "w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left",
          "text-text-secondary"
        )}
        onClick={() => onSelect(kind)}
      >
        <div className="shrink-0">
          <PanelKindIcon iconId={kind.iconId} color={kind.color} size={16} />
        </div>
        <div className="flex-1 min-w-0">
          {/* Unavailable steps the name down the ramp rather than fading the
              row, which took the "Not installed" badge — the reason — with it. */}
          <div
            className={cn(
              "text-sm font-medium truncate",
              isUnavailable ? "text-text-secondary" : "text-text-primary"
            )}
          >
            <HighlightedText
              text={kind.name}
              indices={findMatchIndices(matchesById.get(kind.id), "name")}
            />
          </div>
          {kind.shortcut ? (
            // The launch chord as keycaps, the way the header and footers
            // draw every other shortcut, not as a line of glyph text.
            <KbdChord shortcut={kind.shortcut} density="compact" className="mt-0.5" />
          ) : (
            secondaryText &&
            (resumeLocation ? (
              // A resume row's location is what tells two sessions with the
              // same title apart, and worktrees differ at the end of their
              // branch, so it keeps its tail and the model and age give way
              // first.
              <div className="flex min-w-0 text-xs text-text-secondary">
                <TailKeepingText
                  text={resumeLocation}
                  indices={sliceRanges(descriptionIndices, 0, resumeLocation.length)}
                  className="shrink"
                />
                <span className="min-w-0 shrink-[10] truncate whitespace-pre">
                  <HighlightedText
                    text={secondaryText.slice(resumeLocation.length)}
                    indices={sliceRanges(
                      descriptionIndices,
                      resumeLocation.length,
                      secondaryText.length
                    )}
                  />
                </span>
              </div>
            ) : (
              <div className="text-xs text-text-secondary truncate">
                {/* Matched words light up here too: a resume row is often
                    found by its worktree or model, which live on this line. */}
                <HighlightedText text={secondaryText} indices={descriptionIndices} />
              </div>
            ))
          )}
        </div>
        {badgeLabel && (
          <span className="shrink-0 text-3xs font-medium text-text-secondary">{badgeLabel}</span>
        )}
      </button>
    );
  };

  const renderSectionedList = () => {
    const agents = results.filter((r) => r.category === "agent");
    const resumeSessions = results.filter((r) => r.category === "resume");
    const tools = results.filter((r) => r.category === "tool");
    const elements: React.ReactNode[] = [];

    const renderSection = (key: "agent" | "resume" | "tool", items: typeof results) => {
      if (items.length === 0) return;
      elements.push(
        <div
          key={`header-${key}`}
          className={cn(PALETTE_SECTION_LABEL_CLASS, "px-3 pt-3 pb-1")}
          aria-hidden="true"
        >
          {SECTION_LABELS[key]}
        </div>
      );
      items.forEach((kind) => {
        const index = results.indexOf(kind);
        elements.push(renderOption(kind, index));
      });
    };

    renderSection("agent", agents);
    renderSection("tool", tools);
    renderSection("resume", resumeSessions);

    return elements;
  };

  const activeDescendant =
    results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length
      ? `panel-option-${results[selectedIndex]!.id}`
      : undefined;

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={onClose} ariaLabel="Panel palette" tier="anchored">
      <AppPaletteDialog.Header
        label={showCounter ? `New panel (${panelCount} / ${hardLimit})` : "New panel"}
        shortcut={panelPaletteShortcut}
      >
        <AppPaletteDialog.Input
          inputRef={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search agents, tools, and sessions"
          role="combobox"
          // The listbox only exists while there are rows to put in it.
          aria-expanded={isOpen && results.length > 0}
          aria-haspopup="listbox"
          aria-label="Select panel type"
          aria-controls={results.length > 0 ? "panel-list" : undefined}
          aria-activedescendant={activeDescendant}
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body
        ariaLabel="Panel types"
        activeDescendant={activeDescendant}
        onNavigationKeyDown={handleKeyDown}
        keepPointerFocusOnInput
      >
        {results.length === 0 ? (
          <AppPaletteDialog.Empty
            query={query}
            emptyMessage="No panel types available"
            noMatchMessage={`No panel types match "${query.length > 40 ? query.slice(0, 40) + "…" : query}"`}
          />
        ) : (
          <div id="panel-list" role="listbox" aria-label="Panel types">
            {isSearching
              ? results.map((kind, index) => renderOption(kind, index))
              : renderSectionedList()}
          </div>
        )}
        {totalResults != null && (
          <PaletteOverflowNotice shown={results.length} total={totalResults} />
        )}
      </AppPaletteDialog.Body>

      <AppPaletteDialog.Footer>
        {enterLabel && <PaletteFooterHints primaryHint={{ keys: ["↵"], label: enterLabel }} />}
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
