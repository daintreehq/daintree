import {
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Rows3 } from "@/components/icons";
import { CARD_DENSITY_OPTIONS } from "@/components/Worktree/cardDensityOptions";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";

// Outside a project's worktree store (a menu rendered before one mounts) there
// is nothing to fold.
const NO_WORKTREES: ReadonlyMap<string, unknown> = new Map();

const CONTEXT = {
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
  Separator: ContextMenuSeparator,
  Item: ContextMenuItem,
};

const DROPDOWN = {
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
  Separator: DropdownMenuSeparator,
  Item: DropdownMenuItem,
};

/**
 * The sidebar's view choices: Comfortable / Compact, the same choice as
 * Settings → Worktree and read from the same store, then the list-level fold
 * (every card to its one-line row, or back). Offered wherever the sidebar has a
 * menu: its background, every card's right-click and "More actions" menus, and
 * the header's view menu, since with a full list a card is almost always what
 * is under the pointer.
 */
export function WorktreeDensityItems({ kind }: { kind: "context" | "dropdown" }) {
  const C = kind === "context" ? CONTEXT : DROPDOWN;
  const density = useWorktreeFilterStore((s) => s.cardDensity);
  const setDensity = useWorktreeFilterStore((s) => s.setCardDensity);
  const collapsed = useWorktreeFilterStore((s) => s.collapsedWorktrees);
  const collapseWorktrees = useWorktreeFilterStore((s) => s.collapseWorktrees);
  const expandAllWorktrees = useWorktreeFilterStore((s) => s.expandAllWorktrees);
  const worktreeIds = useWorktreeStoreOptional(
    (s): ReadonlyMap<string, unknown> => s.worktrees,
    NO_WORKTREES
  );
  // Measured against the worktrees that exist, so an id left behind by a
  // deleted worktree never keeps "Expand all" enabled over a fully open list.
  let collapsedLive = 0;
  for (const id of collapsed) if (worktreeIds.has(id)) collapsedLive++;
  const allCollapsed = worktreeIds.size > 0 && collapsedLive >= worktreeIds.size;
  return (
    <>
      <C.RadioGroup
        value={density}
        onValueChange={(value) => {
          const picked = CARD_DENSITY_OPTIONS.find((option) => option.value === value);
          if (picked) setDensity(picked.value);
        }}
      >
        {CARD_DENSITY_OPTIONS.map((option) => (
          <C.RadioItem key={option.value} value={option.value}>
            {option.label}
          </C.RadioItem>
        ))}
      </C.RadioGroup>
      <C.Separator />
      <C.Item disabled={allCollapsed} onSelect={() => collapseWorktrees([...worktreeIds.keys()])}>
        Collapse all cards
      </C.Item>
      <C.Item disabled={collapsedLive === 0} onSelect={expandAllWorktrees}>
        Expand all cards
      </C.Item>
    </>
  );
}

/** {@link WorktreeDensityItems} as a View ▸ submenu, for the longer menus. */
export function WorktreeDensitySubmenu({
  iconClassName,
  kind = "context",
}: {
  iconClassName: string;
  kind?: "context" | "dropdown";
}) {
  const C = kind === "context" ? CONTEXT : DROPDOWN;
  return (
    <C.Sub>
      <C.SubTrigger>
        <Rows3 className={iconClassName} aria-hidden="true" />
        View
      </C.SubTrigger>
      <C.SubContent>
        <WorktreeDensityItems kind={kind} />
      </C.SubContent>
    </C.Sub>
  );
}
