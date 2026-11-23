import {
  ArrowUp,
  ChevronDown,
  FileCode,
  FileText,
  Folder,
  Folders,
  FolderTree,
  History,
  Settings2,
  X,
} from "lucide-react";
import {
  cn,
  type CursorStep,
  MockCursor,
  MockLines,
  MockMenu,
  MockPanel,
  MockSpotlight,
  MockTooltip,
  reveal,
  useMockCursor,
  useTourShortcuts,
} from "@daintreehq/tour/kit";
import { ANCHOR, MockApp, MockGrid, MockPane, MockWorktreeCard } from "@daintreehq/tour/mock-app";
import { useCue } from "@daintreehq/tour/react";

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
const PICKED_ROW = { anchor: `tree-${TREE[PICKED]!.name}`, dx: -20, dy: -4 };
const CLAUDE_INPUT = { anchor: "claude-input", dy: 6 };
const CLAUDE_BODY = { anchor: "claude-body", dy: -32 };
const DRAGGING = "Header.tsx";

const COPY = ANCHOR["copy-context"];
const COPY_BUTTON = { anchor: "copy-context" };
// Copy context is a menu; its first item copies the whole worktree.
const MENU = { width: 176, x: COPY.x - 166, y: COPY.y + 14 };
const COPY_FULL = { anchor: "menu-0", dx: -28, dy: -3 };
// Wherever the person pastes it: an unbranded chat window over Daintree.
const CHAT = { x: 170, y: 60, width: 300, height: 220 };
const COMPOSER = { anchor: "chat-composer" };

export const CURSOR: readonly CursorStep[] = [
  { cue: "open", at: { anchor: "file-browser" } },
  { cue: "open", offset: 0.5, at: { anchor: "file-browser" }, click: true },
  { cue: "pick", at: PICKED_ROW },
  { cue: "pick", offset: 0.5, at: PICKED_ROW, click: true },
  // Press on the file, carry it across Claude's terminal, and let go on the
  // prompt bar as the voice says "drops".
  { cue: "ref", at: PICKED_ROW },
  { cue: "ref", offset: 0.3, at: PICKED_ROW, modifier: DRAGGING },
  { cue: "ref", offset: 0.8, at: CLAUDE_BODY, modifier: DRAGGING },
  { cue: "drop", offset: -0.2, at: CLAUDE_INPUT, modifier: DRAGGING },
  { cue: "drop", offset: 0.5, at: CLAUDE_INPUT, click: true },
  { cue: "copy", at: COPY_BUTTON },
  { cue: "copy", offset: 0.5, at: COPY_BUTTON, click: true },
  { cue: "full", at: COPY_FULL },
  { cue: "full", offset: 0.5, at: COPY_FULL, click: true },
  { cue: "clipboard", offset: 0.8, at: COMPOSER },
  { cue: "paste", at: COMPOSER, click: true },
];

function FileBrowser({ picked, lifted }: { picked: boolean; lifted: boolean }) {
  return (
    <MockPanel icon={<FolderTree />} title="Files — add-search" focused className="size-full">
      <div className="flex size-full">
        <div className="flex w-[120px] shrink-0 flex-col gap-px border-r border-border-subtle p-1.5">
          {TREE.map((row, i) => (
            <span
              key={row.name}
              data-tour-anchor={`tree-${row.name}`}
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

/** Another app's chat window, the pasted worktree waiting in its composer as an attachment. */
function ChatWindow({ open, pasted }: { open: boolean; pasted: boolean }) {
  return (
    <div
      className={cn(
        "absolute z-20 flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-dialog shadow-[var(--theme-shadow-ambient)]",
        reveal(open)
      )}
      style={{ left: CHAT.x, top: CHAT.y, width: CHAT.width, height: CHAT.height }}
    >
      <div className="relative flex h-6 shrink-0 items-center gap-1 border-b border-border-subtle px-2">
        {[0, 1, 2].map((dot) => (
          <span key={dot} className="size-1.5 rounded-full bg-overlay-strong" />
        ))}
        <span className="absolute inset-x-0 text-center text-3xs text-text-secondary">
          New chat
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 p-2">
        <span className="h-2 w-24 rounded-full bg-overlay-strong" />
        <span className="h-1.5 w-36 rounded-full bg-overlay-medium" />
      </div>
      <div className="shrink-0 p-2">
        <div
          data-tour-anchor="chat-composer"
          className="flex flex-col gap-1.5 rounded-md border border-border-subtle bg-surface-input p-1.5"
        >
          <span
            className={cn(
              "inline-flex w-fit items-center gap-1 rounded-sm bg-overlay-subtle px-1.5 py-0.5 text-3xs text-text-primary",
              reveal(pasted, "none")
            )}
          >
            <Folders className="size-2.5 text-text-secondary" aria-hidden="true" />
            add-search · 42 files
          </span>
          <span className="flex items-center justify-between text-3xs text-text-secondary">
            Ask anything
            <ArrowUp className="size-2.5 text-text-secondary" aria-hidden="true" />
          </span>
        </div>
      </div>
    </div>
  );
}

export function FilesScene() {
  const browseCue = useCue("open");
  const opened = useCue("open", 0.6);
  const picked = useCue("pick", 0.6);
  const lifted = useCue("ref", 0.3);
  const hovering = useCue("drop", -0.2);
  const dropped = useCue("drop", 0.5);
  const copyCue = useCue("copy");
  const menuOpen = useCue("copy", 0.6);
  const copied = useCue("full", 0.6);
  const clipboard = useCue("clipboard");
  const chatOpen = useCue("clipboard", 0.6);
  const pasted = useCue("paste", 0.3);
  const shortcuts = useTourShortcuts();
  const cursor = useMockCursor({ x: 360, y: 200 }, CURSOR);

  const spotlight = pasted
    ? ["chat-composer"]
    : clipboard
      ? ["copy-context"]
      : menuOpen
        ? ["menu-0"]
        : copyCue
          ? ["copy-context"]
          : dropped
            ? ["claude-input"]
            : ["file-browser"];

  return (
    <MockApp
      branch="add-search"
      focus={chatOpen ? [] : copyCue ? ["toolbar"] : opened ? ["grid"] : ["toolbar"]}
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
      overlay={<ChatWindow open={chatOpen} pasted={pasted} />}
    >
      <MockMenu
        visible={menuOpen && !copied}
        active={0}
        x={MENU.x}
        y={MENU.y}
        width={MENU.width}
        items={[
          {
            icon: <Folders />,
            label: "Copy full context",
            hint: shortcuts.hint("worktree.copyTree"),
          },
          { icon: <History />, label: "Recent", muted: true },
          { icon: <Settings2 />, label: "Context settings", muted: true, separator: true },
        ]}
      />
      <MockTooltip
        visible={copied && !chatOpen}
        x={COPY.x + 10}
        y={COPY.y + 14}
        align="right"
        title="Context copied"
        detail="Copied 42 files (186 KB) to clipboard"
      />
      <MockSpotlight
        targets={spotlight}
        visible={
          (browseCue && !opened) ||
          (dropped && !copyCue) ||
          (copyCue && !copied) ||
          (clipboard && !chatOpen) ||
          pasted
        }
      />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
