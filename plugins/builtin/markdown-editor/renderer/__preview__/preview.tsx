import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { FileViewerToolbar } from "@/components/FileViewer/FileViewerToolbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MarkdownEditorStatusBar } from "../MarkdownEditorStatusBar";
import { STATUS_BAR_FIXTURES, requireStatusBarFixture } from "./statusBarFixtures";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the Markdown editor's status strip.
 *
 * Reaching the interesting states in the real app means provoking a save
 * conflict, finding a file with mixed line endings, or catching the in-flight
 * frame of a write that finishes in milliseconds — none of which is a way to
 * look at a design deliberately. So this renders the real component against the
 * real theme tokens and the real `index.css`, under the real toolbar row it
 * sits beneath, at the widths a file panel actually gets.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=saved            which state to render
 *   ?width=900                panel width in CSS px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "900");
const fixture = requireStatusBarFixture(params.get("fixture") ?? "saved");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

/** A few lines of the buffer, so the strip is judged against what sits under it. */
const SAMPLE = `# Release plan

The agent writes this file while you read it. Three things have to be true
before the branch is cut:

- the changelog names every user-visible change
- \`npm run check\` is green on a clean tree
- the release notes link the migration guide
`;

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
            path="docs/releases/release-plan.md"
            copied={false}
            onCopy={() => {}}
          />
        </FileViewerToolbar.Root>
        <MarkdownEditorStatusBar {...fixture.props} onSave={() => {}} />
        {/* An empty file has an empty buffer: a capture showing 0 lines over a
            populated body would be a picture of a state that cannot happen. */}
        <pre
          data-preview-body
          className="flex-1 min-h-0 overflow-hidden m-0 px-3 py-2 font-mono text-sm text-text-primary whitespace-pre-wrap"
        >
          {fixture.props.lineCount === 0 ? "" : SAMPLE}
        </pre>
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

// Referenced so the fixture table is reachable from the console while reviewing.
Object.assign(window, { __STATUS_BAR_FIXTURES__: STATUS_BAR_FIXTURES });
