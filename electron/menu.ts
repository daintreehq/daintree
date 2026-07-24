import { Menu, dialog, BrowserWindow, app, webContents } from "electron";
import { randomUUID } from "node:crypto";
import { projectStore } from "./services/ProjectStore.js";
import { openExternalUrl } from "./utils/openExternal.js";
import { CHANNELS } from "./ipc/channels.js";
import { broadcastProjectSwitchUpdates } from "./ipc/projectSwitchBroadcast.js";
import { getEffectiveRegistry } from "../shared/config/agentRegistry.js";
import { isAssistantOnlyAgentId } from "../shared/config/agentIds.js";
import type { CliAvailabilityService } from "./services/CliAvailabilityService.js";
import { isAgentInstalled } from "../shared/utils/agentAvailability.js";
import * as CliInstallService from "./services/CliInstallService.js";
import * as FinderQuickActionService from "./services/FinderQuickActionService.js";
import { getWindowRegistry } from "./window/windowRef.js";
import { toggleWindowFullscreen } from "./window/fullscreen.js";
import {
  getPtyClient,
  getWorkspaceClientRef,
  getWorktreePortBrokerRef,
} from "./window/windowServices.js";
import { distributePortsToView } from "./window/portDistribution.js";
import type { UpdateMenuState } from "./services/AutoUpdaterService.js";
import { getAutoUpdaterServiceRef } from "./window/serviceRefs.js";
import { getPluginMenuItems } from "./services/pluginMenuRegistry.js";
import { evaluateWhen } from "./services/WhenClauseService.js";
import { getAppWebContents } from "./window/webContentsRegistry.js";
import { PROJECT_MENU_ITEM_IDS, resolveProjectIdForApplicationMenu } from "./projectMenuState.js";
import { PRODUCT_NAME, PRODUCT_WEBSITE, PRODUCT_COPYRIGHT_ORG } from "./utils/productBranding.js";
import { formatErrorMessage } from "../shared/utils/errorMessage.js";
import { isAppError } from "./utils/errorTypes.js";
import { isWindowsStoreBuild, getBuildChannelLabel } from "../shared/config/distribution.js";
import {
  getMenuAccelerator,
  isKeybindingOwnedAction,
  rendererMenuAccelerator,
  resetRendererOwnedAccelerators,
} from "./services/menuAccelerators.js";

// The About panel's build-version slot shows the release channel for
// prerelease builds (Nightly/Beta/RC) and stays blank for stable releases —
// an empty string suppresses the secondary line rather than falling back to
// CFBundleVersion (which would duplicate the version on macOS).
export function buildAboutPanelOptions(version: string): Electron.AboutPanelOptionsOptions {
  return {
    applicationName: PRODUCT_NAME,
    applicationVersion: version,
    version: getBuildChannelLabel(version) ?? "",
    copyright: `© ${new Date().getFullYear()} ${PRODUCT_COPYRIGHT_ORG}`,
    website: PRODUCT_WEBSITE,
  };
}

app.setAboutPanelOptions(buildAboutPanelOptions(app.getVersion()));

function convertShortcutToAccelerator(shortcut: string): string {
  return shortcut.replace("Cmd/Ctrl", "CommandOrControl");
}

// IDs are scoped to each platform branch — Electron's getMenuItemById walks
// the tree and returns the first match, so the macOS Daintree-menu copy and
// the Win/Linux Help-menu copy must be addressable independently.
const UPDATE_MENU_ITEM_IDS = ["check-for-updates-mac", "check-for-updates-help"] as const;

const UPDATE_MENU_STATE_LABELS: Record<UpdateMenuState, { label: string; enabled: boolean }> = {
  idle: { label: "Check for Updates…", enabled: true },
  checking: { label: "Checking…", enabled: false },
  ready: { label: "Restart to Install Update", enabled: true },
};

function applyUpdateMenuState(state: UpdateMenuState): void {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  const { label, enabled } = UPDATE_MENU_STATE_LABELS[state];
  for (const id of UPDATE_MENU_ITEM_IDS) {
    const item = menu.getMenuItemById(id);
    if (!item) continue;
    item.label = label;
    item.enabled = enabled;
  }
}

// MenuItem.click is baked at build time and is NOT live-mutable. The static
// handler reads the current state at invocation time and branches: Ready
// triggers quitAndInstall; everything else (Idle, Checking) initiates a
// manual check. Checking is also disabled, so the click only fires for the
// other two anyway. AutoUpdaterService is dynamically imported so the
// electron-updater module graph stays off the boot path; clicks before the
// deferred initialize() remain no-ops via the service's !initialized guard.
function handleUpdateMenuClick(): void {
  void import("./services/AutoUpdaterService.js")
    .then(({ autoUpdaterService }) => {
      if (autoUpdaterService.getMenuState() === "ready") {
        autoUpdaterService.quitAndInstallIfReady();
      } else {
        autoUpdaterService.checkForUpdatesManually();
      }
    })
    .catch((err) => console.error("[MAIN] Failed to load AutoUpdaterService for menu click:", err));
}

// Each createApplicationMenu rebuild allocates new MenuItem instances, so the
// listener must be re-registered after Menu.setApplicationMenu. We track the
// previous unsubscribe at module scope to avoid stacking listeners across
// rebuilds — a stale listener would mutate items that no longer exist.
let unsubscribeUpdateMenuState: (() => void) | null = null;

export function createApplicationMenu(
  mainWindow: BrowserWindow,
  cliAvailabilityService?: CliAvailabilityService
): void {
  // Accelerators for renderer-owned actions are derived from the effective
  // keybindings (defaults + user overrides) and collected into a suppression
  // set — see electron/services/menuAccelerators.ts. They stay natively
  // registered on every platform; before-input-event in app renderer contexts
  // suppresses their native dispatch per keystroke so the renderer's
  // KeybindingService owns keyboard execution there, while guest webviews and
  // DevTools (which app renderers never see keys from) fall back to native
  // execution instead of the shortcut going dead.
  resetRendererOwnedAccelerators();

  const getTargetBrowserWindow = (
    browserWindow: Electron.BaseWindow | undefined
  ): BrowserWindow | null => {
    if (browserWindow instanceof BrowserWindow && !browserWindow.isDestroyed()) {
      return browserWindow;
    }

    if (!mainWindow.isDestroyed()) {
      return mainWindow;
    }

    return null;
  };

  const sendAction = (actionId: string, target: BrowserWindow | null, args?: unknown) => {
    if (target && !target.isDestroyed()) {
      const wc = getAppWebContents(target);
      if (!wc.isDestroyed()) {
        try {
          wc.send(CHANNELS.MENU_ACTION, { actionId, args });
        } catch {
          // Silently ignore send failures during window disposal.
        }
      }
    }
  };

  const availability = cliAvailabilityService?.getAvailability();

  const buildAgentMenuItems = (): Electron.MenuItemConstructorOptions[] => {
    const items: Electron.MenuItemConstructorOptions[] = [];

    Object.values(getEffectiveRegistry()).forEach((agent) => {
      // Assistant-only agents are never offered as a launchable native menu item.
      if (isAssistantOnlyAgentId(agent.id)) return;
      if (isAgentInstalled(availability?.[agent.id])) {
        // Agents the keybinding system owns (a default row or user override
        // exists for agent.<id>) take their accelerator from the effective
        // bindings — including "none" when cleared or chord-bound; the
        // registry fallback would silently resurrect the old shortcut. Only
        // agents outside the keybinding system entirely use the registry's
        // shortcut field, natively registered and executing.
        const keybindingOwned = isKeybindingOwnedAction(`agent.${agent.id}`);
        items.push({
          label: `New ${agent.name}`,
          accelerator: keybindingOwned
            ? rendererMenuAccelerator(`agent.${agent.id}`)
            : agent.shortcut
              ? convertShortcutToAccelerator(agent.shortcut)
              : undefined,
          click: (_item, browserWindow) =>
            sendAction("agent.launch", getTargetBrowserWindow(browserWindow), {
              agentId: agent.id,
            }),
        });
      }
    });

    return items;
  };

  const buildPluginMenuItems = (location: string): Electron.MenuItemConstructorOptions[] => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    for (const { item } of getPluginMenuItems()) {
      if (item.location !== location) continue;
      if (!evaluateWhen(item.when, {})) continue;
      items.push({
        label: item.label,
        accelerator: item.accelerator ? convertShortcutToAccelerator(item.accelerator) : undefined,
        click: (_item, browserWindow) =>
          sendAction(item.actionId, getTargetBrowserWindow(browserWindow)),
      });
    }
    return items;
  };

  const agentMenuItems = buildAgentMenuItems();
  const filePluginItems = buildPluginMenuItems("file");
  const viewPluginItems = buildPluginMenuItems("view");
  const terminalPluginItems = buildPluginMenuItems("terminal");
  const helpPluginItems = buildPluginMenuItems("help");

  // Built BEFORE the gate is resolved: this reads getAllProjects(), which
  // repairs stale status rows as a side effect (a "closed" row that is still the
  // current pointer gets promoted back to "active"). Resolving first would snapshot
  // the gate from pre-repair rows and install a template the repair contradicts.
  const recentProjectsMenu = buildRecentProjectsMenu(
    getTargetBrowserWindow,
    cliAvailabilityService
  );

  // Same resolver the live refresh uses, so the cold build and every later
  // refresh agree on what "a project is open" means.
  const projectMenuEnabled = resolveProjectIdForApplicationMenu() !== null;

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Open Directory…",
          accelerator: "CommandOrControl+O",
          click: async (_item, browserWindow) => {
            const win = getTargetBrowserWindow(browserWindow);
            if (!win) return;
            const result = await dialog.showOpenDialog(win, {
              properties: ["openDirectory", "createDirectory"],
              title: "Open Git Repository",
            });

            if (!result.canceled && result.filePaths.length > 0) {
              const directoryPath = result.filePaths[0];
              await handleDirectoryOpen(directoryPath, win, cliAvailabilityService);
            }
          },
        },
        {
          label: "Clone Repository…",
          click: (_item, browserWindow) =>
            sendAction("project.cloneRepo", getTargetBrowserWindow(browserWindow)),
        },
        {
          label: "New Window",
          accelerator: rendererMenuAccelerator("app.newWindow"),
          click: (_item, browserWindow) =>
            sendAction("app.newWindow", getTargetBrowserWindow(browserWindow)),
        },
        {
          // No native accelerator: the default binding is the chord
          // Cmd+K Cmd+N, which Electron accelerators can't express. The old
          // hardcoded CommandOrControl+N silently swallowed the renderer's
          // Cmd+N (panel palette) on macOS while Linux/Windows resolved it in
          // the renderer — the same physical key did different things per OS.
          label: "New Worktree…",
          accelerator: rendererMenuAccelerator("worktree.createDialog.open"),
          click: (_item, browserWindow) =>
            sendAction("worktree.createDialog.open", getTargetBrowserWindow(browserWindow)),
        },
        {
          label: "Open Recent",
          submenu: recentProjectsMenu,
        },
        { type: "separator" },
        ...(process.platform !== "darwin"
          ? [
              {
                label: "Settings…",
                accelerator: rendererMenuAccelerator("app.settings"),
                click: (_item: Electron.MenuItem, browserWindow: Electron.BaseWindow | undefined) =>
                  sendAction("app.settings", getTargetBrowserWindow(browserWindow)),
              },
              {
                label: "Plugin Manager…",
                click: (_item: Electron.MenuItem, browserWindow: Electron.BaseWindow | undefined) =>
                  sendAction("app.pluginManager", getTargetBrowserWindow(browserWindow)),
              },
            ]
          : []),
        {
          id: PROJECT_MENU_ITEM_IDS[0],
          label: "Project Settings…",
          enabled: projectMenuEnabled,
          click: (_item, browserWindow) =>
            sendAction("project.settings.open", getTargetBrowserWindow(browserWindow)),
        },
        ...(filePluginItems.length > 0 ? [{ type: "separator" as const }, ...filePluginItems] : []),
        { type: "separator" },
        {
          id: PROJECT_MENU_ITEM_IDS[1],
          label: "Close Project",
          enabled: projectMenuEnabled,
          click: (_item, browserWindow) =>
            sendAction("project.closeActive", getTargetBrowserWindow(browserWindow)),
        },
        {
          label: "Close Window",
          role: "close",
          registerAccelerator: false,
        },
        ...(process.platform !== "darwin"
          ? [{ type: "separator" as const }, { label: "Exit", role: "quit" as const }]
          : []),
      ],
    },
    {
      label: "Edit",
      // registerAccelerator: false (Linux/Windows-only property, no-op on
      // macOS): Ctrl+Z/X/C/V/A are terminal control keys (SIGINT, SIGTSTP,
      // readline editing) — a registered accelerator would fire the menu item
      // whenever xterm leaves the event uncanceled, stealing the key from the
      // PTY. Chromium's native editing handles these keys in inputs without
      // menu help; the items stay clickable and display the accelerator. On
      // macOS the Cmd-based accelerators stay registered — the terminal paste
      // path depends on the native Edit menu roles.
      submenu: [
        {
          label: "Undo",
          accelerator: "CommandOrControl+Z",
          registerAccelerator: false,
          click: () => {
            const focused = webContents.getFocusedWebContents();
            if (focused && !focused.isDestroyed()) focused.undo();
          },
        },
        {
          label: "Redo",
          accelerator: "CommandOrControl+Shift+Z",
          registerAccelerator: false,
          click: () => {
            const focused = webContents.getFocusedWebContents();
            if (focused && !focused.isDestroyed()) focused.redo();
          },
        },
        { type: "separator" },
        {
          label: "Cut",
          accelerator: "CommandOrControl+X",
          registerAccelerator: false,
          click: () => {
            const focused = webContents.getFocusedWebContents();
            if (focused && !focused.isDestroyed()) focused.cut();
          },
        },
        {
          label: "Copy",
          accelerator: "CommandOrControl+C",
          registerAccelerator: false,
          click: () => {
            const focused = webContents.getFocusedWebContents();
            if (focused && !focused.isDestroyed()) focused.copy();
          },
        },
        {
          label: "Paste",
          accelerator: "CommandOrControl+V",
          registerAccelerator: false,
          click: () => {
            const focused = webContents.getFocusedWebContents();
            if (focused && !focused.isDestroyed()) focused.paste();
          },
        },
        {
          label: "Select All",
          accelerator: "CommandOrControl+A",
          registerAccelerator: false,
          click: () => {
            const focused = webContents.getFocusedWebContents();
            if (focused && !focused.isDestroyed()) focused.selectAll();
          },
        },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Sidebar",
          accelerator: rendererMenuAccelerator("nav.toggleSidebar"),
          click: (_item, browserWindow) =>
            sendAction("nav.toggleSidebar", getTargetBrowserWindow(browserWindow)),
        },
        {
          // Default binding is the chord Cmd+K Cmd+F → no native accelerator
          // unless the user rebinds to a single stroke.
          label: "Toggle Focus Mode",
          accelerator: rendererMenuAccelerator("nav.toggleFocusMode"),
          click: (_item, browserWindow) =>
            sendAction("nav.toggleFocusMode", getTargetBrowserWindow(browserWindow)),
        },
        { type: "separator" },
        {
          label: "Reload",
          click: (_item, browserWindow) => {
            const win = getTargetBrowserWindow(browserWindow);
            if (!win) return;
            getAppWebContents(win).reload();
          },
        },
        {
          label: "Force Reload",
          click: (_item, browserWindow) => {
            const win = getTargetBrowserWindow(browserWindow);
            if (!win) return;
            getAppWebContents(win).reloadIgnoringCache();
          },
        },
        ...(app.isPackaged
          ? []
          : [
              {
                label: "Toggle Developer Tools",
                accelerator: "Alt+CommandOrControl+I",
                click: (
                  _item: Electron.MenuItem,
                  browserWindow: Electron.BaseWindow | undefined
                ) => {
                  const win = getTargetBrowserWindow(browserWindow);
                  if (!win) return;
                  const wc = getAppWebContents(win);
                  if (wc.isDevToolsOpened()) {
                    wc.closeDevTools();
                  } else {
                    wc.openDevTools({ mode: "detach" });
                  }
                },
              },
            ]),
        { type: "separator" },
        // Zoom accelerators display the effective window.zoom* bindings but
        // stay natively registered (not renderer-owned): the menu clicks zoom
        // the app shell view while the renderer IPC zooms the sender view —
        // two deliberate implementations, so native registration preserves
        // today's macOS behavior exactly.
        {
          label: "Actual Size",
          accelerator: getMenuAccelerator("window.zoomReset"),
          click: (_item: Electron.MenuItem, browserWindow: Electron.BaseWindow | undefined) => {
            const win = getTargetBrowserWindow(browserWindow);
            if (!win) return;
            getAppWebContents(win).setZoomLevel(0);
          },
        },
        {
          label: "Zoom In",
          accelerator: getMenuAccelerator("window.zoomIn"),
          click: (_item: Electron.MenuItem, browserWindow: Electron.BaseWindow | undefined) => {
            const win = getTargetBrowserWindow(browserWindow);
            if (!win) return;
            const wc = getAppWebContents(win);
            wc.setZoomLevel(wc.getZoomLevel() + 0.5);
          },
        },
        {
          label: "Zoom Out",
          accelerator: getMenuAccelerator("window.zoomOut"),
          click: (_item: Electron.MenuItem, browserWindow: Electron.BaseWindow | undefined) => {
            const win = getTargetBrowserWindow(browserWindow);
            if (!win) return;
            const wc = getAppWebContents(win);
            wc.setZoomLevel(wc.getZoomLevel() - 0.5);
          },
        },
        { type: "separator" },
        {
          label: "Toggle Full Screen",
          accelerator: process.platform === "darwin" ? "Ctrl+Cmd+F" : "F11",
          click: (_item, browserWindow) => {
            const win = getTargetBrowserWindow(browserWindow);
            if (!win) return;
            toggleWindowFullscreen(win);
          },
        },
        ...(viewPluginItems.length > 0 ? [{ type: "separator" as const }, ...viewPluginItems] : []),
      ],
    },
    {
      label: "Terminal",
      submenu: [
        {
          // Renderer-owned so scoped bindings win: the portal binds
          // portal.newTab on the same Cmd+T at higher priority — without
          // per-event suppression the native accelerator would fire
          // terminal.duplicate regardless of portal focus.
          label: "Duplicate Panel",
          accelerator: rendererMenuAccelerator("terminal.duplicate"),
          click: (_item, browserWindow) =>
            sendAction("terminal.duplicate", getTargetBrowserWindow(browserWindow)),
        },
        {
          label: "New Terminal",
          accelerator: rendererMenuAccelerator("terminal.new"),
          click: (_item, browserWindow) =>
            sendAction("terminal.new", getTargetBrowserWindow(browserWindow)),
        },
        ...(agentMenuItems.length > 0
          ? [{ type: "separator" as const }, ...agentMenuItems, { type: "separator" as const }]
          : [{ type: "separator" as const }]),
        ...(terminalPluginItems.length > 0
          ? [...terminalPluginItems, { type: "separator" as const }]
          : []),
        {
          label: "Quick Switcher…",
          accelerator: rendererMenuAccelerator("nav.quickSwitcher"),
          click: (_item, browserWindow) =>
            sendAction("nav.quickSwitcher", getTargetBrowserWindow(browserWindow)),
        },
        {
          label: "Command Palette…",
          accelerator: rendererMenuAccelerator("action.palette.open"),
          click: (_item, browserWindow) =>
            sendAction("action.palette.open", getTargetBrowserWindow(browserWindow)),
        },
        { type: "separator" },
        {
          label: `Install ${PRODUCT_NAME} Command Line Tool`,
          enabled: process.platform === "darwin" || process.platform === "linux",
          click: async (_item, browserWindow) => {
            const targetWin = getTargetBrowserWindow(browserWindow);
            try {
              const status = await CliInstallService.install();
              if (targetWin && !targetWin.isDestroyed()) {
                const wc = getAppWebContents(targetWin);
                if (!wc.isDestroyed()) {
                  wc.send(CHANNELS.NOTIFICATION_SHOW_TOAST, {
                    type: "success",
                    title: "CLI installed",
                    message: `The \`daintree\` command is now available at ${status.path}`,
                  });
                }
              }
              createApplicationMenu(mainWindow, cliAvailabilityService);
            } catch (err) {
              const message = formatErrorMessage(err, "Failed to install CLI");
              if (targetWin && !targetWin.isDestroyed()) {
                const wc = getAppWebContents(targetWin);
                if (!wc.isDestroyed()) {
                  wc.send(CHANNELS.NOTIFICATION_SHOW_TOAST, {
                    type: "error",
                    title: "CLI installation failed",
                    message,
                  });
                }
              }
            }
          },
        },
        {
          label: `Install "Open in ${PRODUCT_NAME}" Quick Action`,
          enabled: process.platform === "darwin",
          click: async (_item, browserWindow) => {
            const targetWin = getTargetBrowserWindow(browserWindow);
            try {
              const installPath = await FinderQuickActionService.install();
              if (targetWin && !targetWin.isDestroyed()) {
                const wc = getAppWebContents(targetWin);
                if (!wc.isDestroyed()) {
                  wc.send(CHANNELS.NOTIFICATION_SHOW_TOAST, {
                    type: "success",
                    title: "Quick Action installed",
                    message: `Right-click a folder in Finder and choose "Open in ${PRODUCT_NAME}". Installed at ${installPath}`,
                  });
                }
              }
            } catch (err) {
              const message = formatErrorMessage(err, "Failed to install Quick Action");
              if (targetWin && !targetWin.isDestroyed()) {
                const wc = getAppWebContents(targetWin);
                if (!wc.isDestroyed()) {
                  wc.send(CHANNELS.NOTIFICATION_SHOW_TOAST, {
                    type: "error",
                    title: "Quick Action installation failed",
                    message,
                  });
                }
              }
            }
          },
        },
      ],
    },
    {
      label: "Window",
      submenu:
        process.platform === "darwin"
          ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
          : [{ role: "minimize" }, { role: "close" }],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Getting Started",
          click: (_item, browserWindow) =>
            sendAction("help.gettingStarted.show", getTargetBrowserWindow(browserWindow)),
        },
        {
          // The searchable shortcut reference was previously reachable only
          // via combos you'd already have to know (Cmd+/ or Cmd+K Cmd+S) or
          // the command palette — the Help menu is where new users look.
          label: "Keyboard Shortcuts",
          accelerator: rendererMenuAccelerator("help.shortcutsAlt"),
          click: (_item, browserWindow) =>
            sendAction("help.shortcutsAlt", getTargetBrowserWindow(browserWindow)),
        },
        { type: "separator" },
        {
          label: "Launch Help Agent",
          accelerator: rendererMenuAccelerator("help.launchAgent"),
          click: (_item, browserWindow) =>
            sendAction("help.launchAgent", getTargetBrowserWindow(browserWindow)),
        },
        { type: "separator" },
        {
          label: "Reload Configuration",
          click: (_item, browserWindow) =>
            sendAction("app.reloadConfig", getTargetBrowserWindow(browserWindow)),
        },
        { type: "separator" },
        {
          label: "Learn More",
          click: async () => {
            await openExternalUrl("https://github.com/daintreehq/daintree");
          },
        },
        ...(process.platform !== "darwin" && app.isPackaged && !isWindowsStoreBuild()
          ? [
              { type: "separator" as const },
              {
                id: "check-for-updates-help",
                label: "Check for Updates…",
                click: handleUpdateMenuClick,
              },
            ]
          : []),
        ...(helpPluginItems.length > 0 ? [{ type: "separator" as const }, ...helpPluginItems] : []),
        ...(process.platform !== "darwin"
          ? [{ type: "separator" as const }, { role: "about" as const }]
          : []),
      ],
    },
  ];

  if (process.platform === "darwin") {
    template.unshift({
      label: "Daintree",
      submenu: [
        { role: "about" },
        ...(app.isPackaged
          ? [
              {
                id: "check-for-updates-mac",
                label: "Check for Updates…",
                click: handleUpdateMenuClick,
              },
            ]
          : []),
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: rendererMenuAccelerator("app.settings"),
          click: (_item, browserWindow) =>
            sendAction("app.settings", getTargetBrowserWindow(browserWindow)),
        },
        {
          label: "Plugin Manager…",
          click: (_item, browserWindow) =>
            sendAction("app.pluginManager", getTargetBrowserWindow(browserWindow)),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  wireUpdateMenuState();
}

// Wire the update-state listener against the deferred-loaded singleton. A
// no-op until the auto-updater deferred task sets the serviceRef — that task
// calls this directly so the first wiring happens when the service loads,
// keeping electron-updater off the menu-build path. Rebuilds after that find
// the ref set and apply the current state synchronously, so a rebuild that
// completes mid-check (or with a downloaded update already staged) doesn't
// snap items back to the default "Check for Updates…" label.
export function wireUpdateMenuState(): void {
  const svc = getAutoUpdaterServiceRef();
  if (svc) {
    unsubscribeUpdateMenuState?.();
    unsubscribeUpdateMenuState = svc.onMenuStateChange(applyUpdateMenuState);
    applyUpdateMenuState(svc.getMenuState());
  }
}

function buildRecentProjectsMenu(
  getTarget: (browserWindow: Electron.BaseWindow | undefined) => BrowserWindow | null,
  cliAvailabilityService?: CliAvailabilityService
): Electron.MenuItemConstructorOptions[] {
  const projects = projectStore.getAllProjects();

  if (projects.length === 0) {
    return [{ label: "No Recent Projects", enabled: false }];
  }

  const sortedProjects = [...projects].sort((a, b) => b.lastOpened - a.lastOpened);

  const menuItems: Electron.MenuItemConstructorOptions[] = sortedProjects.map((project) => ({
    label: `${project.emoji || "📁"} ${project.name} - ${project.path}`,
    click: async (_item: Electron.MenuItem, browserWindow: Electron.BaseWindow | undefined) => {
      const targetWindow = getTarget(browserWindow);
      if (!targetWindow) return;
      await handleDirectoryOpen(project.path, targetWindow, cliAvailabilityService);
    },
  }));

  return menuItems;
}

export async function handleDirectoryOpen(
  directoryPath: string,
  targetWindow: BrowserWindow,
  cliAvailabilityService?: CliAvailabilityService
): Promise<void> {
  if (targetWindow.isDestroyed()) return;

  try {
    const project = await projectStore.addProject(directoryPath);

    // Use the target window's own ProjectViewManager for multi-view switching
    // when available. The process-global manager points at the last-created
    // window, so opening a directory from an older window's menu would switch
    // the wrong window's view (#11100).
    const pvm = getWindowRegistry()?.getByWindowId(targetWindow.id)?.services.projectViewManager;
    if (pvm) {
      const { view, isNew } = await pvm.switchTo(project.id, project.path);
      // Capture the outgoing project id before the pointer flips so we can
      // broadcast its bumped `lastOpened` to every cached view (#8561).
      const previousProjectId = projectStore.getCurrentProjectId();
      await projectStore.setCurrentProject(project.id);
      // Mirror the IPC switch path: fan out `project:updated` for both
      // departing and activated rows so cached views' MRU timestamps stay
      // fresh; otherwise the next `Cmd+Alt+=` targets the wrong project.
      broadcastProjectSwitchUpdates(previousProjectId, project.id);

      // Notify the activated view of the switch so it refreshes its cache, MRU,
      // and polling, mirroring activateProjectView. Targeted send to the
      // activated view only (LRU-cached other-project views must not be marked
      // switched).
      if (!view.webContents.isDestroyed()) {
        view.webContents.send(CHANNELS.PROJECT_ON_SWITCH, {
          project: projectStore.getProjectById(project.id) ?? project,
          switchId: randomUUID(),
        });
      }

      // Re-attach producer ports for cached-view reactivation. The IPC switch
      // handler (projectCrud/switch.ts:activateProjectView) does this in the
      // primary path; the menu path must mirror it because cached views have
      // their worktree port + workspace direct port closed on cache to avoid
      // freeze accumulation (#6273), and the PTY MessagePort is per-window
      // and was replaced when the user last switched away.
      if (!view.webContents.isDestroyed()) {
        const wsClient = getWorkspaceClientRef();
        const broker = getWorktreePortBrokerRef();
        if (wsClient) {
          try {
            await wsClient.loadProject(project.path, targetWindow.id);
            wsClient.attachDirectPort(targetWindow.id, view.webContents);
            const host = wsClient.getHostForProject(project.path);
            if (host && broker) {
              broker.brokerPort(host, view.webContents);
            }
          } catch (err) {
            console.error("[menu] Failed to restore worktree ports:", err);
          }
        }

        // Distribute fresh PTY MessagePort + notify pty-host of project switch
        const ptyClient = getPtyClient();
        if (ptyClient) {
          ptyClient.onProjectSwitch(targetWindow.id, project.id, project.path);
        }
        const ctx = getWindowRegistry()?.getByWindowId(targetWindow.id);
        if (!isNew && ctx) {
          distributePortsToView(targetWindow, ctx, view.webContents, ptyClient ?? null);
        }
      }
    } else {
      // Fallback: legacy single-view switch
      const registry = getWindowRegistry();
      const wCtx = registry?.getByWindowId(targetWindow.id);
      const switchService = wCtx?.services.projectSwitchService;
      if (!switchService) {
        console.error("[menu] ProjectSwitchService not available yet, cannot switch project");
        return;
      }
      await switchService.switchProject(project.id);
    }

    createApplicationMenu(targetWindow, cliAvailabilityService);
  } catch (error) {
    // A folder that isn't a repository yet is a guided-setup opportunity, not an
    // error: hand it to the renderer's existing GitInitDialog so the user can
    // confirm initializing it. Keyed to the structured AppError code rather than
    // message text — `addProject` is called in-process here, so the thrown
    // AppError instance survives intact (no structured-clone boundary). Covers
    // Dock drop, Cmd+O, and Recent Projects alike, since all three land here.
    if (isAppError(error) && error.code === "NOT_A_GIT_REPO") {
      if (targetWindow.isDestroyed()) return;

      const rendererTarget = getAppWebContents(targetWindow);
      const sendOpenGitInitDialog = (): void => {
        if (rendererTarget.isDestroyed()) return;
        rendererTarget.send(CHANNELS.PROJECT_OPEN_GIT_INIT_DIALOG, { directoryPath });
      };

      // A send before `did-finish-load` is dropped with no queue, which is the
      // cold-launch Dock-drop case (the folder opens while the window is still
      // loading). Gate on `isLoadingMainFrame()`, not `isLoading()`: the latter
      // is true while *any* frame is loading (an HTML preview iframe, say), but
      // `did-finish-load` only fires for the main frame — so a bare `isLoading()`
      // could park the send on an event that never arrives. Read it here rather
      // than before the await above, so a load that finished while `addProject`
      // was running isn't waited on forever.
      if (rendererTarget.isLoadingMainFrame()) {
        rendererTarget.once("did-finish-load", sendOpenGitInitDialog);
      } else {
        sendOpenGitInitDialog();
      }
      return;
    }

    // Logged only after the guided path declines the error — a folder that just
    // needs initializing is an expected user choice, not a failure.
    console.error("Failed to open project:", error);

    let errorMessage = "An unknown error occurred";
    if (error instanceof Error) {
      if (error.message.includes("Not a git repository")) {
        errorMessage = "The selected directory is not a Git repository.";
      } else if (error.message.includes("ENOENT")) {
        errorMessage = "The selected directory does not exist.";
      } else if (error.message.includes("EACCES")) {
        errorMessage = "Permission denied. You don't have access to this directory.";
      } else {
        errorMessage = error.message;
      }
    }

    dialog
      .showMessageBox(targetWindow, {
        type: "error",
        title: "Failed to Open Project",
        message: errorMessage,
        buttons: ["OK"],
      })
      .catch(console.error);
  }
}
