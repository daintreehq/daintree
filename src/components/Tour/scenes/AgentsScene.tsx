import { cn } from "@/lib/utils";
import {
  GRID_RECT,
  MockApp,
  MockGrid,
  MockWorktreeCard,
  toolbarAgentPoint,
} from "../mockup/MockApp";
import {
  MockCursor,
  MockPane,
  MockStreamingLines,
  MockTyping,
  reveal,
  useMockCursor,
  type CursorStep,
} from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";
import { MockEmptyGrid, MockSpotlight } from "./sceneParts";

const CLAUDE_BUTTON = toolbarAgentPoint("claude");
const INPUT_BAR = { x: GRID_RECT.x + 120, y: GRID_RECT.y + GRID_RECT.height - 12 };
const PROMPT = "Add a search box to the header";
const SEND = { cue: "send" } as const;

const CURSOR: readonly CursorStep[] = [
  { cue: "pick", offset: 0.8, at: CLAUDE_BUTTON },
  { cue: "click", offset: 0.15, at: CLAUDE_BUTTON, click: true },
  { cue: "type", at: INPUT_BAR },
  { cue: "type", offset: 0.6, at: INPUT_BAR, click: true },
];

export function AgentsScene() {
  const pick = useCue("pick");
  const open = useCue("open");
  const sent = useCue("send");
  const enterFaded = useCue("send", 0.9);
  const enterFlash = sent && !enterFaded;
  // The placeholder holds until the first character, so the bar never reads blank.
  const typing = useCue("type", 0.75);
  const cursor = useMockCursor({ x: 420, y: 220 }, CURSOR);

  return (
    <MockApp
      branch={"add-search"}
      focus={["toolbar", "grid"]}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" />
          <MockWorktreeCard
            name="add-search"
            branch="add-search"
            selected
            states={sent ? ["working"] : []}
          />
        </>
      }
      grid={
        open ? (
          <MockGrid columns={1} className={reveal(open)}>
            <MockPane
              agent="claude"
              state={sent ? "working" : null}
              focused
              input={
                typing && !sent ? (
                  <MockTyping cue="type" text={PROMPT} delay={0.7} finishBy={SEND} />
                ) : null
              }
              inputAddon={
                <span
                  className={cn(
                    "rounded-sm border border-border-strong px-1 text-3xs text-text-secondary transition-opacity duration-150 ease-out",
                    enterFlash ? "opacity-100" : "opacity-0"
                  )}
                >
                  Enter
                </span>
              }
            >
              <div className={cn("mb-2 text-2xs text-text-secondary", reveal(sent, "none"))}>
                › {PROMPT}
              </div>
              <MockStreamingLines
                cue="send"
                delay={0.5}
                widths={[88, 72, 94, 60, 80, 66, 90]}
                perSecond={3}
              />
            </MockPane>
          </MockGrid>
        ) : (
          <MockEmptyGrid label="add-search" />
        )
      }
    >
      {/* "Each one gets a button in the toolbar" — every installed agent, not just one. */}
      <MockSpotlight targets={["toolbar-agents"]} visible={pick && !open} />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
