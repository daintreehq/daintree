import { ArrowUp, Folders, History, Settings2 } from "lucide-react";
import {
  cn,
  type CursorStep,
  MockCursor,
  MockLines,
  MockMenu,
  MockSpotlight,
  MockTooltip,
  reveal,
  useMockCursor,
  useTourShortcuts,
} from "@daintreehq/tour/kit";
import { ANCHOR, MockApp, MockGrid, MockPane, MockWorktreeCard } from "@daintreehq/tour/mock-app";
import { useCue } from "@daintreehq/tour/react";

const COPY = ANCHOR["copy-context"];
const COPY_BUTTON = { anchor: "copy-context" };
// Copy context is a menu; its first item copies the whole worktree.
const MENU = { width: 176, x: COPY.x - 166, y: COPY.y + 14 };
const COPY_FULL = { anchor: "menu-0", dx: -28, dy: -3 };
// Wherever the person pastes it: an unbranded chat window over Daintree.
const CHAT = { x: 170, y: 60, width: 300, height: 220 };
const COMPOSER = { anchor: "chat-composer" };

export const CURSOR: readonly CursorStep[] = [
  { cue: "copy", at: COPY_BUTTON },
  { cue: "copy", offset: 0.5, at: COPY_BUTTON, click: true },
  { cue: "copy", offset: 1.0, at: COPY_FULL },
  { cue: "copy", offset: 1.5, at: COPY_FULL, click: true },
  { cue: "switch", offset: 0.6, at: COMPOSER },
  { cue: "paste", at: COMPOSER, click: true },
];

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

export function ContextScene() {
  const copyCue = useCue("copy");
  const menuOpen = useCue("copy", 0.6);
  const copied = useCue("copy", 1.6);
  const switchCue = useCue("switch");
  const pasted = useCue("paste", 0.3);
  const shortcuts = useTourShortcuts();
  const cursor = useMockCursor({ x: 420, y: 200 }, CURSOR);

  return (
    <MockApp
      branch="add-search"
      focus={switchCue ? [] : ["toolbar"]}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" />
          <MockWorktreeCard name="fix-login-redirect" branch="fix-login-redirect" />
          <MockWorktreeCard name="add-search" branch="add-search" selected states={["working"]} />
        </>
      }
      grid={
        <MockGrid columns={1}>
          <MockPane agent="claude" state="working">
            <MockLines widths={[74, 58, 86, 62, 80]} />
          </MockPane>
        </MockGrid>
      }
      overlay={<ChatWindow open={switchCue} pasted={pasted} />}
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
        visible={copied && !switchCue}
        x={COPY.x + 10}
        y={COPY.y + 14}
        align="right"
        title="Context copied"
        detail="Copied 42 files (186 KB) to clipboard"
      />
      <MockSpotlight
        targets={pasted ? ["chat-composer"] : menuOpen ? ["menu-0"] : ["copy-context"]}
        visible={(copyCue && !copied) || pasted}
      />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
