import { Check, ChevronDown, RadioTower, X } from "lucide-react";
import {
  cn,
  type CursorStep,
  MockCursor,
  MockSearchField,
  MockSpotlight,
  MockStreamingLines,
  MockTyping,
  reveal,
  useMockCursor,
  useTourShortcuts,
} from "@daintreehq/tour/kit";
import {
  MockAgentIcon,
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
const HEADER = { anchor: "sidebar-header", dx: 10 };
const BOLT = { anchor: "sidebar-arm" };
// Antigravity was shift-clicked back out, so the list is where it rejoins.
const PICK_ROW = { anchor: "fleet-picker-antigravity", dx: -40 };
const ARM = { anchor: "fleet-picker-arm" };
const EXIT = { anchor: "fleet-exit" };
const PICKER = { x: 170, y: 44, width: 300 } as const;
const NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
};

export const CURSOR: readonly CursorStep[] = [
  // Claude is the focused panel; the first shift-click arms it along with Codex.
  { cue: "pick", at: titleBar("codex"), modifier: SHIFT },
  { cue: "pick", offset: 0.5, at: titleBar("codex"), click: true, modifier: SHIFT },
  { cue: "pick", offset: 1.0, at: titleBar("antigravity"), modifier: SHIFT },
  { cue: "pick", offset: 1.5, at: titleBar("antigravity"), click: true, modifier: SHIFT },
  { cue: "out", offset: 0.1, at: titleBar("antigravity"), click: true, modifier: SHIFT },
  // Hovering the header is what shows the bolt.
  { cue: "hover", at: HEADER },
  { cue: "bolt", offset: -0.2, at: BOLT },
  { cue: "bolt", offset: 0.2, at: BOLT, click: true },
  { cue: "list", at: PICK_ROW },
  { cue: "list", offset: 0.15, at: PICK_ROW, click: true },
  { cue: "list", offset: 0.4, at: ARM },
  { cue: "list", offset: 0.55, at: ARM, click: true },
  { cue: "type", at: FIRST_INPUT },
  { cue: "type", offset: 0.5, at: FIRST_INPUT, click: true },
  { cue: "exit", offset: -0.3, at: EXIT },
  { cue: "exit", offset: 0.3, at: EXIT, click: true },
];

/** The fleet ribbon as the app draws it: amber band, a left stripe, the count, and Exit. */
function FleetRibbon({ count, exitHint }: { count: number; exitHint: string }) {
  return (
    <div className="relative mb-1.5 flex h-6 shrink-0 items-center gap-2 rounded-sm border-b border-border-default px-2 text-3xs text-text-primary fleet-ribbon-surface before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-[var(--fleet-ribbon-ink)]">
      <X className="size-2.5 text-text-secondary" aria-hidden="true" />
      <span className="flex items-center gap-0.5 font-medium tabular-nums">
        {count} in fleet
        <ChevronDown className="size-2.5 text-text-secondary" aria-hidden="true" />
      </span>
      <span className="flex-1" />
      <span
        data-tour-anchor="fleet-exit"
        className="rounded-sm bg-overlay-subtle px-1.5 py-px text-text-secondary"
      >
        Exit {exitHint}
      </span>
    </div>
  );
}

/** The bolt's picker: every panel in the grid, the ones already in the fleet ticked. */
function FleetPicker({ open, selected }: { open: boolean; selected: readonly boolean[] }) {
  const adding = selected.filter(Boolean).length - 2;
  return (
    <div
      data-tour-anchor="fleet-picker"
      className={cn(
        "absolute z-20 flex flex-col rounded-lg border border-border-strong bg-surface-dialog p-2 shadow-[var(--theme-shadow-ambient)]",
        reveal(open)
      )}
      style={{ left: PICKER.x, top: PICKER.y, width: PICKER.width }}
    >
      <MockSearchField>
        <span className="text-text-secondary">Search terminals, worktrees, branches…</span>
      </MockSearchField>
      {PANES.map((agent, i) => (
        <div
          key={agent}
          data-tour-anchor={`fleet-picker-${agent}`}
          className={cn(
            "flex h-[18px] items-center gap-1.5 rounded-md px-1.5 transition-colors duration-150 ease-out",
            selected[i] ? "bg-overlay-selected" : "bg-transparent"
          )}
        >
          <span
            className={cn(
              "flex size-2.5 shrink-0 items-center justify-center rounded-sm border",
              selected[i] ? "border-text-primary bg-text-primary" : "border-border-strong"
            )}
          >
            {selected[i] && <Check className="size-2 text-text-inverse" aria-hidden="true" />}
          </span>
          <MockAgentIcon agent={agent} className="size-3" />
          <span className="min-w-0 flex-1 truncate text-3xs text-text-primary">{NAMES[agent]}</span>
          <span className="text-3xs text-text-secondary">shop-app</span>
        </div>
      ))}
      <div className="mt-1.5 flex items-center justify-end border-t border-border-subtle pt-1.5">
        <span
          data-tour-anchor="fleet-picker-arm"
          className="rounded-md bg-text-primary px-2 py-0.5 text-3xs font-medium text-text-inverse"
        >
          {adding > 0 ? `Arm ${adding} selected` : "Arm selected"}
        </span>
      </div>
    </div>
  );
}

export function FleetScene() {
  const firstPair = useCue("pick", 0.55);
  const third = useCue("pick", 1.55);
  const outAgain = useCue("out", 0.15);
  const markers = useCue("armed");
  const hover = useCue("hover");
  const bolt = useCue("bolt");
  const pickerOpen = useCue("bolt", 0.35);
  const listCue = useCue("list");
  const ticked = useCue("list", 0.2);
  const rejoined = useCue("list", 0.6);
  const typeCue = useCue("type");
  const typing = useCue("type", 0.5);
  const sent = useCue("send");
  const exitCue = useCue("exit");
  const left = useCue("exit", 0.35);
  const cursor = useMockCursor({ x: 420, y: 300 }, CURSOR);
  const shortcuts = useTourShortcuts();
  const mac = shortcuts.keyboard === "mac";

  const antigravityIn = third && (!outAgain || rejoined);
  const armed = [firstPair && !left, firstPair && !left, antigravityIn && !left];
  const count = armed.filter(Boolean).length;
  const picking = pickerOpen && !rejoined && !typeCue;
  // The bolt shows while the pointer is over the header, and until the list it opens closes.
  const boltShown = hover && !rejoined && !typeCue;

  return (
    <MockApp
      focus={hover && !typeCue ? ["grid", "sidebar"] : ["grid"]}
      sidebarArm={boltShown}
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
      <FleetPicker open={picking} selected={[true, true, ticked]} />
      {/* The towers as they're named, then the header, its bolt, the list, and Exit. */}
      <MockSpotlight
        targets={
          exitCue
            ? ["fleet-exit"]
            : listCue
              ? ["fleet-picker"]
              : bolt
                ? ["sidebar-arm"]
                : hover
                  ? ["sidebar-header"]
                  : ["claude-armed", "codex-armed"]
        }
        visible={(markers && !typeCue && (!pickerOpen || picking)) || (exitCue && !left)}
      />
      <MockCursor
        {...cursor}
        modifier={cursor.modifier === SHIFT ? (mac ? "⇧ Shift" : "Shift") : null}
        visible={cursor.visible && !left}
      />
    </MockApp>
  );
}
