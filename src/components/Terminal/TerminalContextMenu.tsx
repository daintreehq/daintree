import { useCallback, useMemo, useState } from "react";
import { isMac } from "@/lib/platform";
import type React from "react";
import { type PanelLocation } from "@/types";
import { usePanelStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useFleetArmingStore, isFleetArmEligible } from "@/store/fleetArmingStore";
import { isValidBrowserUrl } from "@/components/Browser/browserUtils";
import { actionService } from "@/services/ActionService";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import {
  ArrowDownFromLine,
  Bell,
  BellOff,
  Clipboard,
  Copy,
  CopyPlus,
  ExternalLink,
  Globe,
  Link,
  Lock,
  Maximize2,
  Minimize2,
  OctagonX,
  Pencil,
  Play,
  Radio,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  Unlock,
} from "lucide-react";
import { MoveToDockIcon, MoveToGridIcon, WorktreeIcon } from "@/components/icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const ICON_CLASS = "w-3.5 h-3.5 mr-2 shrink-0";

interface TerminalContextMenuProps {
  terminalId: string;
  children: React.ReactNode;
  forceLocation?: PanelLocation;
}

/**
 * Right-click context menu for panel headers (terminal, agent, browser, dev-preview).
 * Used by both DockedTerminalItem and PanelHeader.
 */
export function TerminalContextMenu({
  terminalId,
  children,
  forceLocation,
}: TerminalContextMenuProps) {
  const terminal = usePanelStore(useShallow((state) => state.panelsById[terminalId]));
  const maximizeTarget = usePanelStore((s) => s.maximizeTarget);
  const getPanelGroup = usePanelStore((s) => s.getPanelGroup);

  const isMaximized = useMemo(() => {
    if (!maximizeTarget) return false;
    if (maximizeTarget.type === "panel") {
      return maximizeTarget.id === terminalId;
    } else {
      const group = getPanelGroup(terminalId);
      return group?.id === maximizeTarget.id;
    }
  }, [maximizeTarget, terminalId, getPanelGroup]);

  const { worktrees } = useWorktrees();

  const isWatched = usePanelStore((state) => state.watchedPanels.has(terminalId));
  const isArmed = useFleetArmingStore((s) => s.armedIds.has(terminalId));
  const fleetSize = useFleetArmingStore((s) => s.armedIds.size);
  // Pull the panel directly here (rather than indexing through the shallow
  // selector above) so the eligibility check sees the live record. The
  // dropdown only renders fleet items when the panel is fleet-arm-eligible
  // — non-agent terminals, trashed/backgrounded panels, and PTY-less panels
  // don't get the option, matching the gesture-level rules in
  // `multiSelectGestures`.
  const fleetEligible = isFleetArmEligible(terminal);

  const [hasSelection, setHasSelection] = useState(false);
  const [hoveredUrl, setHoveredUrl] = useState<string | null>(null);

  const handleContextMenu = useCallback(
    (_e: React.MouseEvent) => {
      const managed = terminalInstanceService.get(terminalId);
      if (!managed?.terminal) {
        setHasSelection(false);
        setHoveredUrl(null);
        return;
      }
      const selection = managed.terminal.getSelection();
      setHasSelection(!!selection);
      setHoveredUrl(terminalInstanceService.getHoveredLinkText(terminalId));
    },
    [terminalId]
  );

  const isPaused = terminal?.flowStatus === "paused-backpressure";

  const currentLocation: PanelLocation = forceLocation ?? terminal?.location ?? "grid";

  const mac = isMac();
  const modifierKey = mac ? "⌘" : "Ctrl";

  const handleAction = useCallback(
    (actionId: string) => {
      if (!terminal) return;

      if (actionId === "open-link") {
        terminalInstanceService.openHoveredLink(terminalId);
        return;
      }

      if (actionId.startsWith("copy-link:")) {
        const url = actionId.slice("copy-link:".length);
        void actionService.dispatch("terminal.copyLink", { url }, { source: "context-menu" });
        return;
      }

      if (actionId.startsWith("move-to-worktree:")) {
        const worktreeId = actionId.slice("move-to-worktree:".length);
        void actionService.dispatch(
          "terminal.moveToWorktree",
          { terminalId, worktreeId },
          { source: "context-menu" }
        );
        return;
      }

      switch (actionId) {
        case "fleet-toggle":
          // Mirror the gesture rule from multiSelectGestures: a toggle on
          // an empty fleet implicitly seeds the focused pane so the user
          // ends up with a 2-pane fleet rather than a single armed peer.
          if (
            !useFleetArmingStore.getState().armedIds.has(terminalId) &&
            useFleetArmingStore.getState().armedIds.size === 0
          ) {
            const focusedId = usePanelStore.getState().focusedId;
            if (focusedId && focusedId !== terminalId) {
              const focusedTerminal = usePanelStore.getState().panelsById[focusedId];
              if (focusedTerminal && isFleetArmEligible(focusedTerminal)) {
                useFleetArmingStore.getState().armId(focusedId);
              }
            }
          }
          useFleetArmingStore.getState().toggleId(terminalId);
          break;
        case "fleet-arm-worktree":
          void actionService.dispatch("terminal.bulkCommand", undefined, {
            source: "context-menu",
          });
          break;
        case "fleet-clear":
          void actionService.dispatch("terminal.disarmAll", undefined, {
            source: "context-menu",
          });
          break;
        case "copy":
          void actionService.dispatch("terminal.copy", { terminalId }, { source: "context-menu" });
          break;
        case "paste":
          void actionService.dispatch("terminal.paste", { terminalId }, { source: "context-menu" });
          break;
        case "move-to-dock":
          void actionService.dispatch(
            "terminal.moveToDock",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "move-to-grid":
          void actionService.dispatch(
            "terminal.moveToGrid",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "toggle-maximize":
          void actionService.dispatch(
            "terminal.toggleMaximize",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "restart":
          void actionService.dispatch(
            "terminal.restart",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "force-resume":
          void actionService.dispatch(
            "terminal.forceResume",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "toggle-input-lock":
          void actionService.dispatch(
            "terminal.toggleInputLock",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "toggle-watch":
          void actionService.dispatch("terminal.watch", { terminalId }, { source: "context-menu" });
          break;
        case "duplicate":
          void actionService.dispatch(
            "terminal.duplicate",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "rename":
          void actionService.dispatch(
            "terminal.rename",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "background":
          void actionService.dispatch(
            "terminal.background",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "trash":
          void actionService.dispatch("terminal.trash", { terminalId }, { source: "context-menu" });
          break;
        case "kill":
          void actionService.dispatch("terminal.kill", { terminalId }, { source: "context-menu" });
          break;
        case "reload-browser":
          void actionService.dispatch("browser.reload", { terminalId }, { source: "context-menu" });
          break;
        case "open-external":
          if (terminal.browserUrl && isValidBrowserUrl(terminal.browserUrl)) {
            void actionService.dispatch(
              "browser.openExternal",
              { url: terminal.browserUrl },
              { source: "context-menu" }
            );
          }
          break;
        case "copy-url":
          if (terminal.browserUrl && isValidBrowserUrl(terminal.browserUrl)) {
            void actionService.dispatch(
              "browser.copyUrl",
              { url: terminal.browserUrl },
              { source: "context-menu" }
            );
          }
          break;
      }
    },
    [terminal, terminalId]
  );

  if (!terminal) {
    return <div className="contents">{children}</div>;
  }

  const isBrowser = terminal.kind === "browser";
  const isDevPreview = terminal.kind === "dev-preview";
  const hasPty = terminal.kind ? panelKindHasPty(terminal.kind) : true;

  const layoutSection = (
    <>
      {worktrees.length > 1 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <WorktreeIcon className={ICON_CLASS} />
            Move to Worktree
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {worktrees.map((wt) => {
              const isCurrent = wt.id === terminal.worktreeId;
              const label =
                (wt.isMainWorktree ? wt.name : wt.branch || wt.name).trim() || "Untitled worktree";
              return (
                <ContextMenuItem
                  key={wt.id}
                  disabled={isCurrent}
                  onSelect={() => handleAction(`move-to-worktree:${wt.id}`)}
                >
                  <WorktreeIcon className={ICON_CLASS} />
                  {label}
                </ContextMenuItem>
              );
            })}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {terminal.launchAgentId && (
        <ContextMenuItem
          onSelect={() =>
            void actionService.dispatch(
              "terminal.moveToNewWorktree",
              { terminalId },
              { source: "context-menu" }
            )
          }
        >
          <WorktreeIcon className={ICON_CLASS} />
          Move to New Worktree…
        </ContextMenuItem>
      )}
      <ContextMenuItem
        onSelect={() => handleAction(currentLocation === "grid" ? "move-to-dock" : "move-to-grid")}
      >
        {currentLocation === "grid" ? (
          <MoveToDockIcon className={ICON_CLASS} />
        ) : (
          <MoveToGridIcon className={ICON_CLASS} />
        )}
        {currentLocation === "grid" ? "Move to Dock" : "Move to Grid"}
      </ContextMenuItem>
      {currentLocation === "grid" && (
        <ContextMenuItem onSelect={() => handleAction("toggle-maximize")}>
          {isMaximized ? (
            <Minimize2 className={ICON_CLASS} aria-hidden="true" />
          ) : (
            <Maximize2 className={ICON_CLASS} aria-hidden="true" />
          )}
          {isMaximized ? "Restore Size" : "Maximize"}
          <ContextMenuShortcut>^⇧F</ContextMenuShortcut>
        </ContextMenuItem>
      )}
    </>
  );

  if (isBrowser) {
    const hasUrl = Boolean(terminal.browserUrl && isValidBrowserUrl(terminal.browserUrl));
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="contents" data-context-trigger={terminalId}>
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {layoutSection}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("reload-browser")}>
            <RefreshCw className={ICON_CLASS} aria-hidden="true" />
            Reload Page
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasUrl} onSelect={() => handleAction("open-external")}>
            <Globe className={ICON_CLASS} aria-hidden="true" />
            Open in Browser
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasUrl} onSelect={() => handleAction("copy-url")}>
            <Link className={ICON_CLASS} aria-hidden="true" />
            Copy URL
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("duplicate")}>
            <CopyPlus className={ICON_CLASS} aria-hidden="true" />
            Duplicate Browser
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("rename")}>
            <Pencil className={ICON_CLASS} aria-hidden="true" />
            Rename Browser
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("background")}>
            <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
            Send to Background
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("trash")}>
            <Trash2 className={ICON_CLASS} aria-hidden="true" />
            Close Browser
          </ContextMenuItem>
          <ContextMenuItem destructive onSelect={() => handleAction("kill")}>
            <OctagonX className={ICON_CLASS} aria-hidden="true" />
            Remove Browser
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  if (isDevPreview) {
    const hasUrl = Boolean(terminal.browserUrl && isValidBrowserUrl(terminal.browserUrl));
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="contents" data-context-trigger={terminalId}>
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {layoutSection}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("reload-browser")}>
            <RefreshCw className={ICON_CLASS} aria-hidden="true" />
            Reload Preview
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasUrl} onSelect={() => handleAction("open-external")}>
            <Globe className={ICON_CLASS} aria-hidden="true" />
            Open in Browser
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasUrl} onSelect={() => handleAction("copy-url")}>
            <Link className={ICON_CLASS} aria-hidden="true" />
            Copy URL
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("duplicate")}>
            <CopyPlus className={ICON_CLASS} aria-hidden="true" />
            Duplicate Dev Preview
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("rename")}>
            <Pencil className={ICON_CLASS} aria-hidden="true" />
            Rename Dev Preview
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("background")}>
            <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
            Send to Background
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("trash")}>
            <Trash2 className={ICON_CLASS} aria-hidden="true" />
            Close Dev Preview
          </ContextMenuItem>
          <ContextMenuItem destructive onSelect={() => handleAction("kill")}>
            <OctagonX className={ICON_CLASS} aria-hidden="true" />
            Stop Dev Server
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="contents"
          data-context-trigger={terminalId}
          onContextMenu={handleContextMenu}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {hasPty && (
          <>
            <ContextMenuItem disabled={!hasSelection} onSelect={() => handleAction("copy")}>
              <Copy className={ICON_CLASS} aria-hidden="true" />
              Copy
              <ContextMenuShortcut>{modifierKey}C</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => handleAction("paste")}>
              <Clipboard className={ICON_CLASS} aria-hidden="true" />
              Paste
              <ContextMenuShortcut>{mac ? `${modifierKey}V` : "Ctrl+⇧V"}</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!hasSelection}
              onSelect={() =>
                void actionService.dispatch(
                  "terminal.sendToAgent",
                  { terminalId },
                  { source: "context-menu" }
                )
              }
            >
              <Send className={ICON_CLASS} aria-hidden="true" />
              Send to Agent
              <ContextMenuShortcut>{mac ? "⌘⇧E" : "Ctrl+⇧E"}</ContextMenuShortcut>
            </ContextMenuItem>
            {hoveredUrl && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => handleAction("open-link")}>
                  <ExternalLink className={ICON_CLASS} aria-hidden="true" />
                  Open Link
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => handleAction(`copy-link:${hoveredUrl}`)}>
                  <Link className={ICON_CLASS} aria-hidden="true" />
                  Copy Link Address
                </ContextMenuItem>
              </>
            )}
            <ContextMenuSeparator />
          </>
        )}
        {fleetEligible && (
          <>
            <ContextMenuItem onSelect={() => handleAction("fleet-toggle")}>
              {isArmed ? (
                <Radio className={ICON_CLASS} aria-hidden="true" />
              ) : (
                <RadioTower className={ICON_CLASS} aria-hidden="true" />
              )}
              {isArmed ? "Remove from Fleet" : "Add to Fleet"}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => handleAction("fleet-arm-worktree")}>
              <RadioTower className={ICON_CLASS} aria-hidden="true" />
              Arm All in This Worktree
            </ContextMenuItem>
            {isArmed && fleetSize >= 2 && (
              <ContextMenuItem destructive onSelect={() => handleAction("fleet-clear")}>
                <Radio className={ICON_CLASS} aria-hidden="true" />
                Clear Fleet
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
          </>
        )}
        {layoutSection}
        <ContextMenuSeparator />
        {hasPty && (
          <ContextMenuItem onSelect={() => handleAction("restart")}>
            <RotateCcw className={ICON_CLASS} aria-hidden="true" />
            Restart Terminal
          </ContextMenuItem>
        )}
        {isPaused && (
          <ContextMenuItem onSelect={() => handleAction("force-resume")}>
            <Play className={ICON_CLASS} aria-hidden="true" />
            Force Resume (Paused)
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => handleAction("toggle-input-lock")}>
          {terminal.isInputLocked ? (
            <Unlock className={ICON_CLASS} aria-hidden="true" />
          ) : (
            <Lock className={ICON_CLASS} aria-hidden="true" />
          )}
          {terminal.isInputLocked ? "Unlock Input" : "Lock Input"}
        </ContextMenuItem>
        {terminal.detectedAgentId && (
          <ContextMenuItem onSelect={() => handleAction("toggle-watch")}>
            {isWatched ? (
              <BellOff className={ICON_CLASS} aria-hidden="true" />
            ) : (
              <Bell className={ICON_CLASS} aria-hidden="true" />
            )}
            {isWatched ? "Cancel Watch" : "Watch Terminal"}
            <ContextMenuShortcut>{mac ? "⌘⇧W" : "Ctrl+⇧W"}</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handleAction("duplicate")}>
          <CopyPlus className={ICON_CLASS} aria-hidden="true" />
          Duplicate Terminal
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handleAction("rename")}>
          <Pencil className={ICON_CLASS} aria-hidden="true" />
          Rename Terminal
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handleAction("background")}>
          <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
          Send to Background
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handleAction("trash")}>
          <Trash2 className={ICON_CLASS} aria-hidden="true" />
          Trash Terminal
        </ContextMenuItem>
        <ContextMenuItem destructive onSelect={() => handleAction("kill")}>
          <OctagonX className={ICON_CLASS} aria-hidden="true" />
          Kill Terminal
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
