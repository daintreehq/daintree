import { ArrowUp, Folders, History, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ANCHOR, MockApp, MockGrid, MockWorktreeCard } from "../mockup/MockApp";
import {
  MockCursor,
  MockLines,
  MockPane,
  reveal,
  useMockCursor,
  type CursorStep,
} from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";
import { MockMenu, MockSpotlight, MockTooltip } from "./sceneParts";

const COPY = ANCHOR["copy-context"];
const PORTAL = ANCHOR.portal;
// Copy context is a menu; its first item copies the whole worktree.
const MENU = { width: 176, x: COPY.x - 166, y: COPY.y + 14 };
const COPY_FULL = { x: MENU.x + 60, y: MENU.y + 13 };

const CURSOR: readonly CursorStep[] = [
  { cue: "copy", at: COPY },
  { cue: "copy", offset: 0.5, at: COPY, click: true },
  { cue: "copy", offset: 1.0, at: COPY_FULL },
  { cue: "copy", offset: 1.5, at: COPY_FULL, click: true },
  { cue: "portal", at: PORTAL },
  { cue: "portal", offset: 0.5, at: PORTAL, click: true },
];

/** The Portal: web chats in a side panel, the pasted worktree waiting as an attachment. */
function PortalPanel({ pasted }: { pasted: boolean }) {
  return (
    <div className="flex size-full flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border-subtle px-1.5 text-3xs">
        {["Claude", "ChatGPT", "Gemini"].map((site, i) => (
          <span
            key={site}
            className={cn(
              "rounded-sm px-1.5 py-0.5",
              i === 0 ? "bg-overlay-selected text-text-primary" : "text-text-secondary"
            )}
          >
            {site}
          </span>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 p-2">
        <span className="h-2 w-20 rounded-full bg-overlay-strong" />
        <span className="h-1.5 w-28 rounded-full bg-overlay-medium" />
      </div>
      <div className="shrink-0 p-1.5">
        <div
          data-tour-anchor="portal-composer"
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
  const portalCue = useCue("portal");
  const portalOpen = useCue("portal", 0.6);
  const pasted = useCue("paste", 0.3);
  const cursor = useMockCursor({ x: 420, y: 200 }, CURSOR);

  return (
    <MockApp
      branch="add-search"
      focus={portalOpen ? ["right"] : ["toolbar"]}
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
      rightPanel={portalOpen ? <PortalPanel pasted={pasted} /> : undefined}
    >
      <MockMenu
        visible={menuOpen && !copied}
        active={0}
        x={MENU.x}
        y={MENU.y}
        width={MENU.width}
        items={[
          { icon: <Folders />, label: "Copy full context", hint: "⌘⇧C" },
          { icon: <History />, label: "Recent", muted: true },
          { icon: <Settings2 />, label: "Context settings", muted: true, separator: true },
        ]}
      />
      <MockTooltip
        visible={copied && !portalCue}
        x={COPY.x + 10}
        y={COPY.y + 14}
        align="right"
        title="Context copied"
        detail="Copied 42 files (186 KB) to clipboard"
      />
      <MockSpotlight
        targets={
          pasted
            ? ["portal-composer"]
            : portalCue
              ? ["portal"]
              : menuOpen
                ? ["menu-0"]
                : ["copy-context"]
        }
        visible={(copyCue && !copied) || (portalCue && !portalOpen) || pasted}
      />
      <MockCursor {...cursor} visible={cursor.visible && !portalOpen} />
    </MockApp>
  );
}
