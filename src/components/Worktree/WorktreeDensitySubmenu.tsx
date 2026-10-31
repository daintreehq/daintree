import {
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { Rows3 } from "@/components/icons";
import { CARD_DENSITY_OPTIONS } from "@/components/Worktree/cardDensityOptions";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";

/**
 * View ▸ Comfortable / Compact, on the sidebar's background menu and on every
 * card's menu: with a full list the cards cover the whole sidebar, so a
 * right-click almost always lands on one. The same choice as Settings →
 * Worktree, read from the same store, so the radio and the segment agree.
 */
export function WorktreeDensitySubmenu({ iconClassName }: { iconClassName: string }) {
  const density = useWorktreeFilterStore((s) => s.cardDensity);
  const setDensity = useWorktreeFilterStore((s) => s.setCardDensity);
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Rows3 className={iconClassName} aria-hidden="true" />
        View
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <ContextMenuRadioGroup
          value={density}
          onValueChange={(value) => {
            const picked = CARD_DENSITY_OPTIONS.find((option) => option.value === value);
            if (picked) setDensity(picked.value);
          }}
        >
          {CARD_DENSITY_OPTIONS.map((option) => (
            <ContextMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </ContextMenuRadioItem>
          ))}
        </ContextMenuRadioGroup>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
