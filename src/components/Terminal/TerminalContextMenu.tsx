import { useCallback, useMemo } from "react";
import type React from "react";
import { type MenuItemOption, type TerminalLocation, type TerminalType } from "@/types";
import { useTerminalStore } from "@/store";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useNativeContextMenu } from "@/hooks";
import { AGENT_IDS, getAgentConfig } from "@/config/agents";
import { isValidBrowserUrl } from "@/components/Browser/browserUtils";
import { actionService } from "@/services/ActionService";

interface TerminalContextMenuProps {
  terminalId: string;
  children: React.ReactNode;
  forceLocation?: TerminalLocation;
}

/**
 * Right-click context menu for terminal components.
 * Used by both DockedTerminalItem and TerminalHeader.
 */
export function TerminalContextMenu({
  terminalId,
  children,
  forceLocation,
}: TerminalContextMenuProps) {
  const { showMenu } = useNativeContextMenu();
  const terminal = useTerminalStore((state) => state.terminals.find((t) => t.id === terminalId));
  const isMaximized = useTerminalStore((s) => s.maximizedId === terminalId);
  const { worktrees } = useWorktrees();

  const isPaused = terminal?.flowStatus === "paused-backpressure";

  const currentLocation: TerminalLocation = forceLocation ?? terminal?.location ?? "grid";

  const worktreeSubmenu = useMemo((): MenuItemOption[] => {
    if (!terminal) return [];
    return worktrees.map((wt) => {
      const isCurrent = wt.id === terminal.worktreeId;
      const label = (wt.branch || wt.name).trim() || "Untitled worktree";
      return {
        id: `move-to-worktree:${wt.id}`,
        label,
        enabled: !isCurrent,
      };
    });
  }, [terminal, worktrees]);

  const convertToSubmenu = useMemo((): MenuItemOption[] => {
    if (!terminal) return [];
    const currentAgentId =
      terminal.agentId ?? (terminal.type !== "terminal" ? terminal.type : null);
    const isPlainTerminal = terminal.type === "terminal" || terminal.kind === "terminal";

    const items: MenuItemOption[] = [];

    if (!isPlainTerminal || currentAgentId) {
      items.push({
        id: "convert-to:terminal",
        label: "Terminal",
        enabled: !isPlainTerminal || !!currentAgentId,
      });
    }

    for (const agentId of AGENT_IDS) {
      const config = getAgentConfig(agentId);
      if (!config) continue;
      const isCurrent = currentAgentId === agentId;
      items.push({
        id: `convert-to:${agentId}`,
        label: config.name,
        enabled: !isCurrent,
      });
    }

    return items;
  }, [terminal]);

  const template = useMemo((): MenuItemOption[] => {
    if (!terminal) return [];

    const isBrowser = terminal.kind === "browser";

    // Layout section: worktree navigation first (most common workflow), then positioning
    const layoutItems: MenuItemOption[] = [];

    // Move to Worktree as top-level submenu (when multiple worktrees exist)
    if (worktrees.length > 1 && worktreeSubmenu.length > 0) {
      layoutItems.push({
        id: "move-to-worktree",
        label: "Move to Worktree",
        submenu: worktreeSubmenu,
      });
    }

    layoutItems.push(
      currentLocation === "grid"
        ? { id: "move-to-dock", label: "Move to Dock" }
        : { id: "move-to-grid", label: "Move to Grid" }
    );

    if (currentLocation === "grid") {
      layoutItems.push({
        id: "toggle-maximize",
        label: isMaximized ? "Restore Size" : "Maximize",
        sublabel: "^⇧F",
      });
    }

    // Browser-specific actions
    if (isBrowser) {
      const browserActions: MenuItemOption[] = [
        { id: "reload-browser", label: "Reload Page" },
        { id: "open-external", label: "Open in Browser" },
        { id: "copy-url", label: "Copy URL" },
      ];

      const browserManagementItems: MenuItemOption[] = [
        { id: "duplicate", label: "Duplicate Browser" },
        { id: "rename", label: "Rename Browser" },
      ];

      const destructiveItems: MenuItemOption[] = [
        { id: "trash", label: "Close Browser" },
        { id: "kill", label: "Remove Browser" },
      ];

      return [
        ...layoutItems,
        { type: "separator" },
        ...browserActions,
        { type: "separator" },
        ...browserManagementItems,
        { type: "separator" },
        ...destructiveItems,
      ];
    }

    // Terminal actions section
    const terminalActions: MenuItemOption[] = [
      { id: "restart", label: "Restart Terminal" },
      ...(isPaused ? [{ id: "force-resume", label: "Force Resume (Paused)" }] : []),
      {
        id: "toggle-input-lock",
        label: terminal.isInputLocked ? "Unlock Input" : "Lock Input",
      },
      ...(convertToSubmenu.length > 0
        ? [
            {
              id: "convert-to",
              label: "Convert to",
              submenu: convertToSubmenu,
            },
          ]
        : []),
    ];

    // Management actions section
    const managementItems: MenuItemOption[] = [
      { id: "duplicate", label: "Duplicate Terminal" },
      { id: "rename", label: "Rename Terminal" },
      { id: "view-info", label: "View Terminal Info" },
    ];

    // Destructive actions section
    const destructiveItems: MenuItemOption[] = [
      { id: "trash", label: "Trash Terminal" },
      { id: "kill", label: "Kill Terminal" },
    ];

    return [
      ...layoutItems,
      { type: "separator" },
      ...terminalActions,
      { type: "separator" },
      ...managementItems,
      { type: "separator" },
      ...destructiveItems,
    ];
  }, [
    currentLocation,
    isMaximized,
    isPaused,
    terminal,
    worktrees.length,
    worktreeSubmenu,
    convertToSubmenu,
  ]);

  const handleContextMenu = useCallback(
    async (event: React.MouseEvent) => {
      if (!terminal) return;
      const actionId = await showMenu(event, template);
      if (!actionId) return;

      if (actionId.startsWith("move-to-worktree:")) {
        const worktreeId = actionId.slice("move-to-worktree:".length);
        const result = await actionService.dispatch(
          "terminal.moveToWorktree",
          { terminalId, worktreeId },
          { source: "context-menu" }
        );
        if (!result.ok) {
          console.error("Failed to move terminal to worktree:", result.error);
        }
        return;
      }

      if (actionId.startsWith("convert-to:")) {
        const targetType = actionId.slice("convert-to:".length);
        if (targetType === "terminal" || AGENT_IDS.includes(targetType)) {
          const result = await actionService.dispatch(
            "terminal.convertType",
            { terminalId, type: targetType as TerminalType },
            { source: "context-menu" }
          );
          if (!result.ok) {
            console.error("Failed to convert terminal type:", result.error);
          }
        }
        return;
      }

      if (actionId === "move-to-worktree" || actionId === "convert-to") {
        return;
      }

      switch (actionId) {
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
        case "view-info":
          void actionService.dispatch(
            "terminal.viewInfo",
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
        // Browser-specific actions
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
    [showMenu, terminal, template, terminalId]
  );

  return (
    <div onContextMenu={handleContextMenu} className="contents">
      {children}
    </div>
  );
}
