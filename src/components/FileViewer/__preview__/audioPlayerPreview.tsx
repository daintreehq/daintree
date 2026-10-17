import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { FileViewerToolbar } from "@/components/FileViewer/FileViewerToolbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { publishScrollbarGutter } from "@/lib/scrollbarGutter";
import { FileAudioPreview } from "../FileAudioPreview";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the inline audio player at pane widths
 * around and below the native control's 300px floor.
 *
 * Renders the real `FileAudioPreview` inside copies of the two containers that
 * mount it: the file panel's body (a plain block scroller, which the diff
 * pane's body matches) and the file browser's media stage (a centring flex
 * row). The two protocols the component reaches for are answered here: the
 * size probe's `HEAD` on `daintree-file://`, and the element's
 * `daintree-media://` source, which is swapped for a generated WAV so the
 * control renders loaded, with a real duration.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…        built-in theme id
 *   ?host=file-pane|file-browser   which container mounts the player
 *   ?width=300                     pane width in CSS px
 *   ?height=220                    pane body height in CSS px
 *   ?state=ready|probing           loaded control, or the size probe in flight
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const host = params.get("host") === "file-browser" ? "file-browser" : "file-pane";
const width = Number(params.get("width") ?? "300");
const height = Number(params.get("height") ?? "220");
const state = params.get("state") === "probing" ? "probing" : "ready";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";
// As `main.tsx` does at boot: the player's fade stops short of the measured
// scrollbar gutter.
publishScrollbarGutter();

/** Three minutes of an 8kHz 8-bit mono tone: long enough for a real "3:00" duration. */
function toneWavUrl(seconds = 180, rate = 8000): string {
  const samples = seconds * rate;
  const buffer = new ArrayBuffer(44 + samples);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, "data");
  view.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) {
    view.setUint8(44 + i, 128 + Math.round(20 * Math.sin((2 * Math.PI * 440 * i) / rate)));
  }
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

const toneUrl = toneWavUrl();

const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("daintree-file:")) return realFetch(input, init);
  if (state === "probing") {
    // Held open until the component aborts it, so the skeleton stays up.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
    });
  }
  return Promise.resolve(
    new Response(null, { status: 200, headers: { "content-length": "1440044" } })
  );
};

const realSetAttribute = Element.prototype.setAttribute;
Element.prototype.setAttribute = function (name: string, value: string) {
  if (this instanceof HTMLMediaElement && name === "src" && value.startsWith("daintree-media:")) {
    return realSetAttribute.call(this, name, toneUrl);
  }
  return realSetAttribute.call(this, name, value);
};

const HOST_CLASS: Record<typeof host, string> = {
  // `FilePane`'s `file-pane-body`, and the diff pane's scroll root.
  "file-pane": "h-full overflow-auto bg-surface-canvas",
  // `FileBrowserViewer`'s `MEDIA_STAGE_CLASS`.
  "file-browser": "flex h-full w-full items-center justify-center overflow-auto",
};

function Preview() {
  return (
    <TooltipProvider>
      <div
        data-preview-shell
        data-host={host}
        className="flex flex-col overflow-hidden border border-border-default bg-surface-canvas"
        style={{ width: `${width}px` }}
      >
        <FileViewerToolbar.Root label="File viewer controls">
          <FileViewerToolbar.Path path="assets/audio/notification.wav" />
        </FileViewerToolbar.Root>
        <div data-preview-body style={{ height: `${height}px` }}>
          <div className={HOST_CLASS[host]}>
            <FileAudioPreview
              filePath="/repo/assets/audio/notification.wav"
              rootPath="/repo"
              label="notification.wav"
            />
          </div>
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
