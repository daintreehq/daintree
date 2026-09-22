import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { FileViewerToolbar } from "@/components/FileViewer/FileViewerToolbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FileEditorHintBar } from "../FileEditorHintBar";
import { requireHintBarFixture } from "./hintBarFixtures";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the file panel's editing hint bar.
 *
 * The bar only appears when a plugin claims the open file's extension, and the
 * interesting half of it only appears when that plugin happens to be disabled —
 * so reaching both states in the real app means toggling Preferences between
 * screenshots. This renders the presentational component directly, against the
 * real theme tokens and the real `index.css`, in the place it actually sits:
 * under the file viewer's toolbar and above the document.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=ready            which state to render
 *   ?width=900                panel width in CSS px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "900");
const fixture = requireHintBarFixture(params.get("fixture") ?? "ready");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

/** Enough of the document to judge how much room the bar is taking from it. */
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
            onCopy={() => undefined}
          />
        </FileViewerToolbar.Root>
        <div data-hint-bar-slot>
          <FileEditorHintBar {...fixture} onAction={() => undefined} onDismiss={() => undefined} />
        </div>
        <pre className="m-0 overflow-hidden px-3 py-2 text-xs leading-5 text-text-secondary">
          {SAMPLE}
        </pre>
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>
);
