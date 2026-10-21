import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RefreshCw, Copy, FolderOpen, ExternalLink } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { FileViewerToolbar, TOOLBAR_ICON_CLASS } from "@/components/FileViewer/FileViewerToolbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getFileTypeIcon } from "@/panels/file-browser/fileTypeIcons";
import { CodeViewer } from "../CodeViewer";
import { FileSourceMetadataStrip } from "../FileSourceMetadataStrip";
import { countLines, detectLineEnding } from "../FileMetadataFacts";
import { MarkdownEditorStatusBar } from "../../../../plugins/builtin/markdown-editor/renderer/MarkdownEditorStatusBar";
import { requireMetadataStripFixture } from "./metadataStripFixtures";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the file panel's Source-mode metadata
 * strip. The facts it carries depend on bytes most repositories don't have
 * lying around — a BOM, CRLF endings, text that isn't valid UTF-8 — so this
 * renders the real strip over the real `CodeViewer` under the real toolbar row,
 * fed the same content and `files:read` encoding the pane would receive.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=typescript       which file to render
 *   ?width=900                panel width in CSS px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "900");
const fixture = requireMetadataStripFixture(params.get("fixture") ?? "typescript");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

function Preview() {
  const fileName = fixture.filePath.split("/").pop() ?? fixture.filePath;
  const modes = fixture.editor
    ? [
        { value: "rendered", label: "Rendered" },
        { value: "source", label: "Source" },
        { value: "edit", label: "Edit" },
      ]
    : [
        { value: "source", label: "Source" },
        { value: "diff", label: "Diff" },
      ];
  return (
    <TooltipProvider>
      <div
        data-preview-shell
        className="flex flex-col bg-surface-canvas"
        style={{ width: `${width}px`, height: "100vh" }}
      >
        <FileViewerToolbar.Root label="File viewer controls" compactBelow={500}>
          <FileViewerToolbar.ModeControl
            options={modes}
            value={fixture.editor ? "edit" : "source"}
            onChange={() => {}}
          />
          <FileViewerToolbar.Path
            path={fixture.filePath}
            icon={getFileTypeIcon(fileName).Icon}
            copyText={fixture.filePath}
          />
          <FileViewerToolbar.Actions>
            <FileViewerToolbar.Responsive
              wide={
                <>
                  <FileViewerToolbar.IconButton label="Refresh" onClick={() => {}}>
                    <RefreshCw className={TOOLBAR_ICON_CLASS} />
                  </FileViewerToolbar.IconButton>
                  <FileViewerToolbar.IconButton label="Copy file contents" onClick={() => {}}>
                    <Copy className={TOOLBAR_ICON_CLASS} />
                  </FileViewerToolbar.IconButton>
                  <FileViewerToolbar.IconButton label="Reveal in Finder" onClick={() => {}}>
                    <FolderOpen className={TOOLBAR_ICON_CLASS} />
                  </FileViewerToolbar.IconButton>
                  <FileViewerToolbar.IconButton label="Open in editor" onClick={() => {}}>
                    <ExternalLink className={TOOLBAR_ICON_CLASS} />
                  </FileViewerToolbar.IconButton>
                </>
              }
              narrow={
                <FileViewerToolbar.IconButton label="Refresh" onClick={() => {}}>
                  <RefreshCw className={TOOLBAR_ICON_CLASS} />
                </FileViewerToolbar.IconButton>
              }
            />
          </FileViewerToolbar.Actions>
        </FileViewerToolbar.Root>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {fixture.editor ? (
            <MarkdownEditorStatusBar
              filePath={fixture.filePath}
              lineCount={countLines(fixture.content)}
              byteLength={fixture.byteLength}
              hasBom={false}
              eolLabel="LF"
              lineEnding={detectLineEnding(fixture.content)}
              dirty={false}
              saving={false}
              saveBlocked={false}
              onSave={() => {}}
            />
          ) : (
            <FileSourceMetadataStrip
              content={fixture.content}
              filePath={fixture.filePath}
              encoding={fixture.encoding}
              byteLength={fixture.byteLength}
            />
          )}
          {/* As FilePane does: the strip names a BOM, so the view doesn't draw it. */}
          <CodeViewer
            content={
              fixture.encoding === "utf-8-bom"
                ? fixture.content.replace(/^\uFEFF/, "")
                : fixture.content
            }
            filePath={fixture.filePath}
            className="flex-1"
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
