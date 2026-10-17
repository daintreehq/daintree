import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { FileViewerToolbar } from "@/components/FileViewer/FileViewerToolbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MARKDOWN_FONT_SIZE_STEPS } from "@/store/preferencesStore";
import { MarkdownViewer } from "../MarkdownViewer";
import { PLUGIN_NOTES, README } from "./markdownTableFixtures";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the swap from `MarkdownViewer`'s loading
 * placeholder to the rendered document.
 *
 * The placeholder only exists while the lazy document chunk is in flight, which
 * in the app is the first rendered open of a session and then never again. So
 * this entry imports nothing that pulls `MarkdownDocument` in statically — the
 * tables preview does, through the diff and plugin-kit consumers — and the spec
 * holds that one module request open to photograph the placeholder, then lets it
 * through to photograph what replaced it in the same box.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?doc=readme|notes         heading-first or paragraph-first document
 *   ?width=720                pane width in CSS px
 *   ?size=sm|base|lg|…        reading text-size rung (absent = the CSS fallback)
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const doc = params.get("doc") ?? "readme";
const width = Number(params.get("width") ?? "720");
const sizeParam = params.get("size");
const size = MARKDOWN_FONT_SIZE_STEPS.find((step) => step === sizeParam);

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

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
            path={doc === "notes" ? "docs/RELEASING.md" : "daintree-plugin-cli/README.md"}
          />
        </FileViewerToolbar.Root>
        {/* The file pane's scroll body, class for class. */}
        <div data-preview-body className="flex-1 min-h-0 overflow-auto bg-surface-canvas">
          <MarkdownViewer
            content={doc === "notes" ? PLUGIN_NOTES : README}
            filePath="/tmp/preview/README.md"
            rootPath="/tmp/preview"
            viewMode="rendered"
            fontSize={size}
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
