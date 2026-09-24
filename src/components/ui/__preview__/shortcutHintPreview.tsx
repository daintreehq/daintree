import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { ActionId } from "@shared/types/actions";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { actionService } from "@/services/ActionService";
import { shortcutHintStore } from "@/store/shortcutHintStore";
import { ShortcutHint } from "../ShortcutHint";
import { requireShortcutHintFixture } from "./shortcutHintFixtures";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the shortcut-hint teaching overlay.
 *
 * In the app the hint appears for 2.5 seconds, at a pointer position, only at
 * an invocation milestone — so it is close to impossible to screenshot on
 * purpose. This mounts the real `ShortcutHint` and raises it the way the app
 * does: the combo, exactly as the keybinding registry stores it, goes into
 * `shortcutHintStore.show()`, so what renders is what a user sees.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=triple           which hint to raise (see shortcutHintFixtures)
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "triple";
const fixture = requireShortcutHintFixture(fixtureName);

// `isMac()` reads navigator.platform at call time, so pinning it here decides
// how every glyph and label below resolves.
Object.defineProperty(navigator, "platform", {
  get: () => (fixture.platform === "mac" ? "MacIntel" : "Win32"),
});

const PREVIEW_ACTION = "preview.shortcutHint" as ActionId;
const realGetTitle = actionService.getTitle.bind(actionService);
actionService.getTitle = (id: ActionId) =>
  id === PREVIEW_ACTION ? fixture.title : realGetTitle(id);

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

function Preview() {
  useEffect(() => {
    const x = Math.round(window.innerWidth * fixture.anchor.x);
    const y = Math.round(window.innerHeight * fixture.anchor.y);
    // A focus-raised hint: it stays up until blur or Escape, so the capture is
    // not racing the 2.5-second timeout a post-click hint runs on.
    shortcutHintStore.getState().show(PREVIEW_ACTION, fixture.combo, { x, y, origin: "focus" });
    document.documentElement.dataset.hintRaised = "true";
  }, []);

  return (
    <div
      data-preview-shell
      className="relative bg-surface-canvas"
      style={{ width: "100vw", height: "100vh" }}
    >
      <div className="flex h-10 items-center gap-2 border-b border-border-subtle bg-surface-panel px-3 text-xs text-text-secondary">
        <span className="font-medium text-text-primary">daintree</span>
        <span>feature/shortcut-hint</span>
      </div>
      <pre className="m-0 px-3 py-2 text-xs leading-5 text-text-secondary">
        {"$ npm run check\n> typecheck … ok\n> lint:ratchet … ok\n> format:check … ok"}
      </pre>
      <ShortcutHint />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>
);
