import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { File, Folder } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import {
  PANE_STATUS_FOOTER_CLASS,
  PANE_TOOLBAR_TEXT_BUTTON_CLASS,
} from "@/components/ui/paneToolbarStyles";
import { cn } from "@/lib/utils";
import { FileBrowserHiddenStrip } from "../FileBrowserHiddenStrip";
import {
  FILE_BROWSER_SIDEBAR_DEFAULT_WIDTH,
  FILE_BROWSER_SIDEBAR_MIN_WIDTH,
} from "../sidebarWidth";
import "@/index.css";

/**
 * Standalone visual-review harness for the file browser's "N dotfiles hidden"
 * strip. Each frame is the bottom of a tree column — a few stand-in rows, then
 * the REAL strip — at the sidebar's minimum and default widths. The last frame
 * is the image viewer's footer with its "Fit to screen" text button, the
 * reference for a word-labelled action living in a pane status footer.
 *
 * The spec drives hover and keyboard focus itself; every frame carries
 * `data-shot`.
 *
 * Query parameters:
 *   ?theme=<built-in theme id>
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const ROWS: Array<{ name: string; dir?: boolean; depth?: number }> = [
  { name: "src", dir: true },
  { name: "components", dir: true, depth: 1 },
  { name: "index.ts", depth: 1 },
  { name: "package.json" },
  { name: "README.md" },
];

const noop = () => {};

function TreeStandIn() {
  return (
    <div className="flex-1 py-1">
      {ROWS.map((row) => (
        <div key={row.name} className="h-6 w-full px-1">
          <div
            className="flex h-full items-center gap-1.5 rounded-[var(--radius-md)] px-2 text-xs text-text-secondary"
            style={{ paddingLeft: 8 + (row.depth ?? 0) * 12 }}
          >
            {row.dir ? (
              <Folder className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <File className="size-3.5 shrink-0" aria-hidden />
            )}
            <span className="truncate">{row.name}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Column({ shot, width, dotfiles }: { shot: string; width: number; dotfiles: number }) {
  return (
    <div
      data-shot={shot}
      className="flex h-[200px] flex-col border border-divider bg-surface-sidebar"
      style={{ width }}
    >
      <TreeStandIn />
      <FileBrowserHiddenStrip counts={{ dotfiles, alwaysHidden: 3 }} onShowDotfiles={noop} />
    </div>
  );
}

function Preview() {
  return (
    <div className="flex flex-wrap items-start gap-6 p-6">
      <Column shot="min-one" width={FILE_BROWSER_SIDEBAR_MIN_WIDTH} dotfiles={1} />
      <Column shot="default-many" width={FILE_BROWSER_SIDEBAR_DEFAULT_WIDTH} dotfiles={12} />
      <Column shot="default-hover" width={FILE_BROWSER_SIDEBAR_DEFAULT_WIDTH} dotfiles={12} />
      <Column shot="default-focus" width={FILE_BROWSER_SIDEBAR_DEFAULT_WIDTH} dotfiles={12} />
      <div
        data-shot="reference-image-footer"
        className="flex flex-col border border-divider bg-surface-panel"
        style={{ width: 420 }}
      >
        <div className="h-24" />
        <div className={cn(PANE_STATUS_FOOTER_CLASS, "justify-between py-0")}>
          <span className="tabular-nums">1600 × 900 · 64%</span>
          <button type="button" className={PANE_TOOLBAR_TEXT_BUTTON_CLASS}>
            Fit to screen
          </button>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>
);
document.body.dataset.ready = "1";
