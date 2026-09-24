import {
  ClaudeIcon,
  CodexIcon,
  AntigravityIcon,
  CursorIcon,
  OpenCodeIcon,
} from "@/components/icons";
import { cn } from "@/lib/utils";
import { ANCHOR, GRID_RECT, MockApp, MockGrid, MockWorktreeCard } from "../mockup/MockApp";
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
import { MockEmptyGrid, MockMenu, MockSearchField, MockSpotlight } from "./sceneParts";

const LAUNCHER = ANCHOR.launcher;
const MENU = { x: LAUNCHER.x - 8, y: LAUNCHER.y + 14, width: 164 };
// The launcher's first agent row, under its search field.
const CLAUDE_ROW = { x: MENU.x + 50, y: MENU.y + 36 };
const INPUT_BAR = { x: GRID_RECT.x + 120, y: GRID_RECT.y + GRID_RECT.height - 12 };
const TERMINAL = { x: GRID_RECT.x + 160, y: GRID_RECT.y + 120 };
const PROMPT = "Add a search box to the header";
const SEND = { cue: "send" } as const;

const CURSOR: readonly CursorStep[] = [
  // The pointer rests on the pinned agents as they're named.
  { cue: "pick", at: ANCHOR["agent-codex"] },
  { cue: "launcher", at: LAUNCHER },
  { cue: "launcher", offset: 0.5, at: LAUNCHER, click: true },
  { cue: "click", at: CLAUDE_ROW },
  { cue: "click", offset: 0.5, at: CLAUDE_ROW, click: true },
  { cue: "type", at: INPUT_BAR },
  { cue: "type", offset: 0.6, at: INPUT_BAR, click: true },
  { cue: "term", at: TERMINAL },
  { cue: "term", offset: 0.6, at: TERMINAL, click: true },
];

export function AgentsScene() {
  const agents = useCue("agents");
  const launcher = useCue("launcher");
  const menuOpen = useCue("launcher", 0.6);
  const clicked = useCue("click", 0.6);
  const open = useCue("open");
  const typing = useCue("type", 0.75);
  const sent = useCue("send");
  const enterFaded = useCue("send", 0.9);
  const enterFlash = sent && !enterFaded;
  const term = useCue("term");
  const termFocused = useCue("term", 0.7);
  const cursor = useMockCursor({ x: 420, y: 220 }, CURSOR);

  // One thing at a time: the pinned agents, then the launcher, then the prompt bar,
  // then the terminal itself.
  const spot = term
    ? ["claude-body"]
    : open
      ? typing && !sent
        ? ["claude-input"]
        : []
      : menuOpen
        ? clicked
          ? []
          : ["menu-0"]
        : launcher
          ? ["launcher"]
          : ["toolbar-agents"];

  return (
    <MockApp
      branch="add-search"
      focus={["toolbar", "grid"]}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" />
          <MockWorktreeCard name="fix-login-redirect" branch="fix-login-redirect" />
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
                widths={[88, 72, 94, 60, 80]}
                perSecond={3}
              />
              {/* Typing straight into the terminal: a fresh prompt line with a caret. */}
              <div
                className={cn(
                  "mt-2 flex items-center gap-1 font-mono text-2xs text-text-primary",
                  reveal(termFocused, "none")
                )}
              >
                ›
                <span className="inline-block h-3 w-1.5 bg-text-primary motion-safe:animate-pulse" />
              </div>
            </MockPane>
          </MockGrid>
        ) : (
          <MockEmptyGrid label="add-search" />
        )
      }
    >
      <MockMenu
        visible={menuOpen && !clicked}
        active={0}
        x={MENU.x}
        y={MENU.y}
        width={MENU.width}
        header={
          <MockSearchField>
            <span className="text-text-secondary">Search agents, panels…</span>
          </MockSearchField>
        }
        items={[
          { icon: <ClaudeIcon />, label: "Claude" },
          { icon: <CodexIcon />, label: "Codex" },
          { icon: <AntigravityIcon />, label: "Antigravity" },
          { icon: <CursorIcon />, label: "Cursor" },
          { icon: <OpenCodeIcon />, label: "OpenCode" },
        ]}
      />
      <MockSpotlight targets={spot} visible={agents && spot.length > 0} />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
