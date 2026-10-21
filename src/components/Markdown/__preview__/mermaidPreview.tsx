import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { FileViewerToolbar } from "@/components/FileViewer/FileViewerToolbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MarkdownViewer } from "../MarkdownViewer";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for a ```mermaid fence in each of its
 * states: waiting for the diagram, rendered, and shown as source because it
 * failed to parse or asked for something a diagram here may not load.
 *
 * The pending state only lasts as long as the Mermaid chunk takes to arrive,
 * so the spec holds that module request open to photograph it, then lets it
 * through to photograph the diagram in the same place.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?diagram=valid|broken|linked
 *   ?width=720                pane width in CSS px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const diagram = params.get("diagram") ?? "valid";
const width = Number(params.get("width") ?? "720");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const DIAGRAMS: Record<string, string> = {
  valid: [
    "graph LR",
    "  Push[git push] --> CI{CI green?}",
    "  CI -->|yes| Merge[Auto-merge]",
    "  CI -->|no| Fix[Agent fixes]",
    "  Fix --> Push",
  ].join("\n"),
  broken: [
    "graph LR",
    "  Push[git push] --> CI{CI green?",
    "  CI -->|yes| Merge[Auto-merge]",
    "  CI -->|no| Fix[Agent fixes]",
    "  Fix --> Push",
  ].join("\n"),
  linked: [
    "graph LR",
    "  Push[git push] --> CI{CI green?}",
    "  CI -->|yes| Merge[Auto-merge]",
    "  CI -->|no| Fix[Agent fixes]",
    '  click CI "https://github.com/daintreehq/daintree/actions"',
  ].join("\n"),
};

const DOCUMENT = [
  "## Release flow",
  "",
  "Every pull request runs the same pipeline. An agent picks up a red build on its own and pushes a fix to the same branch.",
  "",
  "```mermaid",
  DIAGRAMS[diagram] ?? DIAGRAMS.valid,
  "```",
  "",
  "Merges land on `develop`. A release branch is cut from there:",
  "",
  "```bash",
  "npm run release -- --minor",
  "```",
  "",
].join("\n");

function Preview() {
  return (
    <TooltipProvider>
      <div
        data-preview-shell
        className="flex flex-col bg-surface-canvas"
        style={{ width: `${width}px`, height: "100vh" }}
      >
        <FileViewerToolbar.Root label="File viewer controls">
          <FileViewerToolbar.Path path="docs/RELEASING.md" />
        </FileViewerToolbar.Root>
        <div data-preview-body className="flex-1 min-h-0 overflow-auto bg-surface-canvas">
          <MarkdownViewer
            content={DOCUMENT}
            filePath="/tmp/preview/docs/RELEASING.md"
            rootPath="/tmp/preview"
            viewMode="rendered"
          />
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
