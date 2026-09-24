import { cn } from "@/lib/utils";
import type { AgentState } from "@/types";
import {
  APP_LAYOUT,
  DOCK_WAITING_POINT,
  GRID_RECT,
  MockApp,
  MockGrid,
  MockWaitingPill,
  MockWorktreeCard,
} from "../mockup/MockApp";
import {
  MockCursor,
  MockLines,
  MockPane,
  MockStateGlyph,
  MockTyping,
  reveal,
  useMockCursor,
  type CursorStep,
  type MockAgentId,
} from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";
import { MockLegend, MockMenu, MockSpotlight } from "./sceneParts";

// Claude holds the check: Antigravity never reports finishing (its config has
// no completion patterns), so it can only ever show working or waiting.
const AGENTS: readonly MockAgentId[] = ["antigravity", "codex", "claude"];
const GAP = 6;
const PANE_WIDTH = (GRID_RECT.width - GAP * 2) / 3;

const QUESTION = "Search product names only, or descriptions too?";
const CODEX_INPUT = {
  x: GRID_RECT.x + PANE_WIDTH + GAP + PANE_WIDTH / 2,
  y: GRID_RECT.y + GRID_RECT.height - 11,
};

// The pill opens the "Waiting for input" list above it; picking a row jumps there.
const POPOVER = { width: 190, x: GRID_RECT.x + GRID_RECT.width - 190, y: 250 };
const WAITING_ROW = { x: POPOVER.x + 70, y: POPOVER.y + 42 };

const CURSOR: readonly CursorStep[] = [
  { cue: "jump", at: DOCK_WAITING_POINT },
  { cue: "jump", offset: 0.6, at: DOCK_WAITING_POINT, click: true },
  { cue: "pick", at: WAITING_ROW },
  { cue: "pick", offset: 0.4, at: WAITING_ROW, click: true },
  { cue: "answer", at: CODEX_INPUT },
  { cue: "answer", offset: 0.5, at: CODEX_INPUT, click: true },
];

export function StateScene() {
  const working = useCue("working");
  const waiting = useCue("waiting");
  const done = useCue("done");
  const pill = useCue("pill");
  const listOpen = useCue("jump", 0.7);
  const jumped = useCue("pick", 0.5);
  const answer = useCue("answer");
  const answering = useCue("answer", 0.6);
  // Long enough to read the reply before the spinner comes back.
  const answered = useCue("answer", 2.2);
  const cursor = useMockCursor({ x: 470, y: 250 }, CURSOR);

  const states: (AgentState | null)[] = [
    working ? "working" : null,
    answered ? "working" : waiting ? "waiting" : working ? "working" : null,
    done ? "completed" : working ? "working" : null,
  ];
  const live = states.filter((s): s is AgentState => s !== null);

  return (
    <MockApp
      focus={pill ? ["grid", "dock"] : ["grid"]}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" selected states={live} />
          <MockWorktreeCard name="add-search" branch="add-search" />
        </>
      }
      grid={
        <MockGrid columns={3}>
          {AGENTS.map((agent, i) => (
            <MockPane
              key={agent}
              agent={agent}
              state={states[i]}
              focused={i === 1 && jumped}
              input={
                i === 1 && answering && !answered ? (
                  <MockTyping cue="answer" text="Both" delay={0.7} charsPerSecond={8} />
                ) : null
              }
            >
              <MockLines widths={[82, 60, 90, 54, 72]} />
              {i === 1 && (
                <div
                  className={cn("mt-2 text-3xs text-text-primary", reveal(waiting && !answered))}
                >
                  {QUESTION}
                </div>
              )}
            </MockPane>
          ))}
        </MockGrid>
      }
      dock={<MockWaitingPill count={1} className={reveal(pill && !answered, "none")} />}
    >
      {/* One thing at a time: each glyph as it's named, then the waiting counter. */}
      <MockSpotlight
        targets={
          answer
            ? ["codex-input"]
            : listOpen
              ? ["menu-0"]
              : pill
                ? ["dock-waiting"]
                : done
                  ? ["claude-glyph"]
                  : waiting
                    ? ["codex-glyph"]
                    : ["antigravity-glyph"]
        }
        visible={working && !answered && !(jumped && !answer)}
      />
      <MockMenu
        visible={listOpen && !jumped}
        active={0}
        x={POPOVER.x}
        y={POPOVER.y}
        width={POPOVER.width}
        header={
          <div className="flex flex-col gap-0.5 px-2 pb-1 pt-0.5">
            <span className="text-3xs font-semibold text-text-primary">Waiting for input</span>
            <span className="text-3xs text-text-secondary">This worktree</span>
          </div>
        }
        items={[{ icon: <MockStateGlyph state="waiting" />, label: "Codex", detail: QUESTION }]}
      />
      <MockLegend
        visible={working && !pill}
        bottom={APP_LAYOUT.dockHeight + 14}
        items={[
          {
            glyph: <MockStateGlyph state="working" />,
            label: "working",
            active: working && !waiting,
          },
          {
            glyph: <MockStateGlyph state="waiting" />,
            label: "waiting for you",
            active: waiting && !done,
          },
          {
            glyph: <MockStateGlyph state="completed" />,
            label: "looks finished",
            active: done,
          },
        ]}
      />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
