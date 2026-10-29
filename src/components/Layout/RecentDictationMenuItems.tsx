import type { RecentDictation } from "@shared/types";
import { TriangleAlert } from "@/components/icons";
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuMeta,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import {
  useRecentDictationsStore,
  recentDictationText,
  type RecentDictationVersion,
} from "@/store/recentDictationsStore";
import { usePaletteStore } from "@/store/paletteStore";
import { useRecentDictationDestination } from "@/hooks/useRecentDictationDestination";
import {
  copyRecentDictation,
  insertRecentDictation,
  type RecentDictationDestination,
} from "@/services/recentDictationRecovery";

/** The menu lists the newest few; the palette has the rest. */
const MENU_LIMIT = 5;

/** The row's spoken name stops here: the excerpt is cut by width on screen, never by length. */
const SPOKEN_EXCERPT_CHARS = 120;

function excerpt(dictation: RecentDictation): string {
  return recentDictationText(dictation).replace(/\s+/g, " ").trim();
}

function openInPalette(id: string): void {
  useRecentDictationsStore.getState().reveal(id);
  usePaletteStore.getState().openPalette("recent-dictations");
}

interface VersionItemsProps {
  dictation: RecentDictation;
  version: RecentDictationVersion;
  label: string;
  canAdd: boolean;
  onInsert: (dictation: RecentDictation, version: RecentDictationVersion) => void;
}

/**
 * One version's label, add and copy: the palette preview's sections, as menu
 * rows. The original's items say so, so the two adds don't share a name.
 */
function VersionItems({ dictation, version, label, canAdd, onInsert }: VersionItemsProps) {
  const original = version === "original";
  return (
    <>
      <ContextMenuLabel>{label}</ContextMenuLabel>
      <ContextMenuItem disabled={!canAdd} onSelect={() => onInsert(dictation, version)}>
        {original ? "Add original to draft" : "Add to draft"}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => copyRecentDictation(dictation, version)}>
        {original ? "Copy original" : "Copy"}
      </ContextMenuItem>
    </>
  );
}

/** Where the adds below go, or why they can't: said once, in full, at the top of the submenu. */
function DestinationNote({ destination }: { destination: RecentDictationDestination }) {
  return (
    <div className="flex max-w-64 items-start gap-1.5 px-2.5 py-1.5 text-xs text-text-secondary">
      {destination.ok ? (
        // The destination on its own line, so a wrap never strands its worktree.
        <span className="flex min-w-0 flex-col">
          <span>Adds to the draft in</span>
          <span className="break-words text-text-primary">{destination.label}</span>
        </span>
      ) : (
        <>
          <TriangleAlert
            className="mt-px size-3.5 shrink-0 text-status-warning"
            aria-hidden="true"
          />
          <span className="break-words">Can&apos;t add to a draft: {destination.reason}</span>
        </>
      )}
    </div>
  );
}

interface RecentDictationMenuItemsProps {
  /**
   * Called with the panel an item added text to, so the menu's owner can hand
   * that composer the keyboard once the menu has closed.
   */
  onInserted: (panelId: string) => void;
}

/**
 * The voice toolbar menu's recovery section (#14637, #15127): the newest
 * dictations, each a submenu with the palette preview's vocabulary — the
 * cleaned-up text and the original, as heard, each with add and copy, the
 * add naming its draft or the reason there isn't one — plus the way into the
 * full list. Renders nothing until there is a dictation to recover.
 */
export function RecentDictationMenuItems({ onInserted }: RecentDictationMenuItemsProps) {
  const dictations = useRecentDictationsStore((s) => s.dictations);
  const destination = useRecentDictationDestination(dictations.length > 0);
  if (dictations.length === 0) return null;

  const insert = (dictation: RecentDictation, version: RecentDictationVersion) => {
    const panelId = insertRecentDictation(dictation, version);
    if (panelId) onInserted(panelId);
  };

  return (
    <>
      <ContextMenuLabel>Recent dictations</ContextMenuLabel>
      {dictations.slice(0, MENU_LIMIT).map((dictation) => {
        const text = excerpt(dictation);
        const cleaned = dictation.correctedText !== null;
        const spoken = [
          text.length > SPOKEN_EXCERPT_CHARS ? `${text.slice(0, SPOKEN_EXCERPT_CHARS)}…` : text,
          formatRelativeTime(dictation.endedAt),
          cleaned ? "cleaned and original" : null,
        ]
          .filter(Boolean)
          .join(", ");
        return (
          <ContextMenuSub key={dictation.id}>
            <ContextMenuSubTrigger aria-label={spoken}>
              {/* One growing box ahead of the chevron, so every age lands in
                  the same column whatever the excerpt's length. */}
              <span className="flex flex-1 min-w-0 items-baseline">
                <span className="max-w-64 min-w-0 flex-1 truncate">{text}</span>
                <ContextMenuMeta>
                  <TimeAgo timestamp={dictation.endedAt} />
                </ContextMenuMeta>
              </span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <DestinationNote destination={destination} />
              <ContextMenuSeparator />
              <VersionItems
                dictation={dictation}
                version="cleaned"
                label={cleaned ? "Cleaned up" : "As heard"}
                canAdd={destination.ok}
                onInsert={insert}
              />
              {cleaned && (
                <>
                  <ContextMenuSeparator />
                  <VersionItems
                    dictation={dictation}
                    version="original"
                    label="Original, as heard"
                    canAdd={destination.ok}
                    onInsert={insert}
                  />
                </>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => openInPalette(dictation.id)}>
                View full dictation…
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        );
      })}
      <ContextMenuItem onSelect={() => usePaletteStore.getState().openPalette("recent-dictations")}>
        Search recent dictations…
      </ContextMenuItem>
      <ContextMenuSeparator />
    </>
  );
}
