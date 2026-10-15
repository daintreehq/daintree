import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { parseDiff } from "react-diff-view";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UI_TOOLTIP_DELAY_DURATION, UI_TOOLTIP_SKIP_DELAY_DURATION } from "@/lib/animationUtils";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import { DiffViewer } from "../DiffViewer";
import { PendingFileNotes } from "../DiffNoteWidgets";
import {
  buildDiffLineIndex,
  hashLineRange,
  type DiffNote,
  type DiffNoteAnchor,
  type DiffNoteSide,
} from "../diffNotes";
import "@/index.css";

/**
 * Standalone visual-review harness for the inline review notes in the diff panel.
 *
 * Every placement a note can land in is a product of what the diff currently
 * renders: a note under its lines, a stale one whose lines now read differently,
 * one whose lines aren't on screen, and the pending list a file with no diff
 * table falls back to. Reaching all of them in the real app means writing notes
 * and then changing the file under them. Here the real `DiffViewer` and
 * `PendingFileNotes` render against the real notes store, seeded with notes whose
 * anchors are hashed from the fixture diff itself, so each placement is computed
 * by the product's own `placeDiffNote` rather than asserted by the harness.
 *
 * The composer and the editor are opened by the capture spec through the real
 * gutter click and Edit button.
 *
 * Query parameters:
 *   ?theme=<built-in theme id>
 *   ?scene=inline|detached|pending
 *   ?width=760   body width in CSS px
 *   ?platform=mac|win  how the editor's shortcut keys resolve
 *   ?view=split|unified the diff layout (split is the product default)
 */

installPreviewShims();

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const SCENES = ["inline", "detached", "pending"] as const;
type Scene = (typeof SCENES)[number];
const scene: Scene = SCENES.find((s) => s === params.get("scene")) ?? "inline";
const width = Number(params.get("width") ?? "760");
const platform = params.get("platform") ?? "mac";
const viewType = params.get("view") === "unified" ? "unified" : "split";
Object.defineProperty(navigator, "platform", {
  get: () => (platform === "mac" ? "MacIntel" : "Win32"),
});

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const WORKTREE = "/Users/avery/code/helios";
const FILE = "src/sync/retryQueue.ts";

const DIFF = `diff --git a/${FILE} b/${FILE}
index 41c2e07..9ad3f15 100644
--- a/${FILE}
+++ b/${FILE}
@@ -8,17 +8,21 @@ import { logger } from "../logger";
 export interface RetryOptions {
   maxAttempts: number;
   baseDelayMs: number;
+  jitter?: boolean;
 }

 export async function withRetry<T>(task: () => Promise<T>, options: RetryOptions): Promise<T> {
   let attempt = 0;
-  while (true) {
+  while (attempt < options.maxAttempts) {
     try {
       return await task();
     } catch (error) {
       attempt += 1;
-      if (attempt >= options.maxAttempts) throw error;
-      await sleep(options.baseDelayMs * attempt);
+      const delay = options.baseDelayMs * 2 ** attempt;
+      const spread = options.jitter ? Math.random() * delay : 0;
+      logger.warn("retrying", { attempt, delay: delay + spread });
+      await sleep(delay + spread);
     }
   }
+  throw new Error("retry budget exhausted");
 }
`;

const index = buildDiffLineIndex(parseDiff(DIFF)[0]!.hunks);

function lines(side: DiffNoteSide, startLine: number, endLine = startLine): DiffNoteAnchor {
  const contentHash = hashLineRange(index, side, startLine, endLine);
  if (contentHash === null) throw new Error(`lines ${startLine}-${endLine} are not in the fixture`);
  return { kind: "lines", side, startLine, endLine, contentHash };
}

/** An anchor written against text the diff no longer shows, so it reads as stale. */
function moved(side: DiffNoteSide, startLine: number, endLine = startLine): DiffNoteAnchor {
  return { ...lines(side, startLine, endLine), contentHash: "0badf00d" };
}

/** An anchor on lines the diff doesn't render at all. */
function offscreen(startLine: number, endLine = startLine): DiffNoteAnchor {
  return { kind: "lines", side: "new", startLine, endLine, contentHash: "5ca1ab1e" };
}

const NOW = Date.now();
let seq = 0;
function note(anchor: DiffNoteAnchor, body: string, filePath = FILE): DiffNote {
  seq += 1;
  return {
    id: `preview-note-${seq}`,
    worktreePath: WORKTREE,
    filePath,
    anchor,
    body,
    createdAt: NOW - seq * 60_000,
    updatedAt: NOW - seq * 60_000,
  };
}

const SCENE_NOTES: Record<Scene, DiffNote[]> = {
  inline: [
    note(lines("new", 11), "Default this to true; every caller I checked wants jitter."),
    note(
      lines("new", 21, 24),
      "Exponent starts at 2 on the first retry, so the first wait is already 4× the base. " +
        "Use attempt - 1, and cap the delay so a long budget can't sleep for minutes."
    ),
  ],
  detached: [
    note({ kind: "file" }, "Add a unit test for the exhausted-budget path before this ships."),
    note(moved("new", 16), "Keep the infinite loop here; the caller owns cancellation."),
    note(offscreen(48, 52), "This cleanup can go once withRetry throws on its own."),
    note(lines("new", 27), "Include the last error as the cause."),
  ],
  pending: [
    note({ kind: "file" }, "Add a unit test for the exhausted-budget path before this ships."),
    note(lines("new", 11), "Default this to true; every caller I checked wants jitter."),
    note(lines("new", 21, 24), "Cap the delay so a long budget can't sleep for minutes."),
  ],
};

useDiffNotesStore.setState({
  notes: Object.fromEntries(SCENE_NOTES[scene].map((n) => [n.id, n])),
  editingIds: {},
});

function Preview() {
  return (
    <div
      data-preview-ready={scene}
      className="bg-surface-panel text-text-primary"
      style={{ width, minHeight: "100vh" }}
    >
      {scene === "pending" ? (
        // The diff pane's fallback for a file with no table to hang notes on
        // (rendered Markdown, binary, an empty diff): the list sits above the
        // body, which here is a stand-in for the rendered document.
        <div data-preview-pending="">
          <PendingFileNotes worktreePath={WORKTREE} filePath={FILE} />
          <div className="px-4 py-3 text-sm text-text-secondary">
            Rendered preview of {FILE.split("/").pop()}
          </div>
        </div>
      ) : (
        <DiffViewer
          diff={DIFF}
          viewType={viewType}
          rootPath={WORKTREE}
          annotations={{ worktreePath: WORKTREE }}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider
      delayDuration={UI_TOOLTIP_DELAY_DURATION}
      skipDelayDuration={UI_TOOLTIP_SKIP_DELAY_DURATION}
    >
      <Preview />
    </TooltipProvider>
  </StrictMode>
);
