import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  Archive,
  Bell,
  Clipboard,
  Copy,
  Maximize2,
  Send,
  Settings,
  Sparkles,
  SquareTerminal,
  Command,
} from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import type { ActionId } from "@shared/types/actions";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import { shortcutHintStore } from "@/store/shortcutHintStore";
import { isMac } from "@/lib/platform";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { KbdChord } from "../Kbd";
import { terminalClipboardCombos } from "@/services/terminalReservedKeys";
import { INSERT_FILE_REFERENCE_COMBO } from "@/panels/file-browser/fileReference";
import { FLEET_EXIT_COMBO } from "@/components/Fleet/fleetKeys";
import { ShortcutHint } from "../ShortcutHint";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "../context-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../tooltip";
import { LiveTipMessage, TIPS } from "@/components/Terminal/contentGridTips";
import { HelpIntroBanner } from "@/components/HelpPanel/HelpIntroBanner";
import "@/index.css";

installPreviewShims();

/**
 * Visual-review harness for every place a keyboard shortcut is drawn.
 *
 * Each fixture mounts the real primitives (menu shortcut slots, tooltip content,
 * the shortcut hint, tips, banners) fed the way their callers feed them, so the
 * capture is what a user sees. Callers too entangled to mount here (the toolbar
 * overflow, the terminal context menu) are reproduced with their own item shape
 * and their own shortcut source.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?platform=mac|win         how every glyph resolves
 *   ?fixture=menu|context-menu|tooltip|inline
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const platform = params.get("platform") ?? "mac";
const fixture = params.get("fixture") ?? "menu";

Object.defineProperty(navigator, "platform", {
  get: () => (platform === "mac" ? "MacIntel" : "Win32"),
});

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const combo = (id: string) => keybindingService.getEffectiveCombo(id) ?? "";

const ICON = "mr-2 h-3.5 w-3.5";

function MenuFixture() {
  return (
    <div className="p-4">
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger asChild>
          <button type="button" className="text-xs text-text-secondary">
            Overflow
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64" data-preview-surface>
          <DropdownMenuItem keybinding="agent.claude">
            <Sparkles className={ICON} />
            <span className="flex-1">Claude</span>
          </DropdownMenuItem>
          <DropdownMenuItem keybinding="agent.terminal">
            <SquareTerminal className={ICON} />
            <span className="flex-1">Terminal</span>
          </DropdownMenuItem>
          <DropdownMenuItem keybinding="worktree.copyTree">
            <Copy className={ICON} />
            <span className="flex-1">Copy context</span>
          </DropdownMenuItem>
          <DropdownMenuItem keybinding="action.palette.open">
            <Command className={ICON} />
            <span className="flex-1">Command palette</span>
          </DropdownMenuItem>
          <DropdownMenuItem keybinding="app.settings">
            <Settings className={ICON} />
            <span className="flex-1">Settings</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem keybinding="terminal.resumeSessions">
            <SquareTerminal className={ICON} />
            <span className="flex-1">Resume sessions</span>
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Archive className={ICON} />
            Archive
            <DropdownMenuShortcut shortcut="E" />
          </DropdownMenuItem>
          <DropdownMenuItem disabled keybinding="notifications.toggle">
            <Bell className={ICON} />
            <span className="flex-1">Notifications (disabled)</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ContextMenuFixture() {
  const clipboard = terminalClipboardCombos(isMac());
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-preview-context-trigger
          className="m-4 h-24 w-72 rounded border border-border-subtle bg-surface-panel p-2 font-mono text-xs text-text-secondary"
        >
          $ npm test
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent data-preview-surface>
        <ContextMenuItem>
          <Copy className={ICON} />
          Copy
          <ContextMenuShortcut shortcut={clipboard.copy} />
        </ContextMenuItem>
        <ContextMenuItem>
          <Clipboard className={ICON} />
          Paste
          <ContextMenuShortcut shortcut={clipboard.paste} />
        </ContextMenuItem>
        <ContextMenuItem keybinding="terminal.sendToAgent">
          <Send className={ICON} />
          Send to agent
        </ContextMenuItem>
        <ContextMenuItem keybinding="terminal.maximize">
          <Maximize2 className={ICON} />
          Maximize
        </ContextMenuItem>
        <ContextMenuItem keybinding="terminal.watch">
          <Bell className={ICON} />
          Watch terminal
        </ContextMenuItem>
        <ContextMenuItem>
          <Copy className={ICON} />
          Insert reference
          <ContextMenuShortcut shortcut={INSERT_FILE_REFERENCE_COMBO} />
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

const HINT_ACTION = "preview.shortcutHint" as ActionId;
const realGetTitle = actionService.getTitle.bind(actionService);
actionService.getTitle = (id: ActionId) =>
  id === HINT_ACTION ? "Toggle sidebar" : realGetTitle(id);

function TooltipFixture() {
  useEffect(() => {
    if (fixture !== "tooltip") return;
    shortcutHintStore
      .getState()
      .show(HINT_ACTION, combo("nav.toggleSidebar"), { x: 40, y: 260, origin: "focus" });
    document.documentElement.dataset.hintRaised = "true";
  }, []);
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-20 p-6 pt-14">
        <Tooltip open>
          <TooltipTrigger asChild>
            <button type="button" className="w-24 text-xs text-text-secondary">
              Project
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" data-preview-surface>
            {createTooltipContent("Switch project", combo("project.switcherPalette"))}
          </TooltipContent>
        </Tooltip>
        <Tooltip open>
          <TooltipTrigger asChild>
            <button type="button" className="w-24 text-xs text-text-secondary">
              Settings
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {createTooltipContent("Settings", combo("app.settings"))}
          </TooltipContent>
        </Tooltip>
      </div>
      <ShortcutHint />
    </TooltipProvider>
  );
}

function InlineFixture() {
  const tipWithKey = TIPS.find((t) => t.id === "command-palette") ?? TIPS[0]!;
  return (
    <div className="flex flex-col gap-4 p-4 text-text-secondary" data-preview-surface>
      <section className="flex flex-col gap-1">
        <span className="text-3xs uppercase tracking-wider">Content grid tip (live)</span>
        <p className="text-xs">
          Tip: <LiveTipMessage tip={tipWithKey} />
        </p>
      </section>
      <section className="flex flex-col gap-1">
        <span className="text-3xs uppercase tracking-wider">
          Content grid tip (unbound fallback)
        </span>
        <p className="text-xs">Tip: {tipWithKey.message}</p>
      </section>
      <section className="flex flex-col gap-1 w-[420px] border border-border-subtle">
        <HelpIntroBanner onDismiss={() => {}} />
      </section>
      <section className="flex flex-col gap-1">
        <span className="text-3xs uppercase tracking-wider">Fleet picker keys</span>
        <PreviewFleetKeys />
      </section>
      <section className="flex flex-col gap-1">
        <span className="text-3xs uppercase tracking-wider">Settings search</span>
        <PreviewSettingsHints />
      </section>
    </div>
  );
}

/** Mirrors FleetPickerContent's help popover and the ribbon's exit / confirm keys. */
function PreviewFleetKeys() {
  return (
    <div className="flex flex-col gap-1.5 text-xs leading-[inherit] text-text-secondary">
      <span className="inline-flex items-center gap-1.5">
        <KbdChord shortcut="Cmd+A" />
        <span>Select all</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <KbdChord shortcut="Shift" />
        <span>+ click</span>
        <span>Range</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <KbdChord shortcut="Cmd+Shift+I" />
        <span>Invert</span>
      </span>
      <span className="inline-flex items-center gap-1.5 text-xs">
        <span>Exit</span>
        <KbdChord shortcut={FLEET_EXIT_COMBO} />
      </span>
      <span className="flex items-center gap-3 text-2xs">
        <span className="inline-flex items-center gap-1">
          <KbdChord shortcut="Enter" density="compact" /> to confirm
        </span>
        <span className="inline-flex items-center gap-1">
          <KbdChord shortcut="Escape" density="compact" /> to cancel
        </span>
      </span>
    </div>
  );
}

/** Mirrors SettingsDialog's search-results key hint. */
function PreviewSettingsHints() {
  return (
    <p className="shrink-0 whitespace-nowrap text-3xs text-text-secondary">
      <span className="inline-flex items-center gap-0.5 align-middle">
        <KbdChord shortcut="Up" density="compact" />
        <KbdChord shortcut="Down" density="compact" />
      </span>{" "}
      navigate <KbdChord shortcut="Enter" density="compact" className="align-middle" /> open
    </p>
  );
}

function Preview() {
  useEffect(() => {
    document.documentElement.dataset.previewReady = "true";
  }, []);
  return (
    <div
      className="relative bg-surface-canvas"
      style={{ width: "100vw", height: "100vh" }}
      data-platform={platform}
    >
      {fixture === "menu" && <MenuFixture />}
      {fixture === "context-menu" && <ContextMenuFixture />}
      {fixture === "tooltip" && <TooltipFixture />}
      {fixture === "inline" && <InlineFixture />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>
);
