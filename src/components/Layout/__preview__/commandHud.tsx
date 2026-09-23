import "./commandHudBootstrap";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { KEYBINDING_PRIORITY, keybindingService } from "@/services/KeybindingService";
import { combosFieldsEqual } from "@/services/keybindingUtils";
import { COMMAND_HUD_PREFIX } from "@/hooks/useGlobalKeybindings";
import { ChordIndicator } from "../ChordIndicator";
import "@/index.css";

/**
 * Standalone visual-review harness for the Cmd+K command HUD (`ChordIndicator`).
 *
 * The HUD is the only thing a pending chord draws, and it floats over whatever
 * the user was doing — usually a grid of busy terminals. This mounts the REAL
 * `ChordIndicator` against the real `KeybindingService` singleton (so the rows
 * are the shipped default Cmd+K layer, formatted by the shipped display code),
 * the real theme tokens and the real `index.css`. The terminal grid behind it is
 * harness decoration, dense on purpose: the glass has to hold its text over it.
 *
 * The keydown listener below is the slice of `useGlobalKeybindings` the HUD
 * depends on — Cmd+K opens, a second Cmd+K or Escape closes, a modifier chord
 * completes through `resolveKeybinding` — so the spec drives it with real
 * keystrokes rather than reaching into the service.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?long=1                   register plugin-style bindings with long labels
 *   ?perf=1                   performance mode (solid glass fallback)
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.margin = "0";
document.body.style.background = "var(--color-surface-canvas)";
if (params.get("perf") === "1") document.body.dataset.performanceMode = "true";

if (params.get("long") === "1") {
  // Plugin-contributed bindings carry no category (they land under "Other") and
  // their descriptions are whatever the author wrote — the realistic source of a
  // label long enough to clip.
  keybindingService.registerBinding({
    actionId: "plugin.pr-writer.regenerate",
    combo: "Cmd+K Cmd+J",
    scope: "global",
    priority: KEYBINDING_PRIORITY.PLUGIN,
    description:
      "Regenerate the pull request description from the full branch diff, linked issues and review threads",
    pluginId: "pr-writer",
  });
  keybindingService.registerBinding({
    actionId: "plugin.pr-writer.checklist",
    combo: "Cmd+K Shift+Cmd+J",
    scope: "global",
    priority: KEYBINDING_PRIORITY.PLUGIN,
    description: "Insert reviewer checklist",
    pluginId: "pr-writer",
  });
}

function useChordKeys() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const pending = keybindingService.getPendingChord();
      const hudOpen = pending !== null && combosFieldsEqual(pending, COMMAND_HUD_PREFIX);
      if (hudOpen && keybindingService.matchesEvent(e, COMMAND_HUD_PREFIX)) {
        e.preventDefault();
        keybindingService.clearPendingChord();
        return;
      }
      if (e.key === "Escape" && pending) {
        e.preventDefault();
        keybindingService.clearPendingChord();
        return;
      }
      if (!e.metaKey && !e.ctrlKey) return;
      const result = keybindingService.resolveKeybinding(e);
      if (result.shouldConsume) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}

const PANES = [
  "claude — issue-12488-handback",
  "codex — design-chord-indicator",
  "npm run dev",
  "vitest --watch",
  "zsh — daintree",
  "gemini — feature/plugin-hosted-mcps",
] as const;

const LINES = [
  "✓ src/services/__tests__/KeybindingService.test.ts (142 tests) 318ms",
  "  vite v8.0.14 building for development…",
  "● Reading src/components/Layout/ChordIndicator.tsx",
  "  ⎿  Read 267 lines (ctrl+r to expand)",
  "[main] 11:25:04.221 ipc worktree:list 18ms",
  "✗ e2e/full/platform/core-keyboard-shortcuts.spec.ts › chord HUD closes on Esc",
  "  diff --git a/src/hooks/useCommandHud.ts b/src/hooks/useCommandHud.ts",
  "+  const isOpen = pendingChord !== null && combosFieldsEqual(pendingChord, PREFIX);",
  "-  const isOpen = pendingChord === COMMAND_HUD_PREFIX;",
  "  GET /api/sessions 200 in 42ms",
  "  Thinking… (esc to interrupt · 14s · ↓ 2.1k tokens)",
  "$ git log --oneline -3",
  "308af06baf Merge pull request #12652 from daintreehq/chore/deps",
  "  ⏺ Update(src/components/ui/Kbd.tsx)",
  "warning: 3 React Compiler bailouts in src/components/Layout/",
  "  Tests  4 failed | 1,284 passed (1,288)",
];

/** Six dense terminal panes — harness decoration, not the surface under review. */
function BusyGrid() {
  return (
    <div
      data-harness-decoration
      aria-hidden="true"
      className="fixed inset-0 grid grid-cols-3 grid-rows-2 gap-1 p-1"
    >
      {PANES.map((pane, i) => (
        <div
          key={pane}
          className="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-md)] border border-border-subtle bg-surface-panel"
        >
          <div className="flex h-7 shrink-0 items-center border-b border-border-subtle px-2 text-xs text-text-secondary">
            {pane}
          </div>
          <pre className="m-0 min-h-0 flex-1 overflow-hidden px-2 py-1 font-mono text-xs leading-snug text-text-primary">
            {Array.from({ length: 40 }, (_, n) => LINES[(n * 5 + i * 3) % LINES.length]).join("\n")}
          </pre>
        </div>
      ))}
    </div>
  );
}

function Preview() {
  useChordKeys();
  return (
    <>
      <BusyGrid />
      <div data-preview-shell />
      <ChordIndicator />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>
);
