import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ExternalLink, FileCode, FolderOpen, RefreshCw } from "lucide-react";
import latin400Woff2Url from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { FileViewerToolbar, TOOLBAR_ICON_CLASS } from "@/components/FileViewer/FileViewerToolbar";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ensureLatin400Preload } from "@/lib/fontPreload";
import { HtmlViewer } from "../HtmlViewer";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the HTML viewer's no-preview fallback.
 *
 * The fallback only appears when a read returns no preview URL — a file at a
 * volume root, or one that resolved outside the folder being browsed — which
 * is awkward to stage in the running app. This renders the real `HtmlViewer`
 * with a null URL in the place it actually sits: under the file viewer's real
 * toolbar, with the Source / Rendered control it points at.
 *
 * The source view is a plain `<pre>` stand-in for CodeViewer, and the focus
 * hand-back mirrors the hosts' (FilePane, FileBrowserViewer): only when the
 * fallback's own button dropped focus to the body does the active segment
 * take it, ringed for a keyboard activation alone.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?width=900&height=560     pane size in CSS px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "900");
const height = Number(params.get("height") ?? "560");

ensureLatin400Preload(latin400Woff2Url);
applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const PATH = "reports/coverage/index.html";

const MARKUP = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Coverage report</title>
    <link rel="stylesheet" href="./base.css" />
  </head>
  <body>
    <main id="summary">
      <h1>All files</h1>
      <p>84.2% statements, 1,204 of 1,430</p>
    </main>
    <script src="./sorter.js"></script>
  </body>
</html>`;

type Mode = "source" | "rendered";

const MODE_OPTIONS: Array<{ value: Mode; label: string }> = [
  { value: "source", label: "Source" },
  { value: "rendered", label: "Rendered" },
];

function Pane() {
  const [mode, setMode] = useState<Mode>("rendered");
  const modeToggleRef = useRef<HTMLDivElement>(null);
  const previousMode = useRef(mode);
  const sourceFocusRef = useRef<{ focusVisible: boolean } | null>(null);

  useEffect(() => {
    const sourceFocus = sourceFocusRef.current;
    sourceFocusRef.current = null;
    if (sourceFocus && mode !== previousMode.current && document.activeElement === document.body) {
      const toggle = modeToggleRef.current;
      (
        toggle?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
        toggle?.querySelector<HTMLElement>("button")
      )?.focus({ preventScroll: true, focusVisible: sourceFocus.focusVisible });
    }
    previousMode.current = mode;
  }, [mode]);

  return (
    <div
      data-preview-shell
      data-mode={mode}
      className="flex flex-col overflow-hidden border border-overlay bg-surface-canvas"
      style={{ width: `${width}px`, height: `${height}px` }}
    >
      <FileViewerToolbar.Root label="File viewer controls" compactBelow={500}>
        <div ref={modeToggleRef} className="contents">
          <FileViewerToolbar.ModeControl<Mode>
            options={MODE_OPTIONS}
            value={mode}
            onChange={setMode}
          />
        </div>
        <FileViewerToolbar.Path path={PATH} icon={FileCode} copyText={PATH} />
        <FileViewerToolbar.Actions>
          <FileViewerToolbar.Responsive
            wide={
              <>
                <FileViewerToolbar.IconButton label="Refresh" onClick={() => undefined}>
                  <RefreshCw className={TOOLBAR_ICON_CLASS} />
                </FileViewerToolbar.IconButton>
                <FileViewerToolbar.CopyContentsButton contents={MARKUP} />
                <FileViewerToolbar.IconButton label="Reveal in Finder" onClick={() => undefined}>
                  <FolderOpen className={TOOLBAR_ICON_CLASS} />
                </FileViewerToolbar.IconButton>
                <FileViewerToolbar.IconButton label="Open in browser" onClick={() => undefined}>
                  <ExternalLink className={TOOLBAR_ICON_CLASS} />
                </FileViewerToolbar.IconButton>
              </>
            }
            narrow={
              <>
                <FileViewerToolbar.IconButton label="Refresh" onClick={() => undefined}>
                  <RefreshCw className={TOOLBAR_ICON_CLASS} />
                </FileViewerToolbar.IconButton>
                <FileViewerToolbar.MoreActions>
                  <DropdownMenuItem>Copy file contents</DropdownMenuItem>
                  <DropdownMenuItem>Reveal in Finder</DropdownMenuItem>
                  <DropdownMenuItem>Open in browser</DropdownMenuItem>
                </FileViewerToolbar.MoreActions>
              </>
            }
          />
        </FileViewerToolbar.Actions>
      </FileViewerToolbar.Root>
      <div data-preview-body className="flex-1 min-h-0 overflow-auto bg-surface-canvas">
        {mode === "rendered" ? (
          <HtmlViewer
            previewUrl={null}
            reloadNonce={0}
            title="index.html"
            className="min-h-full"
            onShowSource={(event) => {
              sourceFocusRef.current = { focusVisible: event.detail === 0 };
              setMode("source");
            }}
          />
        ) : (
          <pre
            data-preview-source
            className="m-0 px-3 py-2 font-mono text-xs leading-5 text-text-secondary"
          >
            {MARKUP}
          </pre>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Pane />
    </TooltipProvider>
  </StrictMode>
);
