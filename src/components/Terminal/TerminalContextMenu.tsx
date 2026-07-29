import { useCallback, useMemo, useRef, useState } from "react";
import { isMac, isWindows } from "@/lib/platform";
import type React from "react";
import { type PanelLocation } from "@/types";
import { usePanelStore } from "@/store";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

import { useWorktrees } from "@/hooks/useWorktrees";
import { useFleetArmingStore, isFleetArmEligible } from "@/store/fleetArmingStore";
import { isValidBrowserUrl } from "@/components/Browser/browserUtils";
import { actionService } from "@/services/ActionService";
import { panelKindHasPty, panelKindIsDockable } from "@shared/config/panelKindRegistry";
import {
  isBrowserPanel,
  isDevPreviewPanel,
  isDiffPanel,
  isFileBrowserPanel,
  isFilePanel,
  isPtyPanel,
  isReviewPanel,
} from "@shared/types/panel";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { reportFileLinkFailure } from "@/services/terminal/FileLinksAddon";
import { resolveSelectedFilePath } from "@/services/terminal/filePathDetection";
import { resolveWorktreePathScope } from "@shared/utils/path";
import { SelectedFileMenuItems } from "./SelectedFileMenuItems";
import { useIsHibernated } from "@/hooks/useIsHibernated";
import { usePluginContextMenuItems } from "@/hooks/usePluginContextMenuItems";
import { PluginContextMenuSection } from "@/components/Plugin/PluginContextMenuSection";
import type { WhenClauseContext } from "@shared/utils/whenClause";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { closeAndAnnounce } from "@/lib/accessibility";
import { terminalHasRunningAgentSession } from "@/utils/destructiveSessionConfirm";
import { KILL_RUNNING_AGENT_DIALOG_COPY } from "@/components/Terminal/TerminalDestructiveActionConfirmDialog";
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
  Mic,
  MicOff,
  Minimize2,
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
import { FolderGit2, FolderOpen, FolderTree } from "@/components/icons";
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
  const isVoiceLockedHere = useVoiceRecordingStore((s) => s.lockedTarget?.panelId === terminalId);
  const recentVoiceTargets = useVoiceRecordingStore((s) => s.recentTargets);
  // Pull the panel directly here (rather than indexing through the shallow
  // selector above) so the eligibility check sees the live record. The
  // dropdown only renders fleet items when the panel is fleet-arm-eligible
  // — non-agent terminals, trashed/backgrounded panels, and PTY-less panels
  // don't get the option, matching the gesture-level rules in
  // `multiSelectGestures`.
  const fleetEligible = isFleetArmEligible(terminal);
  const sourceRef = useRef<MenuActionSourceValue>("user");

  const pluginMenuContext = useMemo<WhenClauseContext>(
    () => ({ panelId: terminalId, panelKind: terminal?.kind }),
    [terminalId, terminal?.kind]
  );
  const pluginItems = usePluginContextMenuItems("terminal", pluginMenuContext);

  const [hasSelection, setHasSelection] = useState(false);
  const [hoveredUrl, setHoveredUrl] = useState<string | null>(null);
  const [hoveredFilePath, setHoveredFilePath] = useState<string | null>(null);
  const [hoveredFileKind, setHoveredFileKind] = useState<"file" | "directory" | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
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

  // Recent dictation targets surfaced in the context menu must resolve to a
  // live, non-trashed PTY panel that isn't the current one. Persisted entries
  // come back without a panelId (stripped on rehydrate) — we try to match each
  // to a live panel by (worktreeId + panelTitle) so cross-session recall works
  // when the user reopens with the same worktree layout. Entries that can't
  // be resolved are hidden rather than shown as dead links. Resolved at
  // menu-open time via getState() so the wrapper doesn't re-render on every
  // panel-store write.
  const [liveRecentVoiceTargets, setLiveRecentVoiceTargets] = useState<
    Array<{ panelId: string; label: string }>
  >([]);

  const handleContextMenu = useCallback(
    (_e: React.MouseEvent) => {
      const { panelsById } = usePanelStore.getState();
      const resolved: Array<{ panelId: string; label: string }> = [];
      const seenIds = new Set<string>([terminalId]);
      for (const t of recentVoiceTargets) {
        let livePanelId: string | undefined;
        if (t.panelId) {
          const panel = panelsById[t.panelId];
          if (panel && panel.location !== "trash") livePanelId = t.panelId;
        } else if (t.worktreeId && t.panelTitle) {
          const titleMatch = Object.values(panelsById).find(
            (panel) =>
              panel.worktreeId === t.worktreeId &&
              panel.title === t.panelTitle &&
              panel.location !== "trash"
          );
          if (titleMatch) livePanelId = titleMatch.id;
        }
        if (!livePanelId || seenIds.has(livePanelId)) continue;
        seenIds.add(livePanelId);
        const label =
          t.panelTitle?.trim() ||
          t.worktreeLabel?.trim() ||
          t.projectName?.trim() ||
          "Untitled panel";
        resolved.push({ panelId: livePanelId, label });
      }
      setLiveRecentVoiceTargets(resolved);

      const managed = terminalInstanceService.get(terminalId);
      if (!managed?.terminal) {
        setHasSelection(false);
        setHoveredUrl(null);
        setHoveredFilePath(null);
        setHoveredFileKind(null);
        setSelectedText(null);
        return;
      }
      // Read the selection synchronously here — xterm clears it on the next
      // forwarded keystroke (#7649), so a deferred read would see nothing.
      const selection = managed.terminal.getSelection();
      setHasSelection(!!selection);
      setSelectedText(selection || null);
      setHoveredUrl(terminalInstanceService.getHoveredLinkText(terminalId));
      setHoveredFilePath(terminalInstanceService.getHoveredFilePath(terminalId));
      setHoveredFileKind(terminalInstanceService.getHoveredFileKind(terminalId));
    },
    [terminalId, recentVoiceTargets]
  );

  const terminalPty = terminal && isPtyPanel(terminal) ? terminal : undefined;
  const terminalBrowser = terminal && isBrowserPanel(terminal) ? terminal : undefined;

  // A selection that resolves to a file path unlocks the "View file" / "Open
  // folder" section. Relative paths resolve against the terminal's cwd;
  // absolute selections resolve without one (empty cwd is fine for those).
  const selectionFilePath = useMemo(
    () =>
      selectedText
        ? (resolveSelectedFilePath(selectedText, terminalPty?.cwd ?? "")?.absolutePath ?? null)
        : null,
    [selectedText, terminalPty?.cwd]
  );
  // Where the hovered path sits in the *live* worktree list — never
  // `terminal.worktreeId`, which stamps the worktree that was active when the
  // panel was created and can name one the path isn't in (#11276). null means
  // no known worktree contains it, and the file browser (worktree-scoped) has
  // nothing to show, so the item is hidden rather than dispatching a no-op.
  const hoveredFileScope = useMemo(
    () => (hoveredFilePath ? resolveWorktreePathScope(hoveredFilePath, worktrees) : null),
    [hoveredFilePath, worktrees]
  );

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
        void terminalInstanceService.openHoveredLink(terminalId);
        return;
      }

      if (actionId.startsWith("copy-link:")) {
        const url = actionId.slice("copy-link:".length);
        void actionService.dispatch("terminal.copyLink", { url }, { source: sourceRef.current });
        return;
      }

      if (actionId.startsWith("reveal-in-finder:")) {
        const path = actionId.slice("reveal-in-finder:".length);
        // Unlike copy-link, guard rejections (OUTSIDE_ROOT) and a since-deleted
        // file (NOT_FOUND) are real, expected failure modes here — surface them
        // rather than fire-and-forget. dispatch wraps the thrown error as
        // EXECUTION_ERROR, so the original coded error lives on `.details`.
        void actionService
          .dispatch("file.showItemInFolder", { path }, { source: sourceRef.current })
          .then((result) => {
            if (!result.ok) {
              reportFileLinkFailure("Failed to reveal in file manager", result.error.details, path);
            }
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
        case "trash":
          void actionService.dispatch(
            "terminal.trash",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "kill":
          if (terminalHasRunningAgentSession(terminal)) {
            setDestructiveConfirm({ kind: "kill", ...KILL_RUNNING_AGENT_DIALOG_COPY });
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
    closeAndAnnounce(() => setDestructiveConfirm(null), announcement);
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
  const isFile = isFilePanel(terminal);
  const isFileBrowser = isFileBrowserPanel(terminal);
  const isDiff = isDiffPanel(terminal);
  const hasPty = terminal.kind ? panelKindHasPty(terminal.kind) : true;
  // A non-PTY plugin kind matches none of the built-in guards, so without this
  // it falls through to the terminal menu and is offered "Duplicate terminal",
  // "Kill terminal", and friends — none of which apply (#11228). `pluginId` is
  // stamped at creation and survives the plugin going missing, which is why it
  // beats a registry lookup here. The `!hasPty` half is load-bearing: plugins
  // may also contribute PTY-backed kinds that render through TerminalPane and
  // are stamped with pluginId too (addPanel.ts) — those are genuine terminals
  // and must keep copy/paste, redraw, restart, and the rest of the PTY menu.
  const isPlugin = Boolean(terminal.pluginId) && !hasPty;

  const layoutSection = (
    <>
      {worktrees.length > 1 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderGit2 className={ICON_CLASS} />
            Move to worktree
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
          Move to new worktree…
        </ContextMenuItem>
      )}
      <ContextMenuItem
        // Move-to-grid is always safe; move-to-dock only for kinds the dock
        // renders (PTY + dockable non-PTY like file panels).
        disabled={currentLocation === "grid" && !panelKindIsDockable(terminal.kind ?? "terminal")}
        onSelect={() => handleAction(currentLocation === "grid" ? "move-to-dock" : "move-to-grid")}
      >
        {currentLocation === "grid" ? (
          <PanelBottomClose className={ICON_CLASS} />
        ) : (
          <PanelTopClose className={ICON_CLASS} />
        )}
        {currentLocation === "grid" ? "Move to dock" : "Move to grid"}
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
            Reload page
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasUrl} onSelect={() => handleAction("open-external")}>
            <Globe className={ICON_CLASS} aria-hidden="true" />
            Open in browser
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasUrl} onSelect={() => handleAction("copy-url")}>
            <Link className={ICON_CLASS} aria-hidden="true" />
            Copy URL
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("duplicate")}>
            <CopyPlus className={ICON_CLASS} aria-hidden="true" />
            Duplicate browser
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("rename")}>
            <Pencil className={ICON_CLASS} aria-hidden="true" />
            Rename browser
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("background")}>
            <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
            Send to background
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("trash")}>
            <Trash2 className={ICON_CLASS} aria-hidden="true" />
            Trash browser
          </ContextMenuItem>
          <ContextMenuItem destructive onSelect={() => handleAction("kill")}>
            <OctagonX className={ICON_CLASS} aria-hidden="true" />
            Remove browser
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
            Reload preview
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasUrl} onSelect={() => handleAction("open-external")}>
            <Globe className={ICON_CLASS} aria-hidden="true" />
            Open in browser
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasUrl} onSelect={() => handleAction("copy-url")}>
            <Link className={ICON_CLASS} aria-hidden="true" />
            Copy URL
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("duplicate")}>
            <CopyPlus className={ICON_CLASS} aria-hidden="true" />
            Duplicate dev preview
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("rename")}>
            <Pencil className={ICON_CLASS} aria-hidden="true" />
            Rename dev preview
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("background")}>
            <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
            Send to background
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("trash")}>
            <Trash2 className={ICON_CLASS} aria-hidden="true" />
            Trash dev preview
          </ContextMenuItem>
          <ContextMenuItem destructive onSelect={() => handleAction("kill")}>
            <OctagonX className={ICON_CLASS} aria-hidden="true" />
            Stop dev server
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
            Duplicate review
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("rename")}>
            <Pencil className={ICON_CLASS} aria-hidden="true" />
            Rename review
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("background")}>
            <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
            Send to background
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("trash")}>
            <Trash2 className={ICON_CLASS} aria-hidden="true" />
            Trash review
          </ContextMenuItem>
          <ContextMenuItem destructive onSelect={() => handleAction("kill")}>
            <OctagonX className={ICON_CLASS} aria-hidden="true" />
            Remove review
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  // Diff joins the file/plugin branch: all three are non-PTY reading surfaces
  // whose menu is the generic panel one. Without an early return here the PTY
  // menu below would narrow against DiffPanelData and lose `isInputLocked`.
  if (isFile || isFileBrowser || isDiff || isPlugin) {
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
          <ContextMenuItem onSelect={() => handleAction("rename")}>
            <Pencil className={ICON_CLASS} aria-hidden="true" />
            Rename panel
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("background")}>
            <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
            Send to background
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("trash")}>
            <Trash2 className={ICON_CLASS} aria-hidden="true" />
            Trash panel
          </ContextMenuItem>
          <ContextMenuItem destructive onSelect={() => handleAction("kill")}>
            <OctagonX className={ICON_CLASS} aria-hidden="true" />
            Remove panel
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
                Send to agent
                <ContextMenuShortcut>{mac ? "⌘⇧E" : "Ctrl+⇧E"}</ContextMenuShortcut>
              </ContextMenuItem>
              {hoveredUrl && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => handleAction("open-link")}>
                    <ExternalLink className={ICON_CLASS} aria-hidden="true" />
                    Open link
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => handleAction(`copy-link:${hoveredUrl}`)}>
                    <Link className={ICON_CLASS} aria-hidden="true" />
                    Copy link address
                  </ContextMenuItem>
                </>
              )}
              {hoveredFilePath && (
                <>
                  <ContextMenuSeparator />
                  {hoveredFileScope && (
                    <ContextMenuItem
                      onSelect={() => {
                        void actionService
                          .dispatch(
                            "worktree.openFileBrowser",
                            {
                              worktreeId: hoveredFileScope.worktreeId,
                              revealPath: hoveredFileScope.relativePath || undefined,
                              // Carried through rather than assumed: a
                              // directory is expanded as well as selected, so
                              // guessing "file" would leave a right-clicked
                              // folder collapsed while left-clicking the same
                              // link opens it.
                              revealKind: hoveredFileKind ?? "file",
                            },
                            { source: sourceRef.current }
                          )
                          .then((result) => {
                            if (!result.ok) {
                              reportFileLinkFailure(
                                "Failed to open file browser",
                                result.error.details,
                                hoveredFilePath
                              );
                            }
                          });
                      }}
                    >
                      <FolderTree className={ICON_CLASS} aria-hidden="true" />
                      Open in file browser
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem
                    onSelect={() => handleAction(`reveal-in-finder:${hoveredFilePath}`)}
                  >
                    <FolderOpen className={ICON_CLASS} aria-hidden="true" />
                    {mac ? "Reveal in Finder" : isWindows() ? "Show in Explorer" : "Show in folder"}
                  </ContextMenuItem>
                </>
              )}
              {selectionFilePath && (
                <>
                  <ContextMenuSeparator />
                  <SelectedFileMenuItems absolutePath={selectionFilePath} />
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
                {isArmed ? "Remove from fleet" : "Add to fleet"}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => handleAction("fleet-arm-worktree")}>
                <RadioTower className={ICON_CLASS} aria-hidden="true" />
                Arm all in this worktree
              </ContextMenuItem>
              {isArmed && fleetSize >= 2 && (
                <ContextMenuItem destructive onSelect={() => handleAction("fleet-clear")}>
                  <Radio className={ICON_CLASS} aria-hidden="true" />
                  Clear fleet
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
              Redraw terminal
            </ContextMenuItem>
          )}
          {hasPty && (
            <ContextMenuItem onSelect={() => handleAction("restart")}>
              <RotateCcw className={ICON_CLASS} aria-hidden="true" />
              Restart terminal
            </ContextMenuItem>
          )}
          {isPaused && (
            <ContextMenuItem onSelect={() => handleAction("force-resume")}>
              <Play className={ICON_CLASS} aria-hidden="true" />
              Force resume (paused)
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => handleAction("toggle-input-lock")}>
            {terminal.isInputLocked ? (
              <Unlock className={ICON_CLASS} aria-hidden="true" />
            ) : (
              <Lock className={ICON_CLASS} aria-hidden="true" />
            )}
            {terminal.isInputLocked ? "Unlock input" : "Lock input"}
          </ContextMenuItem>
          {hasPty && (
            <ContextMenuItem
              onSelect={() =>
                handleAction(isVoiceLockedHere ? "voice-unlock-target" : "voice-lock-target")
              }
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
                    onSelect={() => handleAction(`recall-voice-target:${target.panelId}`)}
                  >
                    <Mic className={ICON_CLASS} aria-hidden="true" />
                    {target.label}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          {terminal.detectedAgentId && (
            <ContextMenuItem onSelect={() => handleAction("toggle-watch")}>
              {isWatched ? (
                <BellOff className={ICON_CLASS} aria-hidden="true" />
              ) : (
                <Bell className={ICON_CLASS} aria-hidden="true" />
              )}
              {isWatched ? "Cancel watch" : "Watch terminal"}
              <ContextMenuShortcut>{mac ? "⌘⇧W" : "Ctrl+⇧W"}</ContextMenuShortcut>
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("duplicate")}>
            <CopyPlus className={ICON_CLASS} aria-hidden="true" />
            Duplicate terminal
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("rename")}>
            <Pencil className={ICON_CLASS} aria-hidden="true" />
            Rename terminal
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("view-info")}>
            <Info className={ICON_CLASS} aria-hidden="true" />
            View terminal info
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("background")}>
            <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
            Send to background
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("trash")}>
            <Trash2 className={ICON_CLASS} aria-hidden="true" />
            Trash terminal
          </ContextMenuItem>
          <ContextMenuItem destructive onSelect={() => handleAction("kill")}>
            <OctagonX className={ICON_CLASS} aria-hidden="true" />
            Kill terminal
          </ContextMenuItem>
          <PluginContextMenuSection items={pluginItems} />
        </ContextMenuContent>
      </ContextMenu>
    </>
  );
}
