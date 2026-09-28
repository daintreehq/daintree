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
import { Kbd } from "../Kbd";
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

/** A menu shortcut slot fed by its callers' source for the action's binding. */
function MenuSlot({ actionId }: { actionId: string }) {
  const shortcut = keybindingService.getDisplayCombo(actionId);
  return shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null;
}

function ContextSlot({ actionId }: { actionId: string }) {
  const shortcut = keybindingService.getDisplayCombo(actionId);
  return shortcut ? <ContextMenuShortcut>{shortcut}</ContextMenuShortcut> : null;
}

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
          <DropdownMenuItem>
            <Sparkles className={ICON} />
            <span className="flex-1">Claude</span>
            <MenuSlot actionId="agent.claude" />
          </DropdownMenuItem>
          <DropdownMenuItem>
            <SquareTerminal className={ICON} />
            <span className="flex-1">Terminal</span>
            <MenuSlot actionId="agent.terminal" />
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Copy className={ICON} />
            <span className="flex-1">Copy context</span>
            <MenuSlot actionId="worktree.copyTree" />
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Command className={ICON} />
            <span className="flex-1">Command palette</span>
            <MenuSlot actionId="action.palette.open" />
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Settings className={ICON} />
            <span className="flex-1">Settings</span>
            <MenuSlot actionId="app.settings" />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem>
            <Archive className={ICON} />
            Archive
            <DropdownMenuShortcut aria-hidden="true">E</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled>
            <Bell className={ICON} />
            <span className="flex-1">Notifications (disabled)</span>
            <MenuSlot actionId="notifications.toggle" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ContextMenuFixture() {
  const mac = isMac();
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
          <ContextMenuShortcut>{mac ? "⌘" : "Ctrl"}C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem>
          <Clipboard className={ICON} />
          Paste
          <ContextMenuShortcut>{mac ? "⌘V" : "Ctrl+⇧V"}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem>
          <Send className={ICON} />
          Send to agent
          <ContextMenuShortcut>{mac ? "⌘⇧E" : "Ctrl+⇧E"}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem>
          <Maximize2 className={ICON} />
          Maximize
          <ContextMenuShortcut>^⇧F</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem>
          <Bell className={ICON} />
          Watch terminal
          <ContextMenuShortcut>{mac ? "⌘⇧W" : "Ctrl+⇧W"}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem>
          <Copy className={ICON} />
          Insert reference
          <ContextMenuShortcut>{mac ? "⌘I" : "Ctrl+I"}</ContextMenuShortcut>
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
            Switch project ({keybindingService.getDisplayCombo("project.switcherPalette")})
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
        <span className="text-3xs uppercase tracking-wider">Content grid tip (unbound fallback)</span>
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

function PreviewFleetKeys() {
  return (
    <div className="flex flex-col gap-1.5 text-xs leading-[inherit] text-text-secondary">
      <span className="inline-flex items-center gap-1">
        <Kbd>{isMac() ? "⌘A" : "Ctrl+A"}</Kbd>
        <span>Select all</span>
      </span>
      <span className="inline-flex items-center gap-1">
        <Kbd>Shift</Kbd>+<Kbd>Click</Kbd>
        <span>Range</span>
      </span>
      <span className="inline-flex items-center gap-1">
        <Kbd>{isMac() ? "⌘⇧I" : "Ctrl+Shift+I"}</Kbd>
        <span>Invert</span>
      </span>
      <span className="inline-flex items-center gap-1.5 text-xs">
        <span>Exit</span>
        <Kbd>{isMac() ? "⌘Esc" : "Ctrl+Esc"}</Kbd>
      </span>
    </div>
  );
}

function PreviewSettingsHints() {
  return (
    <p className="shrink-0 whitespace-nowrap text-3xs text-text-secondary">
      <kbd className="settings-kbd px-1 py-0.5 rounded-sm border font-mono">↑↓</kbd> navigate{" "}
      <kbd className="settings-kbd px-1 py-0.5 rounded-sm border font-mono">↵</kbd> open
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
