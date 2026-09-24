import { CirclePlay, Keyboard, ListChecks, Sparkles } from "lucide-react";
import { MockApp, MockGrid, MockWorktreeCard } from "../mockup/MockApp";
import { MockLines, MockPane, MockTyping } from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";
import { MockKeys, MockMenu, MockSearchField, type MockMenuItem } from "./sceneParts";

const PALETTE = { x: 170, y: 48, width: 300 } as const;

// Real palette rows: the action's title, its summary, and its shortcut — no icons.
const RESULTS: readonly MockMenuItem[] = [
  { label: "New worktree", detail: "Create a worktree for a new task", hint: "⌘K ⌘N" },
  { label: "New terminal", detail: "Open a shell in this worktree", hint: "⌘⌥T" },
  { label: "New window", detail: "Open another Daintree window", hint: "⌘⇧⌥N" },
];
// Help drops from the menu bar, so it hangs from the window's top edge.
const HELP_MENU = { x: 360, y: 0, width: 180 } as const;

export function PaletteScene() {
  const keys = useCue("palette");
  const palette = useCue("palette", 1.5);
  const typed = useCue("type", 0.9);
  const stepped = useCue("type", 2.5);
  const help = useCue("help");

  return (
    <MockApp
      focus={palette || help ? [] : undefined}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" selected />
          <MockWorktreeCard name="add-search" branch="add-search" states={["completed"]} />
        </>
      }
      grid={
        <MockGrid columns={2}>
          <MockPane agent="claude" state="working">
            <MockLines widths={[80, 56, 90, 64]} />
          </MockPane>
          <MockPane agent="codex" state="completed">
            <MockLines widths={[70, 84, 52]} />
          </MockPane>
        </MockGrid>
      }
    >
      <MockKeys keys={["⌘", "⇧", "P"]} x={320} y={180} visible={keys && !palette} />
      <MockMenu
        visible={palette && !help}
        active={stepped ? 1 : 0}
        x={PALETTE.x}
        y={PALETTE.y}
        width={PALETTE.width}
        header={
          <MockSearchField>
            <TypedQuery />
          </MockSearchField>
        }
        items={typed ? RESULTS : []}
      />
      <MockMenu
        visible={help}
        active={1}
        x={HELP_MENU.x}
        y={HELP_MENU.y}
        width={HELP_MENU.width}
        items={[
          { icon: <ListChecks />, label: "Getting Started" },
          { icon: <CirclePlay />, label: "Daintree Tour" },
          { icon: <Keyboard />, label: "Keyboard Shortcuts", hint: "⌘/" },
          { icon: <Sparkles />, label: "Launch Help Agent", hint: "⌘⇧H", separator: true },
        ]}
      />
    </MockApp>
  );
}

function TypedQuery() {
  const typing = useCue("type", 0.2);
  if (!typing) return <span className="text-text-placeholder">Find an action</span>;
  return (
    <span className="text-text-primary">
      <MockTyping cue="type" text="new" delay={0.2} charsPerSecond={6} />
    </span>
  );
}
