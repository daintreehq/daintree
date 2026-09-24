import { ChevronDown, FileCode, FileText, Folder, FolderTree } from "lucide-react";
import { cn } from "@/lib/utils";
import { ANCHOR, GRID_RECT, MockApp, MockGrid, MockWorktreeCard } from "../mockup/MockApp";
import {
  MockCursor,
  MockLines,
  MockPane,
  useMockCursor,
  type CursorStep,
} from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";
import { MockPanel } from "./sceneParts";

const TREE: ReadonlyArray<{ name: string; depth: number; folder?: boolean }> = [
  { name: "src", depth: 0, folder: true },
  { name: "components", depth: 1, folder: true },
  { name: "Header.tsx", depth: 2 },
  { name: "SearchBox.tsx", depth: 2 },
  { name: "App.tsx", depth: 1 },
  { name: "README.md", depth: 0 },
];
const PICKED = 2;
const PICKED_PATH = "src/components/Header.tsx";

// Once the file browser opens, the grid holds two equal columns — the real
// grid's reflow — with the browser on the left and Claude on the right.
const COLUMN = (GRID_RECT.width - 6) / 2;
const rowAt = (i: number) => ({ x: GRID_RECT.x + 40, y: GRID_RECT.y + 34 + i * 16 });
const CLAUDE_INPUT = {
  x: GRID_RECT.x + COLUMN + 6 + COLUMN / 2,
  y: GRID_RECT.y + GRID_RECT.height - 11,
};
const DRAGGING = "Header.tsx";

const CURSOR: readonly CursorStep[] = [
  { cue: "open", at: ANCHOR["file-browser"] },
  { cue: "open", offset: 0.5, at: ANCHOR["file-browser"], click: true },
  { cue: "pick", at: rowAt(PICKED) },
  { cue: "pick", offset: 0.5, at: rowAt(PICKED), click: true },
  // Press on the file, carry it across, and let go over Claude's panel.
  { cue: "ref", at: rowAt(PICKED) },
  { cue: "ref", offset: 0.4, at: rowAt(PICKED), modifier: DRAGGING },
  { cue: "ref", offset: 0.5, at: CLAUDE_INPUT, modifier: DRAGGING },
  { cue: "ref", offset: 1.2, at: CLAUDE_INPUT, click: true },
];

function FileBrowser({ picked }: { picked: boolean }) {
  return (
    <MockPanel icon={<FolderTree />} title="Files · add-search" focused className="size-full">
      <div className="flex size-full">
        <div className="flex w-[104px] shrink-0 flex-col gap-px border-r border-border-subtle p-1.5">
          {TREE.map((row, i) => (
            <span
              key={row.name}
              className={cn(
                "flex h-[15px] items-center gap-1 rounded-sm px-1 text-3xs transition-colors duration-150 ease-out",
                i === PICKED && picked
                  ? "bg-overlay-selected text-text-primary"
                  : "text-text-secondary"
              )}
              style={{ paddingLeft: 4 + row.depth * 8 }}
            >
              {row.folder ? (
                <>
                  <ChevronDown className="size-2.5" aria-hidden="true" />
                  <Folder className="size-2.5" aria-hidden="true" />
                </>
              ) : (
                <FileCode className="size-2.5" aria-hidden="true" />
              )}
              {row.name}
            </span>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2 p-2">
          <span className="flex h-3 items-center gap-1 text-3xs text-text-secondary">
            <FileText className="size-2.5" aria-hidden="true" />
            {picked ? "Header.tsx" : ""}
          </span>
          {picked ? (
            <MockLines widths={[60, 82, 74, 40, 88, 66, 52, 78]} />
          ) : (
            <span className="m-auto text-3xs text-text-secondary">Pick a file to read</span>
          )}
        </div>
      </div>
    </MockPanel>
  );
}

export function FilesScene() {
  const opened = useCue("open", 0.6);
  const picked = useCue("pick", 0.6);
  const dropped = useCue("ref", 1.2);
  const cursor = useMockCursor({ x: 360, y: 200 }, CURSOR);

  return (
    <MockApp
      branch="add-search"
      focus={["toolbar", "grid"]}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" />
          <MockWorktreeCard name="add-search" branch="add-search" selected states={["waiting"]} />
        </>
      }
      grid={
        <MockGrid columns={opened ? 2 : 1}>
          {opened && <FileBrowser picked={picked} />}
          <MockPane
            agent="claude"
            state="waiting"
            focused={dropped}
            input={dropped ? <span className="text-text-primary">{PICKED_PATH}</span> : null}
          >
            <MockLines widths={[80, 56, 90, 64]} />
          </MockPane>
        </MockGrid>
      }
    >
      <MockCursor {...cursor} />
    </MockApp>
  );
}
