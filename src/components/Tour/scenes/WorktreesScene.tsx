import { GitBranch, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { MockCursor, MockTyping, reveal, useMockCursor, type CursorStep } from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";

const PLUS = { x: 263, y: 48 };
const NAME_FIELD = { x: 470, y: 156 };
const CREATE_BUTTON = { x: 520, y: 218 };

const CURSOR: readonly CursorStep[] = [
  { cue: "plus", at: PLUS },
  { cue: "plus", offset: 0.6, at: PLUS, click: true },
  { cue: "name", at: NAME_FIELD },
  { cue: "create", at: CREATE_BUTTON },
  { cue: "create", offset: 0.6, at: CREATE_BUTTON, click: true },
];

function WorktreeRow({
  name,
  branch,
  selected,
  className,
}: {
  name: string;
  branch: string;
  selected: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md px-2.5 py-2 transition-colors duration-150 ease-out",
        selected ? "bg-overlay-selected" : "bg-transparent",
        className
      )}
    >
      <GitBranch className="size-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-2xs font-medium text-text-primary">{name}</span>
        <span className="truncate text-3xs text-text-secondary">{branch}</span>
      </div>
    </div>
  );
}

export function WorktreesScene() {
  const list = useCue("list");
  const dialogOpen = useCue("plus", 0.7);
  const created = useCue("create", 0.7);
  const cursor = useMockCursor({ x: 600, y: 330 }, CURSOR);

  return (
    <div className="relative size-full">
      <div className="absolute left-[60px] top-[30px] flex w-[220px] flex-col pb-1 rounded-lg border border-border-default bg-surface-sidebar">
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-border-subtle px-3">
          <span className="text-2xs font-semibold text-text-primary">Worktrees</span>
          <span className="flex size-5 items-center justify-center rounded-md text-text-secondary">
            <Plus className="size-3.5" aria-hidden="true" />
          </span>
        </div>
        <div className={cn("flex flex-col gap-1 p-2", reveal(list))}>
          <WorktreeRow name="shop-app" branch="main" selected={!created} />
          <WorktreeRow name="fix-login-redirect" branch="fix-login-redirect" selected={false} />
          <WorktreeRow
            name="add-search"
            branch="add-search"
            selected={created}
            className={reveal(created, "left")}
          />
        </div>
      </div>

      <div
        className={cn(
          "absolute left-[330px] top-[72px] w-[250px] rounded-lg border border-border-strong bg-surface-dialog p-4 shadow-[var(--theme-shadow-ambient)]",
          reveal(dialogOpen && !created)
        )}
      >
        <div className="mb-3 text-xs font-semibold text-text-primary">Create worktree</div>
        <div className="mb-2 flex flex-col gap-1">
          <span className="text-3xs font-medium text-text-secondary">Base</span>
          <div className="flex h-6 items-center rounded-md border border-border-input bg-surface-input px-2 text-2xs text-text-primary">
            main
          </div>
        </div>
        <div className="mb-4 flex flex-col gap-1">
          <span className="text-3xs font-medium text-text-secondary">Name</span>
          <div className="flex h-6 items-center rounded-md border border-border-interactive bg-surface-input px-2 text-2xs text-text-primary">
            <MockTyping cue="name" text="add-search" delay={0.4} charsPerSecond={14} />
          </div>
        </div>
        <div className="flex justify-end">
          <span className="rounded-md bg-text-primary px-2.5 py-1 text-2xs font-medium text-text-inverse">
            Create worktree
          </span>
        </div>
      </div>

      <MockCursor {...cursor} />
    </div>
  );
}
