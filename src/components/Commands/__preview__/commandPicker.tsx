import "@/components/Layout/__preview__/bootstrap";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CommandPicker } from "../CommandPicker";
import { commandsFor, isCommandPickerFixture } from "./commandPickerFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the command picker.
 *
 * Mounts the real `CommandPicker` (and through it the real `SearchablePalette`
 * and `AppPaletteDialog`) against the real theme tokens and `index.css`, fed
 * manifest entries in the exact shape `CommandService.list()` hands the store.
 * The Electron route to this surface needs an agent terminal with a composer
 * and a forge provider in a particular state, and still only ever shows the two
 * shipped commands; the fixtures here reach the disabled, loading and empty
 * branches as well.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…                      built-in theme id
 *   ?fixture=shipped|no-forge|wide|loading|empty  manifest to show (default shipped)
 *
 * The composer strip behind the palette is harness decoration. The last command
 * the picker selected is mirrored onto `body[data-selected-command]`.
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const requested = params.get("fixture");
const fixture = isCommandPickerFixture(requested) ? requested : "shipped";

function App() {
  const [ready, setReady] = useState(false);
  const [isOpen, setIsOpen] = useState(true);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);
  const commands = useMemo(() => commandsFor(fixture), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    setReady(true);
  }, [scheme]);

  if (!ready) return null;

  return (
    <TooltipProvider>
      <div data-preview-shell="" className="flex h-screen flex-col bg-surface-canvas">
        <div className="flex-1" />
        <div
          data-harness-decoration=""
          aria-hidden="true"
          className="mx-auto mb-6 flex h-10 w-[720px] items-center rounded-[var(--radius-md)] border border-border-subtle bg-surface-panel px-3 text-xs text-text-secondary"
        >
          Agent composer
        </div>
      </div>
      <CommandPicker
        isOpen={isOpen}
        commands={commands}
        isLoading={fixture === "loading"}
        onSelect={(cmd) => {
          document.body.dataset.selectedCommand = cmd.id;
          setIsOpen(false);
        }}
        onDismiss={() => setIsOpen(false)}
      />
    </TooltipProvider>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
