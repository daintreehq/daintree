import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { FileViewerToolbar } from "@/components/FileViewer/FileViewerToolbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FilePdfPreview } from "../FilePdfPreview";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the PDF preview's loading frame.
 *
 * The frame only shows while the `daintree-pdf://` admission probe is in
 * flight, which on a warm disk is gone inside the skeleton's own gate — so it
 * can't be held still in the real app. This renders the real `FilePdfPreview`
 * with that probe parked forever, under the file panel's toolbar and inside
 * the file panel's body, at whatever pane size the query asks for.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?width=900                pane width in CSS px
 *   ?height=640               body height in CSS px, below the toolbar
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "900");
const height = Number(params.get("height") ?? "640");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-panel)";
document.body.style.margin = "0";

// The probe never answers, so the preview stays in its loading branch for as
// long as the page is open. Anything else still reaches the network.
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("daintree-pdf:")) return new Promise<Response>(() => undefined);
  return realFetch(input, init);
};

function Preview() {
  return (
    <TooltipProvider>
      <div
        data-preview-shell
        className="flex flex-col overflow-hidden border border-border-default bg-surface-canvas"
        style={{ width: `${width}px` }}
      >
        <FileViewerToolbar.Root label="File viewer controls">
          <FileViewerToolbar.Path path="docs/specs/design-brief.pdf" />
        </FileViewerToolbar.Root>
        <div
          data-preview-body
          className="min-h-0 overflow-auto bg-surface-canvas"
          style={{ height: `${height}px` }}
        >
          <FilePdfPreview
            filePath="/repo/docs/specs/design-brief.pdf"
            rootPath="/repo"
            label="design-brief.pdf"
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>
);
