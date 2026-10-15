import { CHANGES, ROOT } from "./fileDecorationBadgesBridge";
import "@/components/Panel/__preview__/installShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import latin400Woff2Url from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FileChangeList } from "../FileChangeList";
import { ensureLatin400Preload } from "@/lib/fontPreload";
import "@/index.css";

/**
 * Standalone visual-review harness for plugin file-decoration badges in the
 * worktree card's changed-file list. The real `FileChangeList`, in the card's
 * own inset well, with decorations arriving through the plugin bridge: a link
 * badge, static badges with one, two and three characters, and a provider
 * colour with a tooltip long enough to wrap.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";

// The row face is `font-display: optional`: miss its first 100ms and the page
// keeps the fallback mono for good. Preload it the way the app's boot does.
ensureLatin400Preload(latin400Woff2Url);
applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

// The plugin menu contributions arrive over IPC in the app; the harness has none.
usePluginContextMenuItemsStore.setState({ entries: [], init: () => {} });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      {/* Wide and tall enough that a tooltip or the row menu lands inside the frame. */}
      <div data-preview-frame className="h-[460px] w-[600px] p-6">
        <div
          data-surface="card"
          className="w-72 rounded-[var(--radius-lg)] bg-surface-sidebar p-3 text-text-primary"
        >
          <div className="mb-2 text-2xs font-medium text-text-secondary">Changes</div>
          <FileChangeList
            changes={CHANGES}
            rootPath={ROOT}
            className="rounded-[var(--radius-md)] bg-surface-inset p-2"
          />
        </div>
      </div>
    </TooltipProvider>
  </StrictMode>
);
