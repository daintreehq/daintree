import {
  ArrowLeft,
  ArrowRight,
  ChevronUp,
  FolderTree,
  Globe,
  MonitorPlay,
  Play,
  RotateCw,
  Search,
  SquareTerminal,
} from "lucide-react";
import {
  cn,
  type CursorStep,
  MockCursor,
  MockMenu,
  MockPanel,
  MockSearchField,
  MockSpotlight,
  MockStreamingLines,
  useMockCursor,
} from "@daintreehq/tour/kit";
import {
  ANCHOR,
  MockApp,
  MockGrid,
  MockPane,
  MockStateGlyph,
  MockWorktreeCard,
} from "@daintreehq/tour/mock-app";
import { useCue } from "@daintreehq/tour/react";

const LAUNCHER = ANCHOR.launcher;
const MENU = { x: LAUNCHER.x - 8, y: LAUNCHER.y + 14, width: 164 };
// The menu's fourth row, Dev preview, on its label.
const DEV_PREVIEW_ITEM = { anchor: "menu-3", dx: -7 };
const RUN_BUTTON = { anchor: "dev-run" };
const DRAWER_TOGGLE = { anchor: "dev-drawer", dx: -20 };
const CONSOLE_TAB = { anchor: "dev-console-tab" };

export const CURSOR: readonly CursorStep[] = [
  { cue: "launch", at: { anchor: "launcher" } },
  { cue: "launch", offset: 0.5, at: { anchor: "launcher" }, click: true },
  { cue: "pickpreview", offset: -0.4, at: DEV_PREVIEW_ITEM },
  { cue: "pickpreview", offset: 0.1, at: DEV_PREVIEW_ITEM, click: true },
  { cue: "start", at: RUN_BUTTON },
  { cue: "start", offset: 0.5, at: RUN_BUTTON, click: true },
  { cue: "output", at: DRAWER_TOGGLE },
  { cue: "output", offset: 0.4, at: DRAWER_TOGGLE, click: true },
  // "console" is the chapter's last word, so the pointer is already there as it lands.
  { cue: "console", offset: -0.45, at: CONSOLE_TAB },
  { cue: "console", offset: 0.05, at: CONSOLE_TAB, click: true },
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
            "transition-[opacity,scale] duration-300 ease-out motion-reduce:scale-100",
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

/**
 * The drawer along the bottom of the preview, as the app draws it: a bar that
 * toggles it, the server's status, and once open the Output and Console tabs.
 */
function OutputDrawer({
  status,
  open,
  tab,
}: {
  status: string;
  open: boolean;
  tab: "output" | "console";
}) {
  return (
    <div className="absolute inset-x-0 bottom-0 flex flex-col border-t border-border-default bg-surface-panel">
      <div className="flex h-5 min-w-0 items-center text-3xs">
        <span
          data-tour-anchor="dev-drawer"
          className="flex min-w-0 flex-1 items-center gap-1 border-r border-border-subtle px-2 font-semibold text-text-primary"
        >
          <ChevronUp
            className={cn(
              "size-2.5 shrink-0 transition-transform duration-150 ease-out",
              open && "rotate-180"
            )}
            aria-hidden="true"
          />
          <span className="truncate">Output drawer</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 px-2 text-text-secondary">
          <span
            className={cn(
              "size-1.5 rounded-full",
              status === "Running"
                ? "bg-server-running"
                : status === "Starting"
                  ? "bg-server-starting"
                  : "bg-server-stopped"
            )}
          />
          {status}
        </span>
      </div>
      <div
        data-tour-anchor="dev-logs"
        className={cn(
          "flex flex-col overflow-hidden transition-[height] duration-200 ease-out",
          open ? "h-[64px]" : "h-0"
        )}
      >
        <div className="flex h-5 shrink-0 items-center gap-2 border-y border-border-subtle px-2 text-3xs">
          {(["output", "console"] as const).map((id) => (
            <span
              key={id}
              data-tour-anchor={id === "console" ? "dev-console-tab" : "dev-output-tab"}
              className={cn(
                "rounded-sm px-1",
                tab === id
                  ? "bg-overlay-selected font-medium text-text-primary"
                  : "text-text-secondary"
              )}
            >
              {id === "output" ? "Output" : "Console"}
            </span>
          ))}
          <span className="text-text-secondary">Diagnostics</span>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5 p-1.5 font-mono text-3xs text-text-secondary [&>span]:truncate">
          {tab === "output" ? (
            <>
              <span>VITE ready in 312 ms</span>
              <span>➜ Local: localhost:5173</span>
              <span>hmr update /Header.tsx</span>
            </>
          ) : (
            <>
              <span>[vite] connected.</span>
              <span>SearchBox mounted</span>
              <span>GET /api/search?q=shoe 200</span>
            </>
          )}
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
  const outputCue = useCue("output");
  const drawer = useCue("output", 0.5);
  const consoleCue = useCue("console", -0.45);
  const consoleTab = useCue("console", 0.15);
  const cursor = useMockCursor({ x: 420, y: 200 }, CURSOR);

  // The trigger, then what it produced: the launcher row, Run, the new search
  // box on the live page, the drawer's bar, the logs it opened, then Console.
  const spot = consoleTab
    ? ["dev-logs"]
    : consoleCue
      ? ["dev-console-tab"]
      : drawer
        ? ["dev-logs"]
        : outputCue
          ? ["dev-drawer"]
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
              title="Dev server"
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
                </div>
              }
            >
              {running ? <MockPage withSearch={live} /> : <StartPrompt starting={starting} />}
              <OutputDrawer
                status={running ? "Running" : starting ? "Starting" : "Stopped"}
                open={drawer}
                tab={consoleTab ? "console" : "output"}
              />
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
            <span className="text-text-secondary">Search agents, panels…</span>
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
