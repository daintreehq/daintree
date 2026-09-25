import os from "node:os";
import { app, safeStorage } from "electron";
import { CHANNELS } from "../../ipc/channels.js";
import { safeStorageCipher } from "../../services/plugin/secretCipher.js";
import { store } from "../../store.js";
import { getAllAppWebContents } from "../../window/webContentsRegistry.js";
import type { HostModeEvent, HostModeStatus } from "../../../shared/types/ipc/hostMode.js";
import { getLocalHandshakeInfo } from "../handshakeInfo.js";
import { HostAdvertiser } from "./advertise.js";
import { runCommand, spawnOwnedProcess } from "./hostCommands.js";
import { hostLocation, startHostListener } from "./hostListener.js";
import { HostModeService, type HostModeSettings } from "./HostModeService.js";
import type { HostSocketLocation } from "./hostSocketPath.js";
import {
  createLaunchAgentController,
  createSystemdUserController,
  type HostLaunchTarget,
  type StartAtLoginController,
} from "./startAtLogin.js";

const BUNDLE_ID = "org.daintree.app";

function readSettings(): HostModeSettings {
  const stored = store.get("hostMode");
  return { enabled: stored?.enabled === true, startAtLogin: stored?.startAtLogin === true };
}

function launchTarget(): HostLaunchTarget {
  return {
    // An AppImage's execPath is inside its temporary mount; the unit must run the image.
    executable: process.env.APPIMAGE || process.execPath,
    // `electron .` in dev: the binary needs the app directory to know what to run.
    appPath: process.defaultApp ? app.getAppPath() : null,
  };
}

function startAtLoginController(): StartAtLoginController | null {
  const homeDir = os.homedir();
  if (process.platform === "darwin") {
    return createLaunchAgentController({
      homeDir,
      packaged: app.isPackaged,
      bundleId: BUNDLE_ID,
      target: launchTarget(),
    });
  }
  if (process.platform === "linux") {
    return createSystemdUserController({
      homeDir,
      packaged: app.isPackaged,
      userName: os.userInfo().username,
      target: launchTarget(),
      run: runCommand,
    });
  }
  return null;
}

/** Host mode status belongs to this machine's own windows, never to a remote Shell. */
function broadcastLocal(status: HostModeStatus): void {
  const event: HostModeEvent = { type: "status-changed", status };
  for (const wc of getAllAppWebContents()) {
    if (wc.isDestroyed()) continue;
    try {
      wc.send(CHANNELS.HOST_MODE_EVENT, event);
    } catch {
      // A view mid-teardown.
    }
  }
}

export function createHostModeService(
  options: { location?: HostSocketLocation } = {}
): HostModeService {
  const { location } = options;
  let socketPath: string | null = null;
  try {
    socketPath = (location ?? hostLocation()).socketPath;
  } catch {
    // Reported through the listener's own error when it tries to start.
  }
  return new HostModeService({
    platform: process.platform,
    readSettings,
    writeSettings: (next) => store.set("hostMode", next),
    socketPath,
    startListener: (signal) => startHostListener({ signal, location }),
    startAtLogin: startAtLoginController(),
    createAdvertiser: (onChange) =>
      new HostAdvertiser({
        platform: process.platform,
        hostName: os.hostname(),
        handshake: getLocalHandshakeInfo(),
        spawn: spawnOwnedProcess,
        onChange,
      }),
    keychain: {
      secretTier: () => safeStorageCipher.tier(),
      getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend(),
      isAsyncEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
      encryptStringAsync: (text) => safeStorage.encryptStringAsync(text),
      decryptStringAsync: (encrypted) => safeStorage.decryptStringAsync(encrypted),
    },
    run: runCommand,
    broadcast: broadcastLocal,
  });
}
