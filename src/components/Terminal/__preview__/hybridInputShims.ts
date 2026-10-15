import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { getBuiltinSlashCommands } from "@shared/types";
import type { BuiltInAgentId } from "@shared/config/agentIds";

// Imported first by `hybridInput.tsx`, so the shim is on `window` before any
// store module evaluates — same reasoning as the panel-header harness.
//
// The composer's layout is decided by its own flex tracks, CodeMirror's
// autosize and the column width; none of that reaches for the bridge, so the
// blanket inert Proxy covers almost all of it.
//
// The one namespace that has to be answered is the slash-command list. The
// Proxy resolves every call to `undefined`, and `useSlashCommandList` assigns
// that straight into state and then iterates it — so an unanswered `list` is
// not an inert no-op there, it throws during render and the harness mounts
// nothing. An empty array is the honest answer for the layout cases: this
// harness has no project to read commands from, and the command list has no
// bearing on layout. The chips case answers with the agent's built-ins, which
// is what a real list starts from, so a `/compact` in its draft solidifies
// into a chip with a tooltip like it does in the app.
const isChipsCase = new URLSearchParams(window.location.search).get("case") === "chips";

/**
 * A stand-in screenshot for the image chip's thumbnail: a small terminal window
 * drawn on a canvas. A flat colour swatch would hide exactly what the preview
 * card is judged on — whether a real, busy image reads at its size.
 */
function drawScreenshotThumbnail(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 300;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#1b1d22";
  ctx.fillRect(0, 0, 480, 300);
  ctx.fillStyle = "#2a2d34";
  ctx.fillRect(0, 0, 480, 28);
  ["#ff5f57", "#febc2e", "#28c840"].forEach((colour, i) => {
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(18 + i * 18, 14, 5, 0, Math.PI * 2);
    ctx.fill();
  });
  const lines: [string, number][] = [
    ["#7ee787", 220],
    ["#c9d1d9", 340],
    ["#c9d1d9", 280],
    ["#79c0ff", 180],
    ["#c9d1d9", 400],
    ["#ffa657", 250],
    ["#c9d1d9", 310],
    ["#8b949e", 200],
  ];
  lines.forEach(([colour, width], i) => {
    ctx.fillStyle = colour;
    ctx.fillRect(20, 48 + i * 28, width, 10);
  });
  return canvas.toDataURL("image/png");
}

installPreviewShims({
  slashCommands: {
    list: ({ agentId }: { agentId: BuiltInAgentId }) =>
      Promise.resolve(isChipsCase ? getBuiltinSlashCommands(agentId) : []),
  },
  clipboard: {
    thumbnailFromPath: () => Promise.resolve({ thumbnailDataUrl: drawScreenshotThumbnail() }),
  },
});

try {
  window.localStorage.clear();
  window.sessionStorage.clear();
} catch {
  // Storage can be unavailable; the harness renders without it.
}
