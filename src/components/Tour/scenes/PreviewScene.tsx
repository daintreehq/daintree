import {
  ArrowLeft,
  ArrowRight,
  FolderTree,
  Globe,
  MonitorPlay,
  Play,
  RotateCw,
  Search,
  SquareTerminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ANCHOR, GRID_RECT, MockApp, MockGrid, MockWorktreeCard } from "../mockup/MockApp";
import {
  MockCursor,
  MockPane,
  MockStateGlyph,
  MockStreamingLines,
  reveal,
  useMockCursor,
  type CursorStep,
} from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";
import { MockMenu, MockPanel, MockSearchField, MockSpotlight } from "./sceneParts";

const LAUNCHER = ANCHOR.launcher;
const MENU = { x: LAUNCHER.x - 8, y: LAUNCHER.y + 14, width: 164 };
// The menu's fourth row, Dev preview; measured from the render.
const DEV_PREVIEW_ITEM = { x: 118, y: 138 };

// Two equal columns once the preview opens; the preview is the right one.
const COLUMN = (GRID_RECT.width - 6) / 2;
const PREVIEW_X = GRID_RECT.x + COLUMN + 6;
// The start prompt's Run button, centred in the preview; measured from the render.
const RUN_BUTTON = { x: PREVIEW_X + COLUMN / 2, y: 229 };
const CONSOLE_TOGGLE = { x: GRID_RECT.x + GRID_RECT.width - 12, y: GRID_RECT.y + 36 };

const CURSOR: readonly CursorStep[] = [
  { cue: "launch", at: LAUNCHER },
  { cue: "launch", offset: 0.5, at: LAUNCHER, click: true },
  { cue: "pickpreview", offset: -0.4, at: DEV_PREVIEW_ITEM },
  { cue: "pickpreview", offset: 0.1, at: DEV_PREVIEW_ITEM, click: true },
  { cue: "start", at: RUN_BUTTON },
  { cue: "start", offset: 0.5, at: RUN_BUTTON, click: true },
  { cue: "console", at: CONSOLE_TOGGLE },
  { cue: "console", offset: 0.5, at: CONSOLE_TOGGLE, click: true },
];

/** The shop's storefront as the dev server renders it — a page, not UI chrome. */
function MockPage({ withSearch }: { withSearch: boolean }) {
  return (
    <div className="flex size-full flex-col bg-surface-canvas">
      <div className="flex h-7 items-center gap-2 border-b border-border-subtle px-3">
        <span className="size-3 rounded-full bg-text-secondary" />
        <span className="h-1.5 w-10 rounded-full bg-overlay-strong" />
        <span className="flex-1" />
        <span
          data-tour-anchor="dev-search"
          className={cn(
            "flex h-4 w-24 items-center gap-1 rounded-full border border-border-strong px-1.5",
            "transition-[opacity,scale] duration-300 ease-out reduce-motion:scale-100",
            withSearch ? "scale-100 opacity-100" : "scale-90 opacity-0"
          )}
        >
          <Search className="size-2 text-text-secondary" aria-hidden="true" />
          <span className="h-1 w-10 rounded-full bg-overlay-strong" />
        </span>
        <span className="h-1.5 w-6 rounded-full bg-overlay-strong" />
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <span className="h-3 w-24 rounded-full bg-overlay-strong" />
        <span className="h-1.5 w-32 rounded-full bg-overlay-medium" />
        <div className="mt-1 grid flex-1 grid-cols-2 gap-2">
          {[0, 1].map((i) => (
            <span key={i} className="rounded-md bg-overlay-medium" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** First run: Daintree found a dev script and asks before running it. */
function StartPrompt({ starting }: { starting: boolean }) {
  if (starting) {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-1.5">
        <MockStateGlyph state="working" />
        <span className="text-3xs font-medium text-text-primary">Starting dev server</span>
      </div>
    );
  }
  return (
    <div className="flex size-full flex-col items-center justify-center gap-1.5 px-3 text-center">
      <span className="text-2xs font-semibold text-text-primary">Start the dev server</span>
      <span className="flex items-center gap-1 text-3xs text-text-secondary">
        Auto-detected
        <span className="rounded-sm bg-surface-input px-1 font-mono text-text-primary">
          npm run dev
        </span>
      </span>
      <span
        data-tour-anchor="dev-run"
        className="mt-1 inline-flex items-center gap-1 rounded-md bg-text-primary px-2 py-1 text-3xs font-medium text-text-inverse"
      >
        <Play className="size-2.5" aria-hidden="true" />
        Run npm run dev
      </span>
    </div>
  );
}

export function PreviewScene() {
  const launchCue = useCue("launch");
  const menu = useCue("launch", 0.6);
  const opened = useCue("pickpreview", 0.3);
  const starting = useCue("start", 0.55);
  const running = useCue("start", 0.9);
  const live = useCue("live", 0.6);
  const consoleCue = useCue("console");
  const drawer = useCue("console", 0.6);
  const cursor = useMockCursor({ x: 420, y: 200 }, CURSOR);

  // The trigger, then what it produced: the launcher row, Run, the new search
  // box on the live page, the console button, then the logs it opened.
  const spot = drawer
    ? ["dev-logs"]
    : consoleCue
      ? ["dev-console"]
      : live
        ? ["dev-search"]
        : opened
          ? ["dev-run"]
          : menu
            ? ["menu-3"]
            : ["launcher"];

  return (
    <MockApp
      branch="add-search"
      focus={opened ? ["grid"] : ["toolbar", "grid"]}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" />
          <MockWorktreeCard name="fix-login-redirect" branch="fix-login-redirect" />
          <MockWorktreeCard name="add-search" branch="add-search" selected states={["working"]} />
        </>
      }
      grid={
        <MockGrid columns={opened ? 2 : 1}>
          <MockPane agent="claude" state="working">
            <MockStreamingLines cue="live" widths={[80, 56, 90, 64, 72, 48]} perSecond={3} />
          </MockPane>
          {opened && (
            <MockPanel
              icon={<MonitorPlay />}
              title="Dev Server"
              focused
              className="size-full"
              toolbar={
                <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-border-subtle px-2 text-text-secondary [&_svg]:size-2.5">
                  <ArrowLeft aria-hidden="true" />
                  <ArrowRight aria-hidden="true" />
                  <RotateCw aria-hidden="true" />
                  <span className="flex h-4 min-w-0 flex-1 items-center truncate rounded-sm bg-surface-input px-1.5 text-3xs text-text-secondary">
                    localhost:5173
                  </span>
                  <span data-tour-anchor="dev-console" className="inline-flex">
                    <SquareTerminal aria-hidden="true" />
                  </span>
                </div>
              }
            >
              {running ? <MockPage withSearch={live} /> : <StartPrompt starting={starting} />}
              <div
                data-tour-anchor="dev-logs"
                className={cn(
                  "absolute inset-x-0 bottom-0 flex h-[72px] flex-col border-t border-border-default bg-surface-panel",
                  reveal(drawer)
                )}
              >
                <div className="flex h-5 min-w-0 items-center gap-2 border-b border-border-subtle px-2 text-3xs">
                  <span className="font-medium text-text-primary">Output</span>
                  <span className="text-text-secondary">Console</span>
                  <span className="truncate text-text-secondary">Diagnostics</span>
                  <span className="flex-1" />
                  <span className="shrink-0 rounded-full border border-border-strong px-1.5 text-text-secondary">
                    Running
                  </span>
                </div>
                <div className="flex min-w-0 flex-col gap-0.5 p-1.5 font-mono text-3xs text-text-secondary [&>span]:truncate">
                  <span>VITE ready in 312 ms</span>
                  <span>➜ Local: localhost:5173</span>
                  <span>hmr update /Header.tsx</span>
                </div>
              </div>
            </MockPanel>
          )}
        </MockGrid>
      }
    >
      <MockMenu
        visible={menu && !opened}
        active={3}
        x={MENU.x}
        y={MENU.y}
        width={MENU.width}
        header={
          <MockSearchField>
            <span className="text-text-placeholder">Search agents, panels…</span>
          </MockSearchField>
        }
        items={[
          { icon: <SquareTerminal />, label: "Terminal" },
          { icon: <FolderTree />, label: "Browse files" },
          { icon: <Globe />, label: "Browser" },
          { icon: <MonitorPlay />, label: "Dev preview" },
        ]}
      />
      <MockSpotlight targets={spot} visible={launchCue && !(starting && !live)} />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
