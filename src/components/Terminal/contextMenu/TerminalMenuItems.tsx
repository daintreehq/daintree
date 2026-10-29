import type React from "react";
import { isMac } from "@/lib/platform";
import { revealCopy } from "@/components/FileViewer/revealCopy";
import {
  AGENT_SNOOZE_DURATION_OPTIONS,
  AGENT_SNOOZE_LABEL,
} from "@shared/utils/agentSnoozeDurations";
import { comboToAriaKeyshortcuts } from "@/lib/kbdShortcut";
import { terminalClipboardCombos } from "@/services/terminalReservedKeys";
import type { PtyPanelData } from "@shared/types/panel";
import type { WorktreeScope } from "@shared/utils/path";
import { terminalHasRunningAgentSession } from "@/utils/destructiveSessionConfirm";
import type { PluginPanelMenuItem } from "@/components/Panel/genericPanelMenu";
import { pluginMenuCommandId } from "@/components/Panel/genericPanelMenu";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  RestartOnPresetSubmenu,
  type RestartOnPresetRequest,
} from "@/components/Terminal/RestartOnPreset";
import { SelectedFileMenuItems } from "../SelectedFileMenuItems";
import { TerminalHandOverMenuItems } from "../TerminalHandOver";
import {
  ArrowDownFromLine,
  Bell,
  BellOff,
  Clipboard,
  Clock,
  Copy,
  CopyPlus,
  ExternalLink,
  Globe,
  Info,
  Lock,
  Mail,
  MailOpen,
  Mic,
  MicOff,
  OctagonX,
  Pencil,
  Play,
  Puzzle,
  Radio,
  RadioTower,
  RefreshCw,
  RotateCw,
  Send,
  Trash2,
  Unlock,
} from "lucide-react";
import { CirclePause, FolderOpen, FolderTree } from "@/components/icons";
import { ICON_CLASS, type MenuActionHandler } from "./menuShared";
import type { useFleetRunMenuState } from "./useFleetRunMenuState";

/** Copy, paste and what the pointer or the selection found in the output. */
export function TerminalSelectionMenuItems({
  hasSelection,
  hoveredUrl,
  hoveredUrlPluginName,
  hoveredFilePath,
  hoveredFileKind,
  hoveredFileScope,
  selectionFilePath,
  onSendToAgent,
  onOpenInFileBrowser,
  onAction,
}: {
  hasSelection: boolean;
  hoveredUrl: string | null;
  hoveredUrlPluginName: string | null;
  hoveredFilePath: string | null;
  hoveredFileKind: "file" | "directory" | null;
  hoveredFileScope: WorktreeScope | null;
  selectionFilePath: string | null;
  onSendToAgent: () => void;
  onOpenInFileBrowser: (
    scope: WorktreeScope,
    path: string,
    kind: "file" | "directory" | null
  ) => void;
  onAction: MenuActionHandler;
}) {
  const mac = isMac();
  const clipboardCombos = terminalClipboardCombos(mac);
  return (
    <>
      <ContextMenuItem
        disabled={!hasSelection}
        onSelect={() => onAction("copy")}
        aria-keyshortcuts={comboToAriaKeyshortcuts(clipboardCombos.copy, mac)}
      >
        <Copy className={ICON_CLASS} aria-hidden="true" />
        Copy
        <ContextMenuShortcut shortcut={clipboardCombos.copy} />
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => onAction("paste")}
        aria-keyshortcuts={comboToAriaKeyshortcuts(clipboardCombos.paste, mac)}
      >
        <Clipboard className={ICON_CLASS} aria-hidden="true" />
        Paste
        <ContextMenuShortcut shortcut={clipboardCombos.paste} />
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!hasSelection}
        onSelect={onSendToAgent}
        keybinding="terminal.sendToAgent"
      >
        <Send className={ICON_CLASS} aria-hidden="true" />
        Send to agent
      </ContextMenuItem>
      {hoveredUrl && (
        <>
          <ContextMenuSeparator />
          {hoveredUrlPluginName ? (
            <>
              <ContextMenuItem onSelect={() => onAction(`open-link-claimed:${hoveredUrl}`)}>
                <Puzzle className={ICON_CLASS} aria-hidden="true" />
                Open with {hoveredUrlPluginName}
              </ContextMenuItem>
              {/* A claimed URL still reaches the browser from here. */}
              <ContextMenuItem onSelect={() => onAction(`open-link-external:${hoveredUrl}`)}>
                <Globe className={ICON_CLASS} aria-hidden="true" />
                Open in external browser
              </ContextMenuItem>
            </>
          ) : (
            <ContextMenuItem onSelect={() => onAction("open-link")}>
              <ExternalLink className={ICON_CLASS} aria-hidden="true" />
              Open link
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => onAction(`copy-link:${hoveredUrl}`)}>
            <Copy className={ICON_CLASS} aria-hidden="true" />
            Copy link address
          </ContextMenuItem>
        </>
      )}
      {hoveredFilePath && (
        <>
          <ContextMenuSeparator />
          {hoveredFileScope && (
            <ContextMenuItem
              onSelect={() =>
                onOpenInFileBrowser(hoveredFileScope, hoveredFilePath, hoveredFileKind)
              }
            >
              <FolderTree className={ICON_CLASS} aria-hidden="true" />
              Open in file browser
            </ContextMenuItem>
          )}
          {/* Right-clicking a selected path usually hovers the same path,
                so its View file joins this group and one reveal serves both. */}
          {selectionFilePath === hoveredFilePath && (
            <SelectedFileMenuItems absolutePath={selectionFilePath} reveal={false} />
          )}
          <ContextMenuItem onSelect={() => onAction(`reveal-in-finder:${hoveredFilePath}`)}>
            <FolderOpen className={ICON_CLASS} aria-hidden="true" />
            {revealCopy().label}
          </ContextMenuItem>
        </>
      )}
      {selectionFilePath && selectionFilePath !== hoveredFilePath && (
        <>
          <ContextMenuSeparator />
          <SelectedFileMenuItems absolutePath={selectionFilePath} />
        </>
      )}
      <ContextMenuSeparator />
    </>
  );
}

/**
 * Fleet membership and the run's Pilot state. Parking follows the snapshot,
 * not broadcast eligibility: a docked or exited agent can still be parked, and
 * a parked one must always offer its inverse.
 */
export function TerminalFleetMenuItems({
  fleetEligible,
  isArmed,
  fleetSize,
  fleetRun,
  onRequestPark,
  onAction,
}: {
  fleetEligible: boolean;
  isArmed: boolean;
  fleetSize: number;
  fleetRun: ReturnType<typeof useFleetRunMenuState>;
  onRequestPark: () => void;
  onAction: MenuActionHandler;
}) {
  const {
    isKnownRun,
    isSnoozed,
    handBackState,
    isParked,
    canPark,
    handleSnooze,
    handleToggleHandBackRead,
    handleUnpark,
    handleUnsnooze,
  } = fleetRun;
  // One label whatever the state: the dialog's own title says whether it is a
  // new park or an edit. Unpark sits beside it only once there is a park to
  // lift — the discoverable inverse that lets parking skip a confirm.
  const parkItems =
    canPark || isParked ? (
      <>
        {canPark && (
          <ContextMenuItem onSelect={onRequestPark}>
            <CirclePause className={ICON_CLASS} aria-hidden="true" />
            Park…
          </ContextMenuItem>
        )}
        {isParked && (
          <ContextMenuItem onSelect={handleUnpark}>
            <Bell className={ICON_CLASS} aria-hidden="true" />
            Unpark
          </ContextMenuItem>
        )}
      </>
    ) : null;

  return (
    <>
      {!fleetEligible && parkItems !== null && (
        <>
          {parkItems}
          <ContextMenuSeparator />
        </>
      )}
      {fleetEligible && (
        <>
          <ContextMenuItem onSelect={() => onAction("fleet-toggle")}>
            {isArmed ? (
              <Radio className={ICON_CLASS} aria-hidden="true" />
            ) : (
              <RadioTower className={ICON_CLASS} aria-hidden="true" />
            )}
            {isArmed ? "Remove from fleet" : "Add to fleet"}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onAction("fleet-arm-worktree")}>
            <RadioTower className={ICON_CLASS} aria-hidden="true" />
            Arm all in this worktree
          </ContextMenuItem>
          {isArmed && fleetSize >= 2 && (
            <ContextMenuItem onSelect={() => onAction("fleet-clear")}>
              <Radio className={ICON_CLASS} aria-hidden="true" />
              Clear fleet
            </ContextMenuItem>
          )}
          {isKnownRun && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Clock className={ICON_CLASS} aria-hidden="true" />
                Snooze
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {AGENT_SNOOZE_DURATION_OPTIONS.map((option) => (
                  <ContextMenuItem key={option} onSelect={() => handleSnooze(option)}>
                    <Clock className={ICON_CLASS} aria-hidden="true" />
                    {AGENT_SNOOZE_LABEL[option]}
                  </ContextMenuItem>
                ))}
                {/* Only once there is something to lift. An always-present
                    "Wake now" would be a no-op the user has to read past on
                    every run that was never snoozed. */}
                {isSnoozed && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={handleUnsnooze}>
                      <Bell className={ICON_CLASS} aria-hidden="true" />
                      Wake now
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          {parkItems}
          {handBackState !== "none" && (
            <ContextMenuItem onSelect={handleToggleHandBackRead}>
              {handBackState === "unseen" ? (
                <MailOpen className={ICON_CLASS} aria-hidden="true" />
              ) : (
                <Mail className={ICON_CLASS} aria-hidden="true" />
              )}
              {handBackState === "unseen" ? "Mark as read" : "Mark as unread"}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
        </>
      )}
    </>
  );
}

/** The session itself: redraw, restart, input, dictation, watch and hand-over. */
export function TerminalSessionMenuItems({
  terminalId,
  terminalPty,
  hasPty,
  isHibernated,
  isPaused,
  isInputLocked,
  isVoiceLockedHere,
  canDictateHere,
  liveRecentVoiceTargets,
  detectedAgentId,
  isWatched,
  orchestratorCandidateIds,
  onRequestHandOver,
  onRequestRestartOnPreset,
  onAction,
}: {
  terminalId: string;
  terminalPty: PtyPanelData | undefined;
  hasPty: boolean;
  isHibernated: boolean;
  isPaused: boolean;
  isInputLocked: boolean | undefined;
  isVoiceLockedHere: boolean;
  /** The pane has a composer to dictate into, so it can be taken as the lock (#14955). */
  canDictateHere: boolean;
  liveRecentVoiceTargets: ReadonlyArray<{ panelId: string; label: string }>;
  detectedAgentId: string | undefined;
  isWatched: boolean;
  orchestratorCandidateIds: readonly string[];
  onRequestHandOver: (orchestratorPaneId: string) => void;
  onRequestRestartOnPreset: (request: RestartOnPresetRequest) => void;
  onAction: MenuActionHandler;
}) {
  return (
    <>
      {hasPty && (
        <ContextMenuItem disabled={isHibernated} onSelect={() => onAction("redraw")}>
          <RefreshCw className={ICON_CLASS} aria-hidden="true" />
          Redraw terminal
        </ContextMenuItem>
      )}
      {hasPty && (
        <ContextMenuItem onSelect={() => onAction("restart")}>
          <RotateCw className={ICON_CLASS} aria-hidden="true" />
          Restart terminal
        </ContextMenuItem>
      )}
      {terminalPty?.launchAgentId && !terminalPty.restoreRecovery && (
        <RestartOnPresetSubmenu
          agentId={terminalPty.launchAgentId}
          currentPresetId={terminalPty.agentPresetId}
          onPick={(preset) =>
            onRequestRestartOnPreset({
              terminalId,
              terminalTitle: terminalPty.title,
              agentWorking: terminalHasRunningAgentSession(terminalPty),
              preset,
            })
          }
        />
      )}
      {isPaused && (
        <ContextMenuItem onSelect={() => onAction("force-resume")}>
          <Play className={ICON_CLASS} aria-hidden="true" />
          Force resume (paused)
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => onAction("toggle-input-lock")}>
        {isInputLocked ? (
          <Unlock className={ICON_CLASS} aria-hidden="true" />
        ) : (
          <Lock className={ICON_CLASS} aria-hidden="true" />
        )}
        {isInputLocked ? "Unlock input" : "Lock input"}
      </ContextMenuItem>
      {(isVoiceLockedHere || canDictateHere) && (
        <ContextMenuItem
          onSelect={() => onAction(isVoiceLockedHere ? "voice-unlock-target" : "voice-lock-target")}
        >
          {isVoiceLockedHere ? (
            <MicOff className={ICON_CLASS} aria-hidden="true" />
          ) : (
            <Mic className={ICON_CLASS} aria-hidden="true" />
          )}
          {isVoiceLockedHere ? "Unlock dictation" : "Lock dictation to this panel"}
        </ContextMenuItem>
      )}
      {hasPty && liveRecentVoiceTargets.length > 0 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Mic className={ICON_CLASS} aria-hidden="true" />
            Recent dictation targets
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {liveRecentVoiceTargets.map((target) => (
              <ContextMenuItem
                key={target.panelId}
                onSelect={() => onAction(`recall-voice-target:${target.panelId}`)}
              >
                <Mic className={ICON_CLASS} aria-hidden="true" />
                {target.label}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {detectedAgentId && (
        <ContextMenuItem onSelect={() => onAction("toggle-watch")} keybinding="terminal.watch">
          {isWatched ? (
            <BellOff className={ICON_CLASS} aria-hidden="true" />
          ) : (
            <Bell className={ICON_CLASS} aria-hidden="true" />
          )}
          {isWatched ? "Cancel watch" : "Watch terminal"}
        </ContextMenuItem>
      )}
      {hasPty && (
        <TerminalHandOverMenuItems
          terminalId={terminalId}
          candidateIds={orchestratorCandidateIds}
          onRequestHandOver={onRequestHandOver}
        />
      )}
    </>
  );
}

/** Naming and lifetime: duplicate, rename, the kind's own entries, trash and kill. */
export function TerminalIdentityMenuItems({
  canDuplicate,
  pluginMenuItems,
  kindOwnedItems,
  isBackgrounded,
  onAction,
}: {
  canDuplicate: boolean;
  pluginMenuItems: readonly PluginPanelMenuItem[];
  /** The kind's tour and its plugin's own entries, after its `menu` items. */
  kindOwnedItems: React.ReactNode;
  isBackgrounded: boolean;
  onAction: MenuActionHandler;
}) {
  return (
    <>
      {/* A PTY-backed plugin kind has no duplicate recipe. */}
      {canDuplicate && (
        <ContextMenuItem onSelect={() => onAction("duplicate")}>
          <CopyPlus className={ICON_CLASS} aria-hidden="true" />
          Duplicate terminal
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => onAction("rename")}>
        <Pencil className={ICON_CLASS} aria-hidden="true" />
        Rename terminal
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onAction("view-info")}>
        <Info className={ICON_CLASS} aria-hidden="true" />
        View terminal info
      </ContextMenuItem>
      {/* A PTY-backed plugin kind's own entries, above its tour and
              settings as on the generic list (#13213). */}
      {pluginMenuItems.map((item) => (
        <ContextMenuItem
          key={item.actionId}
          onSelect={() => onAction(pluginMenuCommandId(item.actionId))}
        >
          <Puzzle className={ICON_CLASS} aria-hidden="true" />
          {item.label}
        </ContextMenuItem>
      ))}
      {kindOwnedItems}
      {!isBackgrounded && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => onAction("background")}>
            <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
            Send to background
          </ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onAction("trash")}>
        <Trash2 className={ICON_CLASS} aria-hidden="true" />
        Trash terminal
      </ContextMenuItem>
      <ContextMenuItem destructive onSelect={() => onAction("kill")}>
        <OctagonX className={ICON_CLASS} aria-hidden="true" />
        Kill terminal
      </ContextMenuItem>
    </>
  );
}
