import type { RecentDictation } from "@shared/types";
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
import { useRecentDictationsStore, recentDictationText } from "@/store/recentDictationsStore";
import { usePaletteStore } from "@/store/paletteStore";
import { copyRecentDictation, insertRecentDictation } from "@/services/recentDictationRecovery";

/** The menu lists the newest few; the palette has the rest. */
const MENU_LIMIT = 5;

function excerpt(dictation: RecentDictation): string {
  return recentDictationText(dictation).replace(/\s+/g, " ").trim();
}

interface RecentDictationMenuItemsProps {
  /**
   * Called with the panel an item added text to, so the menu's owner can hand
   * that composer the keyboard once the menu has closed.
   */
  onInserted: (panelId: string) => void;
}

/**
 * The voice toolbar menu's recovery section (#14637): the newest dictations,
 * each with add-to-draft and copy, plus the way into the full list. Renders
 * nothing until there is a dictation to recover.
 */
export function RecentDictationMenuItems({ onInserted }: RecentDictationMenuItemsProps) {
  const dictations = useRecentDictationsStore((s) => s.dictations);
  if (dictations.length === 0) return null;

  const insert = (dictation: RecentDictation, original: boolean) => {
    const panelId = insertRecentDictation(dictation, original ? "original" : "cleaned");
    if (panelId) onInserted(panelId);
  };

  return (
    <>
      <ContextMenuLabel>Recent dictations</ContextMenuLabel>
      {dictations.slice(0, MENU_LIMIT).map((dictation) => (
        <ContextMenuSub key={dictation.id}>
          <ContextMenuSubTrigger>
            <span className="max-w-64 min-w-0 truncate">{excerpt(dictation)}</span>
            <ContextMenuMeta>
              <TimeAgo timestamp={dictation.endedAt} />
            </ContextMenuMeta>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onSelect={() => insert(dictation, false)}>
              Add to draft
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => copyRecentDictation(dictation)}>Copy</ContextMenuItem>
            {/* Only where cleanup changed it, so there's a second version. */}
            {dictation.correctedText !== null && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => insert(dictation, true)}>
                  Add original to draft
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => copyRecentDictation(dictation, "original")}>
                  Copy original
                </ContextMenuItem>
              </>
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
      ))}
      <ContextMenuItem onSelect={() => usePaletteStore.getState().openPalette("recent-dictations")}>
        Search recent dictations…
      </ContextMenuItem>
      <ContextMenuSeparator />
    </>
  );
}
