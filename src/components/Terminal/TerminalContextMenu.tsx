import { useCallback, useMemo, useRef, useState } from "react";
import { isMac } from "@/lib/platform";
import type React from "react";
import { type PanelLocation } from "@/types";
import { usePanelStore } from "@/store";

import { useWorktrees } from "@/hooks/useWorktrees";
import { useFleetArmingStore, isFleetArmEligible } from "@/store/fleetArmingStore";
import { isValidBrowserUrl } from "@/components/Browser/browserUtils";
import { actionService } from "@/services/ActionService";
import { usePluginMenuItems } from "@/hooks/usePluginMenuItems";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { isBrowserPanel, isDevPreviewPanel, isPtyPanel, isReviewPanel } from "@shared/types/panel";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useIsHibernated } from "@/hooks/useIsHibernated";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { terminalHasRunningAgentSession } from "@/utils/destructiveSessionConfirm";
import {
  ArrowDownFromLine,
  Bell,
  BellOff,
  Clipboard,
  Copy,
  CopyPlus,
  ExternalLink,
  Globe,
  Info,
  Link,
  Lock,
  Maximize2,
  Minimize2,
  Moon,
  OctagonX,
  PanelBottomClose,
  PanelTopClose,
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
import { FolderGit2 } from "@/components/icons";
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
import { MenuActionSourceContext, type MenuActionSourceValue } from "@/components/ui/menu-source";

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
  const terminal = usePanelStore((state) => state.panelsById[terminalId]);
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
  const isHibernated = useIsHibernated(terminalId);
  // Plugin-contributed items for the terminal context menu. Pulled on mount and
  // kept in sync via push; empty until a plugin contributes a `"terminal"` item.
  const pluginTerminalItems = usePluginMenuItems("terminal");
  // Pull the panel directly here (rather than indexing through the shallow
  // selector above) so the eligibility check sees the live record. The
  // dropdown only renders fleet items when the panel is fleet-arm-eligible
  // — non-agent terminals, trashed/backgrounded panels, and PTY-less panels
  // don't get the option, matching the gesture-level rules in
  // `multiSelectGestures`.
  const fleetEligible = isFleetArmEligible(terminal);
  const sourceRef = useRef<MenuActionSourceValue>("user");

  const [hasSelection, setHasSelection] = useState(false);
  const [hoveredUrl, setHoveredUrl] = useState<string | null>(null);
  const suppressNextCloseAutoFocusRef = useRef(false);
  // Local confirm dialog for single-terminal kill/restart when an agent
  // session is mid-work. Bare PTY terminals skip this gate and run
  // immediately (matches the action's run-body gate at
  // `terminalLifecycleActions.ts`).
  const [destructiveConfirm, setDestructiveConfirm] = useState<{
    kind: "kill" | "restart";
    title: string;
    description: string;
    confirmLabel: string;
  } | null>(null);

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

  const terminalPty = terminal && isPtyPanel(terminal) ? terminal : undefined;
  const terminalBrowser = terminal && isBrowserPanel(terminal) ? terminal : undefined;
  const isPaused =
    terminalPty?.flowStatus === "paused-backpressure" ||
    terminalPty?.flowStatus === "paused-resource-governor";

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
        void actionService.dispatch("terminal.copyLink", { url }, { source: sourceRef.current });
        return;
      }

      if (actionId.startsWith("move-to-worktree:")) {
        const worktreeId = actionId.slice("move-to-worktree:".length);
        void actionService.dispatch(
          "terminal.moveToWorktree",
          { terminalId, worktreeId },
          { source: sourceRef.current }
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
            source: sourceRef.current,
          });
          break;
        case "fleet-clear":
          void actionService.dispatch("terminal.disarmAll", undefined, {
            source: sourceRef.current,
          });
          break;
        case "copy":
          void actionService.dispatch(
            "terminal.copy",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "paste":
          void actionService.dispatch(
            "terminal.paste",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "move-to-dock":
          void actionService.dispatch(
            "terminal.moveToDock",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "move-to-grid":
          void actionService.dispatch(
            "terminal.moveToGrid",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "toggle-maximize":
          void actionService.dispatch(
            "terminal.toggleMaximize",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "redraw":
          void actionService.dispatch(
            "terminal.redraw",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "restart":
          if (terminalHasRunningAgentSession(terminal)) {
            setDestructiveConfirm({
              kind: "restart",
              title: "Restart terminal with running agent?",
              description:
                "An agent is mid-work in this terminal. Restarting respawns the process and discards its scrollback. The current agent session will be interrupted.",
              confirmLabel: "Restart terminal",
            });
            return;
          }
          void actionService.dispatch(
            "terminal.restart",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "force-resume":
          void actionService.dispatch(
            "terminal.forceResume",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "toggle-input-lock":
          void actionService.dispatch(
            "terminal.toggleInputLock",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "toggle-watch":
          void actionService.dispatch(
            "terminal.watch",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "duplicate":
          void actionService.dispatch(
            "terminal.duplicate",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "rename":
          suppressNextCloseAutoFocusRef.current = true;
          void actionService.dispatch(
            "terminal.rename",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "view-info":
          void actionService.dispatch(
            "terminal.viewInfo",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "background":
          void actionService.dispatch(
            "terminal.background",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "hibernate":
          void actionService.dispatch(
            "terminal.hibernate",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "trash":
          void actionService.dispatch(
            "terminal.trash",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "kill":
          if (terminalHasRunningAgentSession(terminal)) {
            setDestructiveConfirm({
              kind: "kill",
              title: "Kill terminal with running agent?",
              description:
                "An agent is mid-work in this terminal. Killing it stops the agent and discards its scrollback. The PTY process and any unsaved output will be lost.",
              confirmLabel: "Kill terminal",
            });
            return;
          }
          void actionService.dispatch(
            "terminal.kill",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "reload-browser":
          void actionService.dispatch(
            "browser.reload",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "open-external":
          if (terminalBrowser?.browserUrl && isValidBrowserUrl(terminalBrowser.browserUrl)) {
            void actionService.dispatch(
              "browser.openExternal",
              { url: terminalBrowser.browserUrl },
              { source: sourceRef.current }
            );
          }
          break;
        case "copy-url":
          if (terminalBrowser?.browserUrl && isValidBrowserUrl(terminalBrowser.browserUrl)) {
            void actionService.dispatch(
              "browser.copyUrl",
              { url: terminalBrowser.browserUrl },
              { source: sourceRef.current }
            );
          }
          break;
      }
    },
    [terminal, terminalId, terminalPty, terminalBrowser]
  );

  const handleCloseAutoFocus = useCallback((event: Event) => {
    if (!suppressNextCloseAutoFocusRef.current) return;
    suppressNextCloseAutoFocusRef.current = false;
    event.preventDefault();
  }, []);

  const handleDestructiveConfirm = useCallback(() => {
    if (!destructiveConfirm) return;
    const actionId = destructiveConfirm.kind === "kill" ? "terminal.kill" : "terminal.restart";
    const announcement =
      destructiveConfirm.kind === "kill" ? "Terminal killed" : "Terminal restarted";
    void actionService.dispatch(
      actionId,
      { terminalId, confirmed: true },
      { source: sourceRef.current }
    );
    // Close the dialog first so the announce fires after focus returns to the
    // main tree — VoiceOver suppresses live-region updates from outside the
    // current modal subtree while focus is trapped.
    setDestructiveConfirm(null);
    useAnnouncerStore.getState().announce(announcement);
  }, [destructiveConfirm, terminalId]);

  const closeDestructiveConfirm = useCallback(() => {
    setDestructiveConfirm(null);
  }, []);

  const destructiveConfirmDialog = destructiveConfirm ? (
    <ConfirmDialog
      isOpen
      onClose={closeDestructiveConfirm}
      title={destructiveConfirm.title}
      description={destructiveConfirm.description}
      confirmLabel={destructiveConfirm.confirmLabel}
      variant="destructive"
      onConfirm={handleDestructiveConfirm}
    />
  ) : null;

  if (!terminal) {
    return <div className="contents">{children}</div>;
  }

  const isBrowser = isBrowserPanel(terminal);
  const isDevPreview = isDevPreviewPanel(terminal);
  const isReview = isReviewPanel(terminal);
  const hasPty = terminal.kind ? panelKindHasPty(terminal.kind) : true;

  const layoutSection = (
    <>
      {worktrees.length > 1 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderGit2 className={ICON_CLASS} />
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
                  <FolderGit2 className={ICON_CLASS} />
                  {label}
                </ContextMenuItem>
              );
            })}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {terminalPty?.launchAgentId && (
        <ContextMenuItem
          onSelect={() =>
            void actionService.dispatch(
              "terminal.moveToNewWorktree",
              { terminalId },
              { source: sourceRef.current }
            )
          }
        >
          <FolderGit2 className={ICON_CLASS} />
          Move to New Worktree…
        </ContextMenuItem>
      )}
      <ContextMenuItem
        onSelect={() => handleAction(currentLocation === "grid" ? "move-to-dock" : "move-to-grid")}
      >
        {currentLocation === "grid" ? (
          <PanelBottomClose className={ICON_CLASS} />
        ) : (
          <PanelTopClose className={ICON_CLASS} />
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
          {isMaximized ? "Restore" : "Maximize"}
          <ContextMenuShortcut>^⇧F</ContextMenuShortcut>
        </ContextMenuItem>
      )}
    </>
  );

  if (isBrowser) {
    const hasUrl = Boolean(terminal.browserUrl && isValidBrowserUrl(terminal.browserUrl));
    return (
      <ContextMenu>
        <MenuActionSourceContext.Consumer>
          {(value) => {
            sourceRef.current = value ?? "user";
            return null;
          }}
        </MenuActionSourceContext.Consumer>
        <ContextMenuTrigger asChild>
          <div className="contents" data-context-trigger={terminalId}>
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={handleCloseAutoFocus}>
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
        <MenuActionSourceContext.Consumer>
          {(value) => {
            sourceRef.current = value ?? "user";
            return null;
          }}
        </MenuActionSourceContext.Consumer>
        <ContextMenuTrigger asChild>
          <div className="contents" data-context-trigger={terminalId}>
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={handleCloseAutoFocus}>
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

  if (isReview) {
    return (
      <ContextMenu>
        <MenuActionSourceContext.Consumer>
          {(value) => {
            sourceRef.current = value ?? "user";
            return null;
          }}
        </MenuActionSourceContext.Consumer>
        <ContextMenuTrigger asChild>
          <div className="contents" data-context-trigger={terminalId}>
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={handleCloseAutoFocus}>
          {layoutSection}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("duplicate")}>
            <CopyPlus className={ICON_CLASS} aria-hidden="true" />
            Duplicate Review
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("rename")}>
            <Pencil className={ICON_CLASS} aria-hidden="true" />
            Rename Review
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("background")}>
            <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
            Send to Background
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("trash")}>
            <Trash2 className={ICON_CLASS} aria-hidden="true" />
            Close Review
          </ContextMenuItem>
          <ContextMenuItem destructive onSelect={() => handleAction("kill")}>
            <OctagonX className={ICON_CLASS} aria-hidden="true" />
            Remove Review
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  return (
    <>
      {destructiveConfirmDialog}
      <ContextMenu>
        <MenuActionSourceContext.Consumer>
          {(value) => {
            sourceRef.current = value ?? "user";
            return null;
          }}
        </MenuActionSourceContext.Consumer>
        <ContextMenuTrigger asChild>
          <div
            className="contents"
            data-context-trigger={terminalId}
            onContextMenu={handleContextMenu}
          >
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={handleCloseAutoFocus}>
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
                    { source: sourceRef.current }
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
            <ContextMenuItem disabled={isHibernated} onSelect={() => handleAction("redraw")}>
              <RefreshCw className={ICON_CLASS} aria-hidden="true" />
              Redraw Terminal
            </ContextMenuItem>
          )}
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
          <ContextMenuItem onSelect={() => handleAction("view-info")}>
            <Info className={ICON_CLASS} aria-hidden="true" />
            View Terminal Info
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("background")}>
            <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
            Send to Background
          </ContextMenuItem>
          {hasPty && (
            <ContextMenuItem
              disabled={isHibernated || terminalHasRunningAgentSession(terminal)}
              onSelect={() => handleAction("hibernate")}
            >
              <Moon className={ICON_CLASS} aria-hidden="true" />
              Sleep Terminal
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => handleAction("trash")}>
            <Trash2 className={ICON_CLASS} aria-hidden="true" />
            Trash Terminal
          </ContextMenuItem>
          <ContextMenuItem destructive onSelect={() => handleAction("kill")}>
            <OctagonX className={ICON_CLASS} aria-hidden="true" />
            Kill Terminal
          </ContextMenuItem>
          {pluginTerminalItems.length > 0 && (
            <>
              <ContextMenuSeparator />
              {pluginTerminalItems.map(({ pluginId, item }) => (
                <ContextMenuItem
                  key={`${pluginId}:${item.actionId}:${item.label}`}
                  onSelect={() =>
                    void actionService.dispatch(item.actionId, undefined, {
                      source: sourceRef.current,
                    })
                  }
                >
                  {item.label}
                </ContextMenuItem>
              ))}
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </>
  );
}
