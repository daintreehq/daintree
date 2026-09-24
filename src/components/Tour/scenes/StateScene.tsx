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
import { MockLegend, MockSpotlight } from "./sceneParts";

const AGENTS: readonly MockAgentId[] = ["claude", "codex", "antigravity"];
const GAP = 6;
const PANE_WIDTH = (GRID_RECT.width - GAP * 2) / 3;

const QUESTION = "Search product names only, or descriptions too?";
const CODEX_INPUT = {
  x: GRID_RECT.x + PANE_WIDTH + GAP + PANE_WIDTH / 2,
  y: GRID_RECT.y + GRID_RECT.height - 11,
};

const CURSOR: readonly CursorStep[] = [
  { cue: "jump", at: DOCK_WAITING_POINT },
  { cue: "jump", offset: 0.6, at: DOCK_WAITING_POINT, click: true },
  { cue: "answer", at: CODEX_INPUT },
  { cue: "answer", offset: 0.5, at: CODEX_INPUT, click: true },
];

export function StateScene() {
  const working = useCue("working");
  const waiting = useCue("waiting");
  const done = useCue("done");
  const pill = useCue("pill");
  const jumped = useCue("jump", 0.8);
  const answering = useCue("answer", 0.6);
  const answered = useCue("answer", 1.6);
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
          pill
            ? ["dock-waiting"]
            : done
              ? ["antigravity-glyph"]
              : waiting
                ? ["codex-glyph"]
                : ["claude-glyph"]
        }
        visible={working && !jumped}
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
            label: "finished its turn",
            active: done,
          },
        ]}
      />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
