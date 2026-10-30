import { useCallback, useState } from "react";
import type React from "react";
import { usePanelStore } from "@/store";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import {
  collectEligibleIds,
  useFleetArmingStore,
  isFleetArmEligible,
} from "@/store/fleetArmingStore";
import { isValidBrowserUrl } from "@/components/Browser/browserUtils";
import { actionService } from "@/services/ActionService";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";
import {
  consultPanelCloseGuards,
  hasPanelCloseGuard,
  isPanelClosePending,
} from "@/services/panelCloseGuard";
import { isBrowserPanel } from "@shared/types/panel";
import { peek as peekTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import type { TerminalLink } from "@/services/terminal/types";
import { cleanTerminalSelection } from "@/services/terminal/cleanTerminalCopy";
import type { WorktreeScope } from "@shared/utils/path";
import { closeAndAnnounce } from "@/lib/accessibility";
import { terminalHasRunningAgentSession } from "@/utils/destructiveSessionConfirm";
import {
  buildKillRunningAgentCopy,
  buildRestartRunningAgentCopy,
  type DestructiveConfirmCopy,
} from "@/components/Terminal/TerminalDestructiveActionConfirmDialog";
import type { MenuActionSourceValue } from "@/components/ui/menu-source";
import {
  GENERIC_PANEL_RELOAD_ACTION_ID,
  GENERIC_PANEL_TOUR_ACTION_ID,
  GENERIC_PANEL_PLUGIN_SETTINGS_ACTION_ID,
  GENERIC_PANEL_PLUGIN_BACKUP_ACTION_ID,
  isPluginMenuCommandId,
  pluginMenuCommandActionId,
  readPanelKindMenuCapabilities,
} from "@/components/Panel/genericPanelMenu";
import { copyWithToast } from "@/lib/copyWithToast";
import type { MenuPanel, PendingMenuDispatch } from "./menuShared";
import {
  activateCapturedLink,
  openTerminalPathInFileBrowser,
  runTerminalOutputMenuAction,
} from "./terminalOutputMenuActions";

export type DestructiveConfirmRequest = { kind: "kill" | "restart" } & DestructiveConfirmCopy;

interface TerminalMenuCommandsOptions {
  /** The panel the menu was opened on, never the focused one. */
  terminal: MenuPanel | undefined;
  terminalId: string;
  panelKindRegistry: Readonly<Record<string, PanelKindConfig>>;
  registeredTourIds: ReadonlySet<string>;
  sourceRef: React.RefObject<MenuActionSourceValue>;
  /** The link the menu opened on: the live hover is gone by the time an item is chosen. */
  hoveredLinkRef: React.RefObject<TerminalLink | null>;
  /** Runs an action once the menu has closed and focus is back on the pane. */
  deferMenuDispatch: (dispatch: PendingMenuDispatch) => void;
  /** Keeps the menu's close from handing focus back (Rename takes it). */
  suppressNextCloseAutoFocus: () => void;
}

/**
 * The context menu's command router: every id an item picks resolves against
 * the captured panel and goes through `ActionService`, or the local confirm
 * when a running agent session would be lost.
 */
export function useTerminalMenuCommands({
  terminal,
  terminalId,
  panelKindRegistry,
  registeredTourIds,
  sourceRef,
  hoveredLinkRef,
  deferMenuDispatch,
  suppressNextCloseAutoFocus,
}: TerminalMenuCommandsOptions) {
  // Local confirm dialog for single-terminal kill/restart when an agent
  // session is mid-work. Bare PTY terminals skip this gate and run
  // immediately (matches the action's run-body gate at
  // `terminalLifecycleActions.ts`).
  const [destructiveConfirm, setDestructiveConfirm] = useState<DestructiveConfirmRequest | null>(
    null
  );
  const terminalBrowser = terminal && isBrowserPanel(terminal) ? terminal : undefined;

  const handleAction = useCallback(
    (actionId: string) => {
      if (!terminal) return;

      if (
        runTerminalOutputMenuAction(
          actionId,
          {
            openHoveredLink: () => {
              if (hoveredLinkRef.current) activateCapturedLink(hoveredLinkRef.current);
            },
            openLink: (...args) => peekTerminalService()?.openLink(terminalId, ...args),
          },
          sourceRef.current
        )
      ) {
        return;
      }

      if (isPluginMenuCommandId(actionId)) {
        // The panel the menu was opened on, by id — see `deferMenuDispatch`.
        deferMenuDispatch({
          actionId: pluginMenuCommandActionId(actionId),
          args: { panelId: terminalId },
          source: sourceRef.current,
        });
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

      if (actionId.startsWith("recall-voice-target:")) {
        const targetPanelId = actionId.slice("recall-voice-target:".length);
        void actionService.dispatch(
          "voiceInput.recallRecentTarget",
          { panelId: targetPanelId },
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
          // This panel's worktree, which a sidebar row can offer while another
          // worktree is active; `terminal.bulkCommand` arms the active one.
          if (terminal?.worktreeId) {
            useFleetArmingStore
              .getState()
              .armIds(collectEligibleIds("current", terminal.worktreeId));
          } else {
            void actionService.dispatch("terminal.bulkCommand", undefined, {
              source: sourceRef.current,
            });
          }
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
        case "copy-clean": {
          const managed = peekTerminalService()?.get(terminalId);
          if (!managed?.terminal) break;
          const text = cleanTerminalSelection(managed.terminal, managed.commandLinksDisposable);
          if (text) copyWithToast("Selection", text);
          break;
        }
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
              ...buildRestartRunningAgentCopy(terminal?.title),
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
        case "voice-lock-target":
          void actionService.dispatch(
            "voiceInput.lockTarget",
            { panelId: terminalId },
            { source: sourceRef.current }
          );
          break;
        case "voice-unlock-target":
          void actionService.dispatch("voiceInput.unlockTarget", undefined, {
            source: sourceRef.current,
          });
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
          suppressNextCloseAutoFocus();
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
        case "restore-from-background": {
          // What the Background popover row's own Restore does: bring the
          // pane back and take the user to it, worktree switch included.
          const worktreeId = terminal?.worktreeId?.trim();
          const selection = useWorktreeSelectionStore.getState();
          if (worktreeId && worktreeId !== selection.activeWorktreeId) {
            selection.trackTerminalFocus(worktreeId, terminalId);
            selection.selectWorktree(worktreeId);
          }
          const panels = usePanelStore.getState();
          panels.restoreBackgroundTerminal(terminalId);
          panels.activateTerminal(terminalId);
          panels.pingTerminal(terminalId);
          break;
        }
        case "background":
          void actionService.dispatch(
            "terminal.background",
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
            setDestructiveConfirm({ kind: "kill", ...buildKillRunningAgentCopy(terminal?.title) });
            return;
          }
          if (hasPanelCloseGuard(terminalId)) {
            // Removing skips the trash, not the unsaved-work prompt (#12323). A
            // second pick while that prompt is up waits on it; it must not
            // queue a second removal behind the same answer.
            if (isPanelClosePending(terminalId)) return;
            const source = sourceRef.current;
            void consultPanelCloseGuards([terminalId]).then((proceed) => {
              if (!proceed) return;
              void actionService.dispatch("terminal.kill", { terminalId }, { source });
            });
            return;
          }
          void actionService.dispatch(
            "terminal.kill",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "reload":
          void actionService.dispatch(
            GENERIC_PANEL_RELOAD_ACTION_ID,
            { panelId: terminalId },
            { source: sourceRef.current }
          );
          break;
        case "tour": {
          const tour = readPanelKindMenuCapabilities(
            panelKindRegistry,
            terminal.pluginPanelKindId ?? terminal.kind ?? "terminal",
            registeredTourIds
          ).tour;
          if (!tour) break;
          void actionService.dispatch(
            GENERIC_PANEL_TOUR_ACTION_ID,
            { tourId: tour.id },
            { source: sourceRef.current }
          );
          break;
        }
        case "plugin-settings": {
          const pluginId = readPanelKindMenuCapabilities(
            panelKindRegistry,
            terminal.pluginPanelKindId ?? terminal.kind ?? "terminal",
            registeredTourIds
          ).pluginSettingsId;
          if (!pluginId) break;
          // Spent by the close hook once focus is back on the pane — see
          // `deferMenuDispatch`.
          deferMenuDispatch({
            actionId: GENERIC_PANEL_PLUGIN_SETTINGS_ACTION_ID,
            args: { pluginId },
            source: sourceRef.current,
          });
          break;
        }
        case "plugin-backup": {
          const pluginId = readPanelKindMenuCapabilities(
            panelKindRegistry,
            terminal.pluginPanelKindId ?? terminal.kind ?? "terminal",
            registeredTourIds
          ).pluginBackupId;
          if (!pluginId) break;
          deferMenuDispatch({
            actionId: GENERIC_PANEL_PLUGIN_BACKUP_ACTION_ID,
            args: { pluginId },
            source: sourceRef.current,
          });
          break;
        }
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
            const url = terminalBrowser.browserUrl;
            const source = sourceRef.current;
            copyWithToast("URL", url, {
              write: async () =>
                (await actionService.dispatch("browser.copyUrl", { url }, { source })).ok,
            });
          }
          break;
      }
    },
    [
      terminal,
      terminalId,
      terminalBrowser,
      panelKindRegistry,
      registeredTourIds,
      sourceRef,
      hoveredLinkRef,
      deferMenuDispatch,
      suppressNextCloseAutoFocus,
    ]
  );

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
    closeAndAnnounce(() => setDestructiveConfirm(null), announcement);
  }, [destructiveConfirm, terminalId, sourceRef]);

  const closeDestructiveConfirm = useCallback(() => {
    setDestructiveConfirm(null);
  }, []);

  const handleSendToAgent = useCallback(() => {
    void actionService.dispatch(
      "terminal.sendToAgent",
      { terminalId },
      { source: sourceRef.current }
    );
  }, [terminalId, sourceRef]);

  const handleMoveToNewWorktree = useCallback(() => {
    void actionService.dispatch(
      "terminal.moveToNewWorktree",
      { terminalId },
      { source: sourceRef.current }
    );
  }, [terminalId, sourceRef]);

  const handleOpenInFileBrowser = useCallback(
    (scope: WorktreeScope, path: string, kind: "file" | "directory" | null) =>
      openTerminalPathInFileBrowser(scope, path, kind, sourceRef.current),
    [sourceRef]
  );

  return {
    handleAction,
    handleSendToAgent,
    handleMoveToNewWorktree,
    handleOpenInFileBrowser,
    destructiveConfirm,
    handleDestructiveConfirm,
    closeDestructiveConfirm,
  };
}
