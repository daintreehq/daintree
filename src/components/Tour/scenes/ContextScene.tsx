import { ArrowUp, Folders } from "lucide-react";
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
import { MockSpotlight } from "./sceneParts";

const COPY = ANCHOR["copy-context"];
const PORTAL = ANCHOR.portal;

const CURSOR: readonly CursorStep[] = [
  { cue: "copy", at: COPY },
  { cue: "copy", offset: 0.5, at: COPY, click: true },
  { cue: "paste", at: PORTAL },
  { cue: "paste", offset: 0.5, at: PORTAL, click: true },
];

/** The Portal: web chats in a side panel, here with the snapshot pasted in. */
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
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-2 p-2">
        <div
          className={cn(
            "self-end rounded-md border border-border-subtle bg-surface-inset p-1.5",
            reveal(pasted)
          )}
        >
          <div className="mb-1 flex items-center gap-1 text-3xs">
            <Folders className="size-2.5 text-text-secondary" aria-hidden="true" />
            <span className="font-medium text-text-primary">shop-app · 42 files</span>
          </div>
          <MockLines widths={[90, 70, 84, 60]} className="w-28" />
        </div>
      </div>
      <div className="shrink-0 p-1.5">
        <div className="flex h-6 items-center justify-between rounded-md border border-border-subtle bg-surface-input px-2 text-3xs text-text-placeholder">
          How should I restructure checkout?
          <ArrowUp className="size-2.5 text-text-secondary" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

export function ContextScene() {
  const copyCue = useCue("copy");
  const copied = useCue("copy", 0.6);
  const portalOpen = useCue("paste", 0.6);
  const pasted = useCue("portal");
  const cursor = useMockCursor({ x: 420, y: 200 }, CURSOR);

  return (
    <MockApp
      branch="add-search"
      focus={portalOpen ? ["right"] : ["toolbar"]}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" />
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
      <MockSpotlight targets={["copy-context"]} visible={copyCue && !copied} />
      <span
        className={cn(
          "absolute z-20 -translate-x-1/2 whitespace-nowrap rounded-md border border-border-strong bg-surface-panel-elevated px-2 py-1 text-3xs font-medium text-text-primary shadow-[var(--theme-shadow-ambient)]",
          reveal(copied && !portalOpen, "above")
        )}
        style={{ left: COPY.x - 30, top: COPY.y + 16 }}
      >
        Copied to clipboard · 42 files
      </span>
      <MockCursor {...cursor} visible={cursor.visible && !pasted} />
    </MockApp>
  );
}
