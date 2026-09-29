import { ChevronDown, RadioTower, X } from "lucide-react";
import {
  type CursorStep,
  MockCursor,
  MockSpotlight,
  MockStreamingLines,
  MockTyping,
  useMockCursor,
  useTourShortcuts,
} from "@daintreehq/tour/kit";
import {
  type MockAgentId,
  MockApp,
  MockGrid,
  MockPane,
  MockWorktreeCard,
} from "@daintreehq/tour/mock-app";
import { useCue } from "@daintreehq/tour/react";

const PANES: readonly MockAgentId[] = ["claude", "codex", "antigravity"];
const PROMPT = "Run the tests";
const SEND = { cue: "send" } as const;
/** Marks the steps that hold Shift; drawn with the keyboard's own label. */
const SHIFT = "shift";

/** Where a pane's title bar is clicked — shift-click only counts on the title bar. */
const titleBar = (agent: MockAgentId) => ({ anchor: `${agent}-titlebar`, dx: -12 });
const FIRST_INPUT = { anchor: "claude-input", dx: -16, dy: 6 };

export const CURSOR: readonly CursorStep[] = [
  // Claude is the focused panel; the first shift-click arms it along with Codex.
  { cue: "pick", at: titleBar("codex"), modifier: SHIFT },
  { cue: "pick", offset: 0.5, at: titleBar("codex"), click: true, modifier: SHIFT },
  { cue: "pick", offset: 1.0, at: titleBar("antigravity"), modifier: SHIFT },
  { cue: "pick", offset: 1.5, at: titleBar("antigravity"), click: true, modifier: SHIFT },
  { cue: "out", offset: 0.1, at: titleBar("antigravity"), click: true, modifier: SHIFT },
  { cue: "out", offset: 1.0, at: titleBar("antigravity"), click: true, modifier: SHIFT },
  { cue: "bolt", at: { anchor: "sidebar-arm" } },
  { cue: "type", at: FIRST_INPUT },
  { cue: "type", offset: 0.5, at: FIRST_INPUT, click: true },
  { cue: "exit", at: titleBar("claude") },
  { cue: "exit", offset: 0.5, at: titleBar("claude"), click: true },
];

/** The fleet ribbon as the app draws it: amber tint, a left stripe, the count, and Exit. */
function FleetRibbon({ count, exitHint }: { count: number; exitHint: string }) {
  return (
    <div className="relative mb-1.5 flex h-6 shrink-0 items-center gap-2 rounded-sm border-b border-border-default bg-category-amber-subtle px-2 text-3xs text-text-primary before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-category-amber-text">
      <X className="size-2.5 text-text-secondary" aria-hidden="true" />
      <span className="flex items-center gap-0.5 font-medium tabular-nums">
        {count} in fleet
        <ChevronDown className="size-2.5 text-text-secondary" aria-hidden="true" />
      </span>
      <span className="flex-1" />
      <span className="rounded-sm bg-overlay-subtle px-1.5 py-px text-text-secondary">
        Exit {exitHint}
      </span>
    </div>
  );
}

export function FleetScene() {
  const firstPair = useCue("pick", 0.55);
  const third = useCue("pick", 1.55);
  const outAgain = useCue("out", 0.15);
  const backIn = useCue("out", 1.05);
  const markers = useCue("armed");
  const bolt = useCue("bolt");
  const typeCue = useCue("type");
  const typing = useCue("type", 0.5);
  const sent = useCue("send");
  const left = useCue("exit", 0.55);
  const cursor = useMockCursor({ x: 420, y: 300 }, CURSOR);
  const shortcuts = useTourShortcuts();
  const mac = shortcuts.keyboard === "mac";

  const antigravityIn = third && (!outAgain || backIn);
  const armed = [firstPair && !left, firstPair && !left, antigravityIn && !left];
  const count = armed.filter(Boolean).length;

  return (
    <MockApp
      focus={bolt && !typeCue ? ["grid", "sidebar"] : ["grid"]}
      worktrees={
        <>
          <MockWorktreeCard
            name="shop-app"
            branch="main"
            selected
            states={[sent ? "working" : "waiting"]}
          />
          <MockWorktreeCard name="fix-login-redirect" branch="fix-login-redirect" />
          <MockWorktreeCard name="add-search" branch="add-search" />
        </>
      }
      grid={
        // No reserved space: the ribbon appears only once two panels are armed,
        // and the panels give up the room it takes.
        <div className="flex size-full flex-col">
          {count >= 2 && <FleetRibbon count={count} exitHint={shortcuts.hint("fleet.exit")} />}
          <MockGrid columns={3} className="min-h-0 flex-1">
            {PANES.map((agent, i) => {
              const mirrored = typing && !sent && i > 0 && armed[i];
              return (
                <MockPane
                  key={agent}
                  agent={agent}
                  armed={armed[i]}
                  state={sent ? "working" : "waiting"}
                  focused={i === 0}
                  input={
                    !typing || sent ? null : i === 0 ? (
                      <MockTyping cue="type" text={PROMPT} delay={0.3} finishBy={SEND} />
                    ) : mirrored ? (
                      <span className="text-text-secondary">
                        <MockTyping
                          cue="type"
                          text={PROMPT}
                          delay={0.3}
                          finishBy={SEND}
                          caret={false}
                        />
                      </span>
                    ) : null
                  }
                >
                  {i === 0 && typing && !sent && (
                    <span className="mb-2 inline-flex items-center gap-1 rounded-full bg-category-amber-subtle px-1.5 py-0.5 text-3xs text-text-primary">
                      <RadioTower
                        className="size-2.5 text-category-amber-text"
                        aria-hidden="true"
                      />
                      Mirroring to 2 peers
                    </span>
                  )}
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
      {/* The towers as they're named, then the bolt while it's named. */}
      <MockSpotlight
        targets={bolt ? ["sidebar-arm"] : ["claude-armed", "codex-armed", "antigravity-armed"]}
        visible={markers && !typeCue}
      />
      <MockCursor
        {...cursor}
        modifier={cursor.modifier === SHIFT ? (mac ? "⇧ Shift" : "Shift") : null}
        visible={cursor.visible && !left}
      />
    </MockApp>
  );
}
