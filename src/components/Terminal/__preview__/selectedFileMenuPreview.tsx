import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Clipboard, Copy, Send } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { FolderOpen, FolderTree } from "@/components/icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { revealCopy } from "@/components/FileViewer/revealCopy";
import { setHostPlatformInfo, type HostPlatformName } from "@/hooks/useHostPlatform";
import { terminalClipboardCombos } from "@/services/terminalReservedKeys";
import { SelectedFileMenuItems } from "../SelectedFileMenuItems";
import "@/index.css";

/**
 * Visual-review harness for the selected-file section of the terminal and
 * composer context menus.
 *
 * `SelectedFileMenuItems` is mounted for real. The terminal menu around it is
 * too entangled with live panel state to mount here, so its leading items and
 * the hovered-link section are reproduced with the menu's own item shape, label
 * source and grouping: right-clicking a selected path usually hovers that same
 * path as a detected link, and the two sections then share one reveal.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…        built-in theme id
 *   ?menu=terminal|composer        which caller's menu
 *   ?hover=same|other              terminal only: the hovered link is the selection, or another path
 *   ?host=mac|win|linux|remote|wsl the project host (remote = an SSH host, wsl = a distro on this PC)
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const menu = params.get("menu") ?? "terminal";
const host = params.get("host") ?? "mac";
const hover = params.get("hover") ?? "same";

const HOST_PLATFORM: Record<string, HostPlatformName> = {
  mac: "darwin",
  win: "win32",
  linux: "linux",
  remote: "linux",
  wsl: "linux",
};

if (host === "remote") window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
if (host === "wsl") window.__DAINTREE_HOST_ID__ = { id: "ubuntu" };
setHostPlatformInfo({
  platform: HOST_PLATFORM[host] ?? "darwin",
  connection: host === "wsl" ? { kind: "wsl", distro: "Ubuntu-24.04" } : null,
});
Object.defineProperty(navigator, "platform", {
  get: () =>
    host === "win" || host === "wsl" ? "Win32" : host === "linux" ? "Linux x86_64" : "MacIntel",
});

installPreviewShims();
applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const ICON = "w-3.5 h-3.5 mr-2 shrink-0";
const SELECTED_PATH =
  host === "win"
    ? "C:\\repo\\src\\components\\Terminal\\SelectedFileMenuItems.tsx"
    : "/repo/src/components/Terminal/SelectedFileMenuItems.tsx";
const HOVERED_PATH = hover === "other" ? "/repo/README.md" : SELECTED_PATH;

function TerminalMenu() {
  const clipboard = terminalClipboardCombos(navigator.platform === "MacIntel");
  return (
    <ContextMenuContent data-preview-surface>
      <ContextMenuItem>
        <Copy className={ICON} aria-hidden="true" />
        Copy
        <ContextMenuShortcut shortcut={clipboard.copy} />
      </ContextMenuItem>
      <ContextMenuItem>
        <Clipboard className={ICON} aria-hidden="true" />
        Paste
        <ContextMenuShortcut shortcut={clipboard.paste} />
      </ContextMenuItem>
      <ContextMenuItem keybinding="terminal.sendToAgent">
        <Send className={ICON} aria-hidden="true" />
        Send to agent
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem>
        <FolderTree className={ICON} aria-hidden="true" />
        Open in file browser
      </ContextMenuItem>
      {SELECTED_PATH === HOVERED_PATH && (
        <SelectedFileMenuItems absolutePath={SELECTED_PATH} reveal={false} />
      )}
      <ContextMenuItem>
        <FolderOpen className={ICON} aria-hidden="true" />
        {revealCopy().label}
      </ContextMenuItem>
      {SELECTED_PATH !== HOVERED_PATH && (
        <>
          <ContextMenuSeparator />
          <SelectedFileMenuItems absolutePath={SELECTED_PATH} />
        </>
      )}
    </ContextMenuContent>
  );
}

function ComposerMenu() {
  return (
    <ContextMenuContent data-preview-surface>
      <SelectedFileMenuItems absolutePath={SELECTED_PATH} />
    </ContextMenuContent>
  );
}

function Preview() {
  useEffect(() => {
    document.documentElement.dataset.previewReady = "true";
  }, []);
  return (
    <div className="relative bg-surface-canvas" style={{ width: "100vw", height: "100vh" }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            data-preview-context-trigger
            className="m-4 w-[480px] rounded-lg border border-border-subtle bg-surface-panel p-2 font-mono text-xs text-text-secondary"
          >
            <div>$ git status --short</div>
            <div>
              {" M "}
              <span className="bg-overlay-strong text-text-primary">{SELECTED_PATH}</span>
            </div>
          </div>
        </ContextMenuTrigger>
        {menu === "composer" ? <ComposerMenu /> : <TerminalMenu />}
      </ContextMenu>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>
);
