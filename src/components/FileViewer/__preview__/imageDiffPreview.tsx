import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { DiffMediaFileVersions, DiffMediaSide, GitStatus } from "@shared/types";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { ImageDiffViewer } from "../ImageDiffViewer";
import "@/index.css";

/**
 * Standalone visual-review harness for the image diff viewer.
 *
 * Reaching every state in the real app needs a repo with an image that is
 * modified, resized, added, deleted, over the size cap and unreadable — so this
 * renders the real `ImageDiffViewer` against the real theme tokens and answers
 * its one IPC read (`diffMedia.readFileVersions`) from canvas-drawn fixtures.
 * Mode switching is left to the capture spec, which clicks the real toggle.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=modified         which versions the read answers with
 *   ?width=900                pane width in CSS px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "900");
const fixture = params.get("fixture") ?? "modified";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

interface Art {
  width: number;
  height: number;
  /** "light" paints an opaque near-white card, the case a pale divider vanishes on. */
  tone: "transparent" | "light";
  badge: string;
  dotX: number;
  accent: string;
}

/** An app-icon-ish image: transparent corners, a card, a moved dot, a label. */
function draw(art: Art): DiffMediaSide {
  const canvas = document.createElement("canvas");
  canvas.width = art.width;
  canvas.height = art.height;
  const ctx = canvas.getContext("2d")!;
  const pad = 24;
  ctx.fillStyle = art.tone === "light" ? "#f7f7f5" : "#2b6cb0";
  ctx.beginPath();
  ctx.roundRect(pad, pad, art.width - pad * 2, art.height - pad * 2, 28);
  ctx.fill();
  ctx.fillStyle = art.accent;
  ctx.beginPath();
  ctx.arc(art.dotX, art.height / 2, art.height / 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = art.tone === "light" ? "#1f2937" : "#ffffff";
  ctx.font = "600 44px -apple-system, system-ui, sans-serif";
  ctx.fillText(art.badge, art.width - 170, art.height - 56);
  const dataUrl = canvas.toDataURL("image/png");
  return { ok: true, dataUrl, byteSize: Math.round((dataUrl.length * 3) / 4) };
}

const HEAD: Art = {
  width: 640,
  height: 400,
  tone: "transparent",
  badge: "v1.2",
  dotX: 180,
  accent: "#f6ad55",
};
const WORKING: Art = { ...HEAD, badge: "v1.3", dotX: 260, accent: "#68d391" };

const FIXTURES: Record<string, { status: GitStatus; read: () => DiffMediaFileVersions | null }> = {
  modified: { status: "modified", read: () => ({ head: draw(HEAD), working: draw(WORKING) }) },
  resized: {
    status: "modified",
    read: () => ({ head: draw(HEAD), working: draw({ ...WORKING, width: 760, height: 360 }) }),
  },
  light: {
    status: "modified",
    read: () => ({
      head: draw({ ...HEAD, tone: "light" }),
      working: draw({ ...WORKING, tone: "light" }),
    }),
  },
  added: {
    status: "added",
    read: () => ({ head: { ok: false, error: "NOT_FOUND" }, working: draw(WORKING) }),
  },
  deleted: {
    status: "deleted",
    read: () => ({ head: draw(HEAD), working: { ok: false, error: "NOT_FOUND" } }),
  },
  "too-large": {
    status: "modified",
    read: () => ({ head: draw(HEAD), working: { ok: false, error: "TOO_LARGE" } }),
  },
  "read-error": {
    status: "deleted",
    read: () => ({
      head: { ok: false, error: "ERROR" },
      working: { ok: false, error: "NOT_FOUND" },
    }),
  },
  failed: {
    status: "modified",
    read: () => ({ head: { ok: false, error: "ERROR" }, working: { ok: false, error: "ERROR" } }),
  },
  loading: { status: "modified", read: () => null },
};

function requireFixture(name: string) {
  const found = FIXTURES[name];
  if (!found) throw new Error(`unknown image-diff fixture "${name}"`);
  return found;
}
const selected = requireFixture(fixture);

installPreviewShims({
  diffMedia: {
    readFileVersions: () => {
      const versions = selected.read();
      // `loading` never settles, so the skeleton is what stays on screen.
      return versions ? Promise.resolve(versions) : new Promise(() => undefined);
    },
  },
});

function Preview() {
  return (
    <div
      data-preview-shell
      className="flex flex-col bg-surface"
      style={{ width: `${width}px`, height: "100vh" }}
    >
      <div className="h-full min-h-[300px]">
        <ImageDiffViewer
          relPath="assets/icons/app-icon.png"
          worktreePath="/preview/worktree"
          status={selected.status}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>
);
