import { ChevronDown, FileCode, FileText, Folder, FolderTree, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ANCHOR, GRID_RECT, MockApp, MockGrid, MockWorktreeCard } from "../mockup/MockApp";
import {
  MockCursor,
  MockLines,
  MockPane,
  useMockCursor,
  type CursorStep,
} from "../mockup/TourMock";
import { useCue } from "@daintreehq/tour/react";
import { MockPanel, MockSpotlight } from "./sceneParts";

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
const CLAUDE_BODY = { x: CLAUDE_INPUT.x, y: GRID_RECT.y + 110 };
const DRAGGING = "Header.tsx";

const CURSOR: readonly CursorStep[] = [
  { cue: "open", at: ANCHOR["file-browser"] },
  { cue: "open", offset: 0.5, at: ANCHOR["file-browser"], click: true },
  { cue: "pick", at: rowAt(PICKED) },
  { cue: "pick", offset: 0.5, at: rowAt(PICKED), click: true },
  // Press on the file, carry it across Claude's terminal, and let go on the
  // prompt bar exactly as the voice says "drops".
  { cue: "ref", at: rowAt(PICKED) },
  { cue: "ref", offset: 0.3, at: rowAt(PICKED), modifier: DRAGGING },
  { cue: "ref", offset: 0.8, at: CLAUDE_BODY, modifier: DRAGGING },
  { cue: "drop", offset: -0.5, at: CLAUDE_INPUT, modifier: DRAGGING },
  { cue: "drop", at: CLAUDE_INPUT, click: true },
];

function FileBrowser({ picked, lifted }: { picked: boolean; lifted: boolean }) {
  return (
    <MockPanel icon={<FolderTree />} title="Files — add-search" focused className="size-full">
      <div className="flex size-full">
        <div className="flex w-[120px] shrink-0 flex-col gap-px border-r border-border-subtle p-1.5">
          {TREE.map((row, i) => (
            <span
              key={row.name}
              className={cn(
                "flex h-[15px] items-center gap-1 rounded-sm px-1 text-3xs transition-colors duration-150 ease-out",
                i === PICKED && picked
                  ? "bg-overlay-selected text-text-primary"
                  : "text-text-secondary",
                // The row being dragged reads as lifted.
                i === PICKED && lifted && "opacity-60"
              )}
              style={{ paddingLeft: 4 + row.depth * 8 }}
            >
              {row.folder ? (
                <>
                  <ChevronDown className="size-2.5 shrink-0" aria-hidden="true" />
                  <Folder className="size-2.5 shrink-0" aria-hidden="true" />
                </>
              ) : (
                <FileCode className="size-2.5 shrink-0" aria-hidden="true" />
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
  const browseCue = useCue("open");
  const opened = useCue("open", 0.6);
  const picked = useCue("pick", 0.6);
  const lifted = useCue("ref", 0.3);
  const hovering = useCue("drop", -0.5);
  const dropped = useCue("drop");
  const cursor = useMockCursor({ x: 360, y: 200 }, CURSOR);

  return (
    <MockApp
      branch="add-search"
      focus={opened ? ["grid"] : ["toolbar"]}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" />
          <MockWorktreeCard name="fix-login-redirect" branch="fix-login-redirect" />
          <MockWorktreeCard name="add-search" branch="add-search" selected states={["waiting"]} />
        </>
      }
      grid={
        <MockGrid columns={opened ? 2 : 1}>
          {opened && <FileBrowser picked={picked} lifted={lifted && !dropped} />}
          <MockPane
            agent="claude"
            state="waiting"
            focused={dropped}
            dragOver={hovering && !dropped}
            input={
              dropped ? (
                // The real drop inserts a file chip, not the raw path.
                <span
                  title={PICKED_PATH}
                  className="inline-flex items-center gap-1 rounded-sm bg-overlay-subtle px-1 text-text-primary"
                >
                  <FileText className="size-2.5 text-text-secondary" aria-hidden="true" />
                  Header.tsx
                  <X className="size-2 text-text-secondary" aria-hidden="true" />
                </span>
              ) : null
            }
          >
            <MockLines widths={[80, 56, 90, 64]} />
          </MockPane>
        </MockGrid>
      }
    >
      <MockSpotlight
        targets={dropped ? ["claude-input"] : ["file-browser"]}
        visible={(browseCue && !opened) || dropped}
      />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
