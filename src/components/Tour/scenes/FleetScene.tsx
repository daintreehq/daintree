import { RadioTower } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  GRID_RECT,
  MockApp,
  MockGrid,
  MockWorktreeCard,
  SIDEBAR_ARM_POINT,
} from "../mockup/MockApp";
import { MockSpotlight } from "./sceneParts";
import {
  MockCursor,
  MockPane,
  MockStreamingLines,
  MockTyping,
  reveal,
  useMockCursor,
  type CursorStep,
  type MockAgentId,
} from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";

const PANES: readonly MockAgentId[] = ["claude", "codex", "antigravity"];
const PROMPT = "Run the tests and fix failures";
const SEND = { cue: "send" } as const;
const RIBBON_HEIGHT = 22;

const GAP = 6;
const PANE_WIDTH = (GRID_RECT.width - GAP * 2) / 3;
/** Where pane i's title bar is clicked. */
const headerAt = (i: number) => ({
  x: GRID_RECT.x + i * (PANE_WIDTH + GAP) + 64,
  y: GRID_RECT.y + RIBBON_HEIGHT + GAP + 12,
});
const FIRST_INPUT = { x: GRID_RECT.x + 60, y: GRID_RECT.y + GRID_RECT.height - 11 };
const SHIFT = "⇧ Shift";

const CURSOR: readonly CursorStep[] = [
  { cue: "pick", at: headerAt(0), modifier: SHIFT },
  { cue: "pick", offset: 0.5, at: headerAt(0), click: true, modifier: SHIFT },
  { cue: "pick", offset: 0.9, at: headerAt(1), modifier: SHIFT },
  { cue: "pick", offset: 1.4, at: headerAt(1), click: true, modifier: SHIFT },
  { cue: "pick", offset: 1.8, at: headerAt(2), modifier: SHIFT },
  { cue: "pick", offset: 2.3, at: headerAt(2), click: true, modifier: SHIFT },
  { cue: "bolt", at: SIDEBAR_ARM_POINT },
  { cue: "type", at: FIRST_INPUT },
  { cue: "type", offset: 0.6, at: FIRST_INPUT, click: true },
];

export function FleetScene() {
  // Each shift-click lands a beat after the pointer arrives.
  const armed = [useCue("pick", 0.55), useCue("pick", 1.45), useCue("pick", 2.35)];
  const armedCount = armed.filter(Boolean).length;
  const bolt = useCue("bolt");
  const markers = useCue("armed");
  const sent = useCue("send");
  const typing = useCue("type", 0.55);
  const typingStarted = useCue("type");
  const cursor = useMockCursor({ x: 420, y: 340 }, CURSOR);

  return (
    <MockApp
      focus={bolt && !markers ? ["grid", "sidebar"] : ["grid"]}
      worktrees={
        <MockWorktreeCard
          name="shop-app"
          branch="main"
          selected
          states={sent ? ["working", "working", "working"] : ["waiting", "waiting", "waiting"]}
        />
      }
      grid={
        <div className="flex size-full flex-col gap-1.5">
          <div className="flex shrink-0 items-center" style={{ height: RIBBON_HEIGHT }}>
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full border border-border-strong bg-surface-panel px-2 py-0.5",
                reveal(armedCount > 0, "above")
              )}
            >
              <RadioTower className="size-3 text-category-amber-text" aria-hidden="true" />
              <span className="text-3xs font-medium tabular-nums text-text-primary">
                {armedCount} in fleet
              </span>
            </span>
          </div>
          <MockGrid columns={3} className="min-h-0 flex-1">
            {PANES.map((agent, i) => {
              const mirrored = typing && !sent && i > 0 && armed[i];
              return (
                <MockPane
                  key={agent}
                  agent={agent}
                  armed={armed[i]}
                  state={sent ? "working" : "waiting"}
                  focused={i === 0 && armed[0]}
                  input={
                    !typing || sent ? null : i === 0 ? (
                      <MockTyping cue="type" text={PROMPT} delay={0.5} finishBy={SEND} />
                    ) : mirrored ? (
                      <span className="text-text-secondary">
                        <MockTyping
                          cue="type"
                          text={PROMPT}
                          delay={0.5}
                          finishBy={SEND}
                          caret={false}
                        />
                      </span>
                    ) : null
                  }
                >
                  <MockStreamingLines
                    cue="send"
                    delay={0.3 + i * 0.15}
                    widths={[86, 64, 92, 58, 76, 70]}
                    perSecond={3}
                  />
                </MockPane>
              );
            })}
          </MockGrid>
        </div>
      }
    >
      {/* The bolt while it's named, then every radio tower as it's named. */}
      <MockSpotlight
        targets={markers ? ["claude-armed", "codex-armed", "antigravity-armed"] : ["sidebar-arm"]}
        visible={(bolt && !markers) || (markers && !typingStarted)}
      />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
