import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { FileVideoPreview } from "../FileVideoPreview";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the inline video preview.
 *
 * The interesting cases are small panes — a tile in a crowded grid, the file
 * browser's viewer column beside a wide tree — and reaching each of them in the
 * real app means rearranging the grid between screenshots. This renders the real
 * `FileVideoPreview` inside the body box each pane gives it, at an exact size.
 *
 * Neither media protocol exists in a browser tab, so both are answered here: the
 * size probe's `HEAD` on `daintree-file://` resolves with a small length (or
 * never, for the loading state), and the element's `daintree-media://` src is
 * pointed at a fixture the capture spec serves.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…                built-in theme id
 *   ?host=file-pane|file-browser|diff-pane|file-dialog  which body the preview sits in
 *   ?fixture=landscape|portrait|probing     the clip, or a probe that never settles
 *   ?width=480&height=300                   pane body size in CSS px (a cap, for file-dialog)
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const host = params.get("host") ?? "file-pane";
const fixture = params.get("fixture") ?? "landscape";
const width = Number(params.get("width") ?? "480");
const height = Number(params.get("height") ?? "300");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-panel)";
document.body.style.margin = "0";

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("daintree-file:")) {
    if (fixture === "probing") return new Promise<Response>(() => {});
    return Promise.resolve(
      new Response(null, { status: 200, headers: { "content-length": "1048576" } })
    );
  }
  return nativeFetch(input, init);
};

const nativeSetAttribute = Element.prototype.setAttribute;
Element.prototype.setAttribute = function (name: string, value: string) {
  if (this instanceof HTMLVideoElement && name === "src" && value.startsWith("daintree-media:")) {
    return nativeSetAttribute.call(this, name, `/__video-fixtures/${fixture}.webm`);
  }
  return nativeSetAttribute.call(this, name, value);
};

/**
 * The body box each consumer hands the preview, copied from its call site:
 * `FilePane`'s scroll body, `FileBrowserViewer`'s viewer column plus its
 * `MEDIA_STAGE_CLASS`, and `DiffPane`'s scroll root. `file-dialog` is the file
 * panel hosted by `PanelDialogHost`, which sizes to its content up to a cap
 * rather than to a grid cell — so the body has no definite height there.
 */
function HostBody({ children }: { children: ReactNode }) {
  if (host === "file-dialog") {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex-1 min-h-0 overflow-auto bg-surface-canvas">{children}</div>
      </div>
    );
  }
  if (host === "file-browser") {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-full w-full items-center justify-center overflow-auto">
          {children}
        </div>
      </div>
    );
  }
  if (host === "diff-pane") {
    return <div className="flex-1 min-h-0 overflow-auto diff-scroll-root">{children}</div>;
  }
  return <div className="flex-1 min-h-0 overflow-auto bg-surface-canvas">{children}</div>;
}

function Preview() {
  return (
    <div className="p-4">
      <div
        data-preview-shell
        className="flex flex-col bg-surface-canvas outline outline-1 outline-border-default"
        style={
          host === "file-dialog"
            ? { width: `${width}px`, maxHeight: `${height}px` }
            : { width: `${width}px`, height: `${height}px` }
        }
      >
        <HostBody>
          <FileVideoPreview
            filePath="/repo/assets/video/demo-walkthrough.webm"
            rootPath="/repo"
            label="demo-walkthrough.webm"
            maxHeightClassName="max-h-full"
          />
        </HostBody>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>
);
