import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { FileViewerToolbar } from "@/components/FileViewer/FileViewerToolbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RenderedMarkdownDiff } from "@/components/Worktree/RenderedMarkdownDiff";
import { patchFrom } from "@/components/Worktree/__preview__/markdownDiffFixtures";
import { Markdown } from "@/pluginUi/Markdown";
import { MarkdownViewer } from "../MarkdownViewer";
import { PLUGIN_NOTES, PLUGIN_NOTES_EDITED, README, README_EDITED } from "./markdownTableFixtures";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for GFM tables in rendered Markdown.
 *
 * A wide table is a property of somebody's README, not a state the app can be
 * asked for, and the cases that decide the design — a table that fits beside
 * one that cannot, the same document in a narrow split and a maximized pane,
 * the table inside a changed diff block — would otherwise mean hunting for
 * repositories that happen to have them.
 *
 * So this renders the product's own components against the real theme tokens
 * and `index.css`: `MarkdownViewer` in a stand-in for the file pane's scroll
 * body, `RenderedMarkdownDiff` in the diff panel's, and the plugin kit's
 * `Markdown` in a plugin view's.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?surface=file|diff|diff-command|plugin
 *                             which consumer to render; diff-command is a
 *                             change deep inside a long code cell
 *   ?width=900                pane width in CSS px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const surface = params.get("surface") ?? "file";
const width = Number(params.get("width") ?? "900");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

function Body() {
  if (surface === "diff" || surface === "diff-command") {
    const [before, after] =
      surface === "diff" ? [README, README_EDITED] : [PLUGIN_NOTES, PLUGIN_NOTES_EDITED];
    return (
      <RenderedMarkdownDiff
        diff={patchFrom(before, after, "README.md")}
        newSource={after}
        status="modified"
        filePath="/tmp/preview/README.md"
        rootPath="/tmp/preview"
        attemptKey="preview"
      />
    );
  }
  if (surface === "plugin") {
    return (
      <div className="px-4 py-3">
        <Markdown source={PLUGIN_NOTES} align="start" />
      </div>
    );
  }
  return (
    <MarkdownViewer
      content={README}
      filePath="/tmp/preview/README.md"
      rootPath="/tmp/preview"
      viewMode="rendered"
    />
  );
}

function Preview() {
  return (
    <TooltipProvider>
      <div
        data-preview-shell
        className="flex flex-col bg-surface-canvas"
        style={{ width: `${width}px`, height: "100vh" }}
      >
        <FileViewerToolbar.Root label="File viewer controls">
          <FileViewerToolbar.Path
            path={
              surface === "plugin" || surface === "diff-command"
                ? "Release notes"
                : "daintree-plugin-cli/README.md"
            }
          />
        </FileViewerToolbar.Root>
        <div
          data-preview-body
          className={`flex-1 min-h-0 overflow-auto${surface.startsWith("diff") ? " diff-scroll-root" : ""}`}
        >
          <Body />
        </div>
      </div>
    </TooltipProvider>
  );
}

const host = document.getElementById("root");
if (!host) throw new Error("preview root missing");
createRoot(host).render(
  <StrictMode>
    <Preview />
  </StrictMode>
);
