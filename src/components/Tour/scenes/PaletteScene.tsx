import {
  CirclePlay,
  GitBranch,
  Keyboard,
  ListChecks,
  MonitorPlay,
  Plus,
  Sparkles,
} from "lucide-react";
import { ClaudeIcon } from "@/components/icons";
import { MockApp, MockGrid, MockWorktreeCard } from "../mockup/MockApp";
import { MockLines, MockPane, MockTyping } from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";
import { MockKeys, MockMenu, MockSearchField } from "./sceneParts";

const PALETTE = { x: 170, y: 48, width: 300 } as const;

export function PaletteScene() {
  const keys = useCue("palette");
  const palette = useCue("palette", 0.8);
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
        active={0}
        x={PALETTE.x}
        y={PALETTE.y}
        width={PALETTE.width}
        header={
          <MockSearchField>
            <span className="text-text-primary">
              <MockTyping cue="palette" text="new" delay={1.2} charsPerSecond={8} />
            </span>
          </MockSearchField>
        }
        items={[
          { icon: <GitBranch />, label: "Create a new worktree", hint: "⌘K ⌘N" },
          { icon: <ClaudeIcon />, label: "Launch Claude Code agent", hint: "⌘⌥C" },
          { icon: <Plus />, label: "Open panel palette", hint: "⌘N" },
          { icon: <MonitorPlay />, label: "Open dev preview" },
        ]}
      />
      <MockMenu
        visible={help}
        active={1}
        x={PALETTE.x + 60}
        y={PALETTE.y}
        width={180}
        header={
          <span className="block px-2 py-1 text-3xs font-semibold text-text-primary">Help</span>
        }
        items={[
          { icon: <ListChecks />, label: "Getting Started" },
          { icon: <CirclePlay />, label: "Daintree Tour" },
          { icon: <Keyboard />, label: "Keyboard Shortcuts", hint: "⌘/" },
          { icon: <Sparkles />, label: "Launch Help Agent", hint: "⌘⇧H" },
        ]}
      />
    </MockApp>
  );
}
