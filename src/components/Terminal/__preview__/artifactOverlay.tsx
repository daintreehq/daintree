import { emitArtifactsDetected } from "./artifactOverlayShims";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { actionService } from "@/services/ActionService";
import { registerSystemActions } from "@/services/actions/definitions/systemActions";
import type { ActionCallbacks, ActionRegistry } from "@/services/actions/actionTypes";
import { ArtifactOverlay } from "../ArtifactOverlay";
import { FIXTURES } from "./artifactOverlayFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the terminal artifact overlay.
 *
 * Mounts the real `ArtifactOverlay` in a box the size and stacking of a
 * terminal pane's xterm host, against the real theme tokens and `index.css`.
 * Fixtures arrive through the overlay's own subscription: the shim's
 * `artifact.onDetected` is what `useArtifacts` listens on, and the harness
 * calls it with an `artifact:detected` payload, so the store, the cap and the
 * listener fan-out are the product's code. Save and apply go through the real
 * `artifact.*` actions to the shimmed bridge.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|namib|…   built-in theme id
 *   ?fixture=populated|single-code|single-patch|long-patch|many
 *   ?width=760&height=520            pane size in CSS px
 *   ?apply=success|error             how the bridge answers `applyPatch`
 *   ?save=success|error              how the bridge answers `saveToFile`
 *   ?worktree=0                      mount without worktree context
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "populated";
const width = Number(params.get("width") ?? 760);
const height = Number(params.get("height") ?? 520);
const withWorktree = params.get("worktree") !== "0";

const fixture = FIXTURES[fixtureName];
if (!fixture) throw new Error(`Unknown artifact fixture "${fixtureName}"`);

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";

// `registerSystemActions` never reads its callbacks; an inert Proxy satisfies the
// signature without claiming to be the app's real callback set.
const NO_CALLBACKS = new Proxy<ActionCallbacks>(Object.create(null), {
  get: () => () => undefined,
});
const registry: ActionRegistry = new Map();
registerSystemActions(registry, NO_CALLBACKS);
for (const id of ["artifact.applyPatch", "artifact.saveToFile"] as const) {
  const factory = registry.get(id);
  if (!factory) throw new Error(`systemActions no longer defines ${id}`);
  if (!actionService.has(id)) actionService.register(factory());
}

const TERMINAL_ID = "preview-terminal";
const CWD = "/Users/dev/Projects/daintree";

/** Plausible agent output behind the overlay, so its placement is judged against text. */
const TRANSCRIPT = [
  "⏺ Read(src/lib/format.ts)",
  "  ⎿  Read 64 lines",
  "",
  "⏺ The byte formatter doesn't guard negative or non-finite input. I'll clamp it and",
  "  add a cache-miss log so the SessionCache flake can be traced.",
  "",
  "⏺ Update(src/lib/format.ts)",
  "  ⎿  Updated src/lib/format.ts with 2 additions and 1 removal",
  "",
  "⏺ Update(src/services/SessionCache.ts)",
  "  ⎿  Updated src/services/SessionCache.ts with 9 additions and 3 removals",
  "",
  "⏺ Bash(npm test -- src/lib/format src/services/SessionCache)",
  "  ⎿  Test Files  2 passed (2)",
  "       Tests  41 passed (41)",
  "",
  "⏺ Done. Both changes are in, tests pass. Summary and patches are below.",
  "",
  "> ",
];

// StrictMode replays effects, and the store appends — one delivery per page load.
let seeded = false;

function Pane() {
  useEffect(() => {
    if (seeded) return;
    seeded = true;
    const delivered = emitArtifactsDetected({
      agentId: "claude",
      terminalId: TERMINAL_ID,
      worktreeId: withWorktree ? "wt-main" : undefined,
      artifacts: fixture!,
      timestamp: Date.now(),
    });
    if (!delivered) throw new Error("useArtifacts never subscribed to artifact.onDetected");
  }, []);

  return (
    <div
      data-preview-shell
      className="relative overflow-hidden border border-border-default"
      style={{ width, height, background: "var(--color-terminal-background)" }}
    >
      <div className="flex-1 relative min-h-0 h-full">
        <div className="absolute inset-0">
          <pre
            className="absolute inset-0 m-0 p-2 font-mono text-sm leading-[1.35]"
            style={{ color: "var(--color-terminal-foreground)" }}
          >
            {TRANSCRIPT.join("\n")}
          </pre>
          <ArtifactOverlay
            terminalId={TERMINAL_ID}
            worktreeId={withWorktree ? "wt-main" : undefined}
            cwd={withWorktree ? CWD : undefined}
          />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div style={{ padding: 24 }}>
        <Pane />
      </div>
    </TooltipProvider>
  </StrictMode>
);
