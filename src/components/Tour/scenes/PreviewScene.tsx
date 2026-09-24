import {
  ArrowLeft,
  ArrowRight,
  FolderTree,
  MonitorPlay,
  RotateCw,
  Search,
  SquareTerminal,
} from "lucide-react";
import { ClaudeIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { ANCHOR, MockApp, MockGrid, MockWorktreeCard } from "../mockup/MockApp";
import {
  MockCursor,
  MockPane,
  MockStreamingLines,
  MockStateGlyph,
  reveal,
  useMockCursor,
  type CursorStep,
} from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";
import { MockMenu, MockPanel, MockSearchField } from "./sceneParts";

const LAUNCHER = ANCHOR.launcher;
const MENU = { x: LAUNCHER.x - 8, y: LAUNCHER.y + 14, width: 150 };
const DEV_PREVIEW_ITEM = { x: MENU.x + 60, y: MENU.y + 88 };

const CURSOR: readonly CursorStep[] = [
  { cue: "launch", at: LAUNCHER },
  { cue: "launch", offset: 0.5, at: LAUNCHER, click: true },
  { cue: "launch", offset: 1.0, at: DEV_PREVIEW_ITEM },
  { cue: "launch", offset: 1.5, at: DEV_PREVIEW_ITEM, click: true },
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
        <span className="h-1.5 w-6 rounded-full bg-overlay-strong" />
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <span className="h-3 w-32 rounded-full bg-overlay-strong" />
        <span className="h-1.5 w-44 rounded-full bg-overlay-medium" />
        <div className="mt-1 grid flex-1 grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <span key={i} className="rounded-md bg-overlay-medium" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function PreviewScene() {
  const menu = useCue("launch", 0.6);
  const opened = useCue("launch", 1.6);
  const running = useCue("start", 1.2);
  const live = useCue("live", 0.6);
  const drawer = useCue("console");
  const cursor = useMockCursor({ x: 420, y: 200 }, CURSOR);

  return (
    <MockApp
      branch={"add-search"}
      focus={opened ? ["grid"] : ["toolbar", "grid"]}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" />
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
              title="Dev preview"
              focused
              className="size-full"
              toolbar={
                <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-border-subtle px-2 text-text-secondary [&_svg]:size-2.5">
                  <ArrowLeft aria-hidden="true" />
                  <ArrowRight aria-hidden="true" />
                  <RotateCw aria-hidden="true" />
                  <span className="flex h-4 flex-1 items-center rounded-sm bg-surface-input px-1.5 text-3xs text-text-secondary">
                    localhost:5173
                  </span>
                  <SquareTerminal aria-hidden="true" />
                </div>
              }
            >
              {running ? (
                <MockPage withSearch={live} />
              ) : (
                <div className="flex size-full flex-col items-center justify-center gap-1.5">
                  <MockStateGlyph state="working" />
                  <span className="text-3xs font-medium text-text-primary">
                    Starting dev server
                  </span>
                  <span className="rounded-sm bg-surface-input px-1.5 py-px font-mono text-3xs text-text-secondary">
                    npm run dev
                  </span>
                </div>
              )}
              <div
                className={cn(
                  "absolute inset-x-0 bottom-0 flex h-[74px] flex-col border-t border-border-default bg-surface-panel",
                  reveal(drawer)
                )}
              >
                <div className="flex h-5 items-center gap-3 border-b border-border-subtle px-2 text-3xs">
                  <span className="font-medium text-text-primary">Output</span>
                  <span className="text-text-secondary">Console</span>
                  <span className="text-text-secondary">Diagnostics</span>
                  <span className="flex-1" />
                  <span className="rounded-full border border-border-strong px-1.5 text-text-secondary">
                    Running
                  </span>
                </div>
                <div className="flex flex-col gap-0.5 p-1.5 font-mono text-3xs text-text-secondary">
                  <span>VITE v8 ready in 312 ms</span>
                  <span>➜ Local: http://localhost:5173/</span>
                  <span>page reload src/components/Header.tsx</span>
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
          { icon: <ClaudeIcon />, label: "Claude" },
          { icon: <SquareTerminal />, label: "Terminal" },
          { icon: <FolderTree />, label: "Browse files" },
          { icon: <MonitorPlay />, label: "Dev preview" },
        ]}
      />
      <MockCursor {...cursor} visible={cursor.visible && !opened} />
    </MockApp>
  );
}
